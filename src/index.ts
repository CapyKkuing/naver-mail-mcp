import { oauthProvider } from './auth';
import { isAllowedUser } from './config';
import { naverAccount } from './mail/imap';
import { NaverMailMcp } from './mcp';
import type { Env, Props } from './types';

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
    // /mcp, /authorize, /oauth/*, /.well-known/*: OAuth
    return oauthProvider(env, mcp).fetch(req, env, ctx);
  },
};
