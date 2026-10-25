import { describe, expect, it } from 'vitest';
import { agentName, ensureClient, isKnownAgentHost } from '../src/clients';

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      const v = store.get(key);
      return v ? JSON.parse(v) : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as never as KVNamespace & { store: Map<string, string> };
}

const authorize = (q: Record<string, string>) => new URL(`https://x.workers.dev/authorize?${new URLSearchParams(q)}`);
const MUSE = 'https://agent.meta.ai/api/hatch/oauth/callback';

describe('처음 보는 client_id 자동 등록', () => {
  it('사람이 넣은 아무 Client ID든 공개 클라이언트로 등록한다', async () => {
    const kv = fakeKv();
    expect(await ensureClient(kv, authorize({ client_id: 'myid@naver.com', redirect_uri: MUSE }), 0)).toBe('created');
    const rec = JSON.parse(kv.store.get('client:myid@naver.com')!);
    expect(rec).toMatchObject({ clientId: 'myid@naver.com', redirectUris: [MUSE], clientName: 'Meta Muse', tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'] });
    expect(await ensureClient(kv, authorize({ client_id: 'myid@naver.com', redirect_uri: MUSE }))).toBe('skipped');
  });

  it('자동 등록한 클라이언트에는 같은 호스트의 redirect_uri만 덧붙이고, 정식 등록 클라이언트는 건드리지 않는다', async () => {
    const kv = fakeKv();
    await ensureClient(kv, authorize({ client_id: 'a', redirect_uri: MUSE }));
    expect(await ensureClient(kv, authorize({ client_id: 'a', redirect_uri: 'https://agent.meta.ai/api/hatch/oauth/callback2' }))).toBe('updated');
    // 다른 호스트는 거부: 남의 Client ID에 내 주소를 붙여 토큰을 가로채는 길을 막는다
    expect(await ensureClient(kv, authorize({ client_id: 'a', redirect_uri: 'https://evil.example/cb' }))).toBe('skipped');
    expect(JSON.parse(kv.store.get('client:a')!).redirectUris).toEqual([MUSE, 'https://agent.meta.ai/api/hatch/oauth/callback2']);
    kv.store.set('client:dcr', JSON.stringify({ clientId: 'dcr', redirectUris: ['https://x.example/cb'] }));
    expect(await ensureClient(kv, authorize({ client_id: 'dcr', redirect_uri: MUSE }))).toBe('skipped');
  });

  it('주소형 Client ID(CIMD), 빈 값, 안전하지 않은 redirect_uri는 그대로 둔다', async () => {
    const kv = fakeKv();
    expect(await ensureClient(kv, authorize({ client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }))).toBe('skipped');
    expect(await ensureClient(kv, authorize({ client_id: '', redirect_uri: MUSE }))).toBe('skipped');
    expect(await ensureClient(kv, authorize({ client_id: 'b', redirect_uri: 'http://evil.example/cb' }))).toBe('skipped');
    expect(await ensureClient(kv, authorize({ client_id: 'c', redirect_uri: 'http://127.0.0.1:3333/cb' }))).toBe('created');
    expect(kv.store.size).toBe(1);
  });

  it('에이전트 이름', () => {
    expect(agentName('https://claude.ai/api/mcp/auth_callback')).toBe('Claude');
    expect(agentName('https://grok.com/oauth/cb')).toBe('Grok');
    expect(agentName('https://chatgpt.com/connector_platform_oauth_redirect')).toBe('ChatGPT');
    expect(isKnownAgentHost('agent.meta.ai')).toBe(true);
    expect(isKnownAgentHost('evil.example')).toBe(false);
  });
});
