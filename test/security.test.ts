import { describe, expect, it, vi } from 'vitest';
import { oauthProvider } from '../src/auth';
import { buildMessage } from '../src/mail/mime';
import { htmlToText } from '../src/mail/parse';
import { bindSessionToUser } from '../src/session';
import type { Env, Props } from '../src/types';

const alice = { login: 'alice', email: 'alice@naver.com', password: 'pw-a' } as Props;
const bob = { login: 'bob', email: 'bob@naver.com', password: 'pw-b' } as Props;
const ctxOf = (props: Props) => ({ props, waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

/** McpAgent.serve 흉내: 받은 mcp-session-id로 Durable Object(`streamable-http:<ID>`)를 고르고, 처음 연 사람의 계정을 기억한다 */
function fakeMcp() {
  const owners = new Map<string, string>();
  const names: string[] = [];
  const namespace = {
    newUniqueId: () => ({ toString: () => 'f'.repeat(64) }),
    idFromName: (name: string) => (names.push(name), name),
    idFromString: (id: string) => id,
    get: (id: string) => id,
    getByName: (name: string) => name,
    jurisdiction() {
      return namespace;
    },
  } as unknown as DurableObjectNamespace;
  const handler = {
    async fetch(req: Request, env: { MCP_OBJECT: DurableObjectNamespace }, ctx: ExecutionContext) {
      const owner = (ctx as unknown as { props: Props }).props.email;
      const body = (await req.json()) as { method: string };
      const sid = req.headers.get('mcp-session-id') ?? env.MCP_OBJECT.newUniqueId().toString();
      const object = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName(`streamable-http:${sid}`)) as unknown as string;
      if (body.method === 'initialize') owners.set(object, owner);
      else if (!owners.has(object)) return new Response('Session not found', { status: 404 });
      return new Response(JSON.stringify({ account: owners.get(object) }), { headers: { 'mcp-session-id': sid } });
    },
  };
  return { handler, env: { MCP_OBJECT: namespace }, names };
}

const rpc = (method: string, sessionId?: string) =>
  new Request('https://x.workers.dev/mcp', {
    method: 'POST',
    headers: sessionId ? { 'mcp-session-id': sessionId } : {},
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  });

describe('세션은 로그인한 계정에 묶인다 (R1)', () => {
  it('남의 세션 ID를 알아도 내 토큰으로는 그 세션(남의 메일함)에 닿지 않는다', async () => {
    const { handler, env, names } = fakeMcp();
    const mcp = bindSessionToUser(handler);

    const init = await mcp.fetch(rpc('initialize'), env, ctxOf(alice));
    const sid = init.headers.get('mcp-session-id')!;
    expect(sid).toBe('f'.repeat(64)); // 클라이언트가 보는 세션 ID는 라이브러리가 만든 그대로

    expect(await (await mcp.fetch(rpc('tools/call', sid), env, ctxOf(alice))).json()).toEqual({ account: 'alice@naver.com' });
    expect((await mcp.fetch(rpc('tools/call', sid), env, ctxOf(bob))).status).toBe(404);

    // 남의 세션 ID로 initialize를 다시 보내도 bob의 별도 세션이 생길 뿐, alice의 세션은 그대로다
    expect(await (await mcp.fetch(rpc('initialize', sid), env, ctxOf(bob))).json()).toEqual({ account: 'bob@naver.com' });
    expect(await (await mcp.fetch(rpc('tools/call', sid), env, ctxOf(alice))).json()).toEqual({ account: 'alice@naver.com' });

    // McpAgent는 이름을 ':'로 나눠 앞 두 조각(전송 방식, 세션 ID)만 읽는다
    for (const n of names) expect(n.split(':').slice(0, 2)).toEqual(['streamable-http', sid]);
    expect(new Set(names.map((n) => n.split(':')[2])).size).toBe(2);
  });

  it('로그인 정보가 없는 요청은 세션에 닿기 전에 거부한다', async () => {
    const { handler, env } = fakeMcp();
    const res = await bindSessionToUser(handler).fetch(rpc('initialize'), env, { waitUntil() {} } as unknown as ExecutionContext);
    expect(res.status).toBe(401);
  });
});

describe('로그인 횟수 제한을 피하는 주소 (R2)', () => {
  it('/authorize가 아닌 주소로 보낸 로그인은 네이버 로그인 확인까지 가지 않는다', async () => {
    const verify = vi.fn(async () => undefined);
    const env = { OAUTH_KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) } } as unknown as Env;
    const provider = oauthProvider(env, { fetch: async () => new Response('api') }, verify, 'https://r2-test.workers.dev');
    for (const path of ['/authorize/', '/unrelated-path']) {
      const form = new URLSearchParams({ handle: 'x', decision: 'approve', user: 'victim', password: 'guess' });
      const res = await provider.fetch(
        new Request(`https://r2-test.workers.dev${path}`, { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
        env,
        ctxOf(alice),
      );
      expect(res.status).toBe(404);
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('/authorize라도 정상 연결 요청이 아니면 네이버 로그인 확인 전에 거부한다', async () => {
    const verify = vi.fn(async () => undefined);
    const env = { OAUTH_KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) } } as unknown as Env;
    const provider = oauthProvider(env, { fetch: async () => new Response('api') }, verify, 'https://r2-test2.workers.dev');
    const form = new URLSearchParams({ handle: 'x', decision: 'approve', user: 'victim', password: 'guess' });
    const res = await provider.fetch(
      new Request('https://r2-test2.workers.dev/authorize', { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
      env,
      ctxOf(alice),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('메일 내용 처리', () => {
  it('범위를 넘는 HTML 숫자 문자는 오류 대신 대체 문자로 읽는다 (R4)', () => {
    expect(htmlToText('<p>a&#1114112;b&#x110000;c&#65;</p>')).toBe('a�b�cA');
  });

  it('줄바꿈이 섞인 받는 주소는 보내지 않는다 (SMTP)', () => {
    const from = { address: 'me@naver.com' };
    expect(() => buildMessage({ from, to: [{ address: 'a@b.com\r\nRCPT TO:<x@evil.com>' }] })).toThrow(/메일 주소 형식/);
    expect(() => buildMessage({ from, bcc: [{ address: 'a@b.com>\r\nDATA' }] })).toThrow(/메일 주소 형식/);
  });

  it('보내는 사람 이름의 줄바꿈은 공백으로 바꿔 머리말이 깨지지 않게 한다', () => {
    const { raw } = buildMessage({ from: { name: 'Me\r\nBcc: x@evil.com', address: 'me@naver.com' }, to: [{ address: 'a@b.com' }], text: 'hi' });
    const head = raw.split('\r\n\r\n')[0]!;
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toMatch(/^From: "Me Bcc: x@evil.com" <me@naver.com>$/m);
  });
});
