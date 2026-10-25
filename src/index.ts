import { oauthProvider } from './auth';
import { ensureClient } from './clients';
import { isAllowedUser } from './config';
import { naverAccount } from './mail/imap';
import { NaverMailMcp } from './mcp';
import type { Env, Props, RateLimiter } from './types';

export { NaverMailMcp };

const mcp = NaverMailMcp.serve('/mcp');

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

/** Authorization: Bearer <MCP_BEARER_TOKEN>. 토큰이 설정되지 않았으면 언제나 거짓 */
export async function isBearerAuthorized(req: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const got = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1]?.trim();
  if (!got) return false;
  const [a, b] = await Promise.all([sha256(got), sha256(token)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** 바인딩이 없으면(로컬 테스트 등) 제한하지 않는다 */
async function allowed(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  return (await limiter.limit({ key })).success;
}

const tooMany = (message: string) => new Response(message, { status: 429, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' } });

/** 고정 토큰 모드: 시크릿에 넣어 둔 소유자 계정으로 MCP 세션을 연다 */
function withProps(ctx: ExecutionContext, props: Props): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
    passThroughOnException: () => ctx.passThroughOnException(),
    props,
  } as unknown as ExecutionContext;
}

const HOME = `naver-mail-mcp: 네이버 메일을 Gmail MCP와 같은 도구로 쓰는 원격 MCP 서버입니다.
MCP 주소: /mcp (Streamable HTTP, OAuth 로그인)
Claude·Grok·Muse·ChatGPT 등에서 "커스텀 커넥터"에 이 서버의 /mcp 주소를 넣으면 네이버 아이디와 애플리케이션 비밀번호로 연결합니다.`;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(HOME, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (url.pathname.startsWith('/mcp') && (await isBearerAuthorized(req, env.MCP_BEARER_TOKEN))) {
      if (!env.NAVER_ID || !env.NAVER_APP_PASSWORD) return new Response('고정 토큰 모드에는 NAVER_ID와 NAVER_APP_PASSWORD 시크릿이 필요합니다', { status: 500 });
      const account = naverAccount(env.NAVER_ID, env.NAVER_APP_PASSWORD, env.NAVER_DISPLAY_NAME);
      if (!isAllowedUser(env.ALLOWED_USERS, account.login)) return new Response('Forbidden', { status: 403 });
      return mcp.fetch(req, env, withProps(ctx, { ...account }));
    }
    // 요청 횟수 제한: 로그인 시도는 네이버에 실제 로그인해 보므로(무차별 대입에 이용될 수 있음), 등록은 KV 쓰기를 쓰므로
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    if (url.pathname === '/authorize' && req.method === 'POST') {
      if (!(await allowed(env.LOGIN_LIMITER, ip))) return tooMany('로그인 시도가 너무 많습니다. 1분 뒤에 다시 시도하세요.');
      if (!(await allowed(env.GLOBAL_LOGIN_LIMITER, 'global'))) return tooMany('지금 로그인 요청이 몰려 있습니다. 1분 뒤에 다시 시도하세요.');
    }
    if (((url.pathname === '/authorize' && req.method === 'GET') || url.pathname === '/oauth/register') && !(await allowed(env.REGISTER_LIMITER, ip))) {
      return tooMany('요청이 너무 많습니다. 1분 뒤에 다시 시도하세요.');
    }
    // Client ID를 사람이 직접 넣는 에이전트(Muse 등)용: 모르는 client_id는 그 자리에서 등록한다
    if (url.pathname === '/authorize' && req.method === 'GET') await ensureClient(env.OAUTH_KV, url);
    // /mcp, /authorize, /oauth/*, /.well-known/*: OAuth
    return oauthProvider(env, mcp, undefined, url.origin).fetch(req, env, ctx);
  },
};
