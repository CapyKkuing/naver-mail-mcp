import { AuthorizationError, CimdFetchError, OAuthProvider, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { isAllowedUser, mailConfig } from './config';
import { naverAccount, withClient } from './mail/imap';
import type { Env, Props } from './types';

/**
 * 커스텀 커넥터(Claude·Grok·Muse·ChatGPT 등)용 OAuth 2.1. DCR·CIMD·PKCE는 라이브러리가 처리한다.
 * 로그인 화면에서 네이버 아이디와 애플리케이션 비밀번호를 받아 IMAP 로그인으로 확인하고,
 * 그 계정 정보를 토큰의 props(라이브러리가 토큰으로 암호화해 저장)에 담는다.
 */
export const SCOPE = 'mail';

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function loginPage(d: ConsentDescription, handle: string, error?: string, user = ''): string {
  const origin = d.clientDomain ? `게시자: <strong>${escape(d.clientDomain)}</strong>` : '스스로 등록한 앱이라 게시자는 확인되지 않았습니다.';
  return `<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>네이버 메일 연결</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--muted:#666;--bg:#fff;--box:#f4f6f5;--accent:#03c75a;--err:#c0262d}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#aaa;--bg:#141414;--box:#222;--err:#ff6b6b}}
body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:var(--bg);color:var(--fg);max-width:30rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
h1{font-size:1.3rem}label{display:block;margin:.8rem 0 .2rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #8884;border-radius:6px;background:var(--bg);color:var(--fg)}
button{padding:.6rem 1.1rem;font-size:1rem;border-radius:6px;border:0;cursor:pointer}
.ok{background:var(--accent);color:#fff}.no{background:var(--box);color:var(--fg)}
.box{background:var(--box);padding:.8rem 1rem;border-radius:8px;font-size:.92rem}.muted{color:var(--muted);font-size:.9rem}.err{color:var(--err)}
</style>
<body>
<h1>${escape(d.clientName)}에 네이버 메일을 연결할까요?</h1>
<p class="muted">${origin}<br>권한이 전달될 곳: <strong>${escape(d.redirectHost)}</strong></p>
${d.redirectIsLoopback ? '<p><strong>내 컴퓨터의 앱으로 권한이 전달됩니다.</strong> 방금 직접 연결을 시작한 경우에만 허용하세요.</p>' : ''}
<div class="box">
<strong>처음이라면 먼저 준비하세요</strong>
<ol style="margin:.4rem 0 0;padding-left:1.2rem">
<li>네이버 메일 → 환경설정 → <b>POP3/IMAP 설정</b>에서 <b>IMAP/SMTP 사용</b>을 켭니다.</li>
<li>네이버 2단계 인증을 쓰면 네이버 ID → 보안설정에서 <b>애플리케이션 비밀번호</b>를 만들어 아래에 넣습니다. (평소 로그인 비밀번호는 거부됩니다)</li>
</ol>
</div>
${error ? `<p class="err">${escape(error)}</p>` : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="u">네이버 아이디</label>
  <input id="u" name="user" value="${escape(user)}" autocomplete="username" placeholder="myid 또는 myid@naver.com" required>
  <label for="p">애플리케이션 비밀번호</label>
  <input id="p" type="password" name="password" autocomplete="current-password" required>
  <label for="n">보내는 사람 이름 <span class="muted">(선택)</span></label>
  <input id="n" name="displayName" placeholder="예: 홍길동">
  <p class="muted">비밀번호는 이 서버에 평문으로 남지 않고, 연결된 앱의 토큰으로 암호화되어 메일을 읽고 보낼 때만 쓰입니다. 연결을 끊으려면 네이버에서 애플리케이션 비밀번호를 삭제하세요.</p>
  <p><button class="ok" name="decision" value="approve">연결</button> <button class="no" name="decision" value="deny" formnovalidate>거부</button></p>
</form></body></html>`;
}

const html = (body: string, headers: Headers, status = 200) => {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers });
};

/** 네이버 IMAP에 실제로 로그인해 본다 */
export type Verifier = (env: Env, props: Props) => Promise<void>;
const verifyImap: Verifier = (env, props) => withClient(props, mailConfig(env), async () => undefined);

async function authorize(req: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }, verify: Verifier): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === 'GET') {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      return html(loginPage(details, consent.handle), consent.headers);
    }
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const form = await req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const user = String(form.get('user') ?? '').trim();
    const account = naverAccount(user, String(form.get('password') ?? ''), String(form.get('displayName') ?? ''));
    const retry = async (message: string, status: number) => {
      // 핸들은 승인·거부 전까지 유효하니 같은 핸들로 다시 보여 준다
      const request = await oauth.parseAuthRequest(req).catch(() => undefined);
      const details: ConsentDescription = request ? await oauth.describeConsent(request) : ({ clientName: '이 앱', redirectHost: '', redirectIsLoopback: false } as unknown as ConsentDescription);
      return html(loginPage(details, handle, message, user), new Headers(), status);
    };
    if (!account.login || !account.password) return retry('아이디와 비밀번호를 모두 넣으세요.', 400);
    if (!isAllowedUser(env.ALLOWED_USERS, account.login)) return retry('이 서버는 허용된 네이버 아이디만 연결할 수 있습니다.', 403);
    const props: Props = { ...account };
    try {
      await verify(env, props);
    } catch (e) {
      return retry((e as Error).message, 401);
    }
    const approved = await oauth.approveConsent(req, handle, { scope: [SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: account.email,
      metadata: { email: account.email },
      scope: approved.request.scope,
      props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : '이 앱을 확인할 수 없습니다.';
      return new Response(message, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    throw error;
  }
}

const providers = new Map<string, OAuthProvider<Env>>();

/** PUBLIC_URL(배포 주소)마다 하나. 로컬은 http://localhost:8787 */
export function oauthProvider(
  env: Env,
  apiHandler: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> },
  verify: Verifier = verifyImap,
): OAuthProvider<Env> {
  const base = (env.PUBLIC_URL || 'http://localhost:8787').replace(/\/$/, '');
  let p = providers.get(base);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: apiHandler as never,
      defaultHandler: { fetch: (req: Request, e: Env) => authorize(req, e as Env & { OAUTH_PROVIDER: OAuthHelpers }, verify) } as never,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE, 'offline_access'],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
    });
    providers.set(base, p);
  }
  return p;
}
