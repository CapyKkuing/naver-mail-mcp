/**
 * 처음 보는 client_id 자동 등록.
 * Meta Muse처럼 OAuth Client ID를 사람이 직접 넣게 하는 에이전트가 있다. 사용자가 무엇을 넣든
 * (비워 두든, 네이버 아이디를 넣든) 연결되도록, 모르는 client_id로 /authorize에 오면
 * 그 id와 redirect_uri로 공개 클라이언트(PKCE, 비밀값 없음)를 만든다.
 * 누구나 등록할 수 있는 동적 등록(DCR)과 보안 수준이 같고, 로그인 화면에 권한이 갈 곳이 표시된다.
 */

interface ClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  grantTypes: string[];
  responseTypes: string[];
  registrationDate: number;
  tokenEndpointAuthMethod: string;
  authMethodExplicit?: boolean;
  /** 이 서버가 자동으로 만든 클라이언트 (redirect_uri를 덧붙일 수 있음) */
  autoRegistered?: boolean;
}

type Kv = Pick<KVNamespace, 'get' | 'put'>;

const KNOWN_AGENTS: Array<[RegExp, string]> = [
  [/(^|\.)meta\.ai$/, 'Meta Muse'],
  [/(^|\.)claude\.(ai|com)$/, 'Claude'],
  [/(^|\.)(grok\.com|x\.ai)$/, 'Grok'],
  [/(^|\.)(chatgpt\.com|openai\.com)$/, 'ChatGPT'],
];

export function agentName(redirectUri: string): string {
  const host = new URL(redirectUri).hostname;
  return KNOWN_AGENTS.find(([re]) => re.test(host))?.[1] ?? host;
}

/** https, 또는 내 컴퓨터(loopback)로 돌아오는 http만 받는다 */
export function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** client_id가 https 주소면 CIMD(주소형 클라이언트, Claude 등)라 라이브러리가 처리한다 */
const isCimd = (id: string) => {
  try {
    const u = new URL(id);
    return u.protocol === 'https:' && u.pathname !== '/' && u.pathname !== '';
  } catch {
    return false;
  }
};

export async function ensureClient(kv: Kv, url: URL, now = Date.now()): Promise<'created' | 'updated' | 'skipped'> {
  const clientId = url.searchParams.get('client_id')?.trim();
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  if (!clientId || clientId.length > 200 || isCimd(clientId) || !acceptableRedirect(redirectUri)) return 'skipped';
  const key = `client:${clientId}`;
  const existing = await kv.get<ClientRecord>(key, { type: 'json' });
  if (existing) {
    if (!existing.autoRegistered || existing.redirectUris.includes(redirectUri)) return 'skipped';
    if (existing.redirectUris.length >= 10) return 'skipped';
    await kv.put(key, JSON.stringify({ ...existing, redirectUris: [...existing.redirectUris, redirectUri] }));
    return 'updated';
  }
  const record: ClientRecord = {
    clientId,
    redirectUris: [redirectUri],
    clientName: agentName(redirectUri),
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    registrationDate: Math.floor(now / 1000),
    tokenEndpointAuthMethod: 'none',
    authMethodExplicit: true,
    autoRegistered: true,
  };
  await kv.put(key, JSON.stringify(record));
  return 'created';
}
