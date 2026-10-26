import type { Props } from './types';

/**
 * MCP 세션을 로그인한 사람에게 묶는다.
 * agents의 McpAgent는 클라이언트가 보낸 mcp-session-id만으로 세션(Durable Object 이름 `streamable-http:<ID>`)을 고르고,
 * 이미 시작된 세션은 처음 연 사람의 계정을 계속 쓴다. 그래서 남의 세션 ID를 알면 내 토큰으로 남의 메일함을 쓸 수 있었다.
 * 라이브러리에 넘기는 Durable Object 이름 끝에 계정 표시(`:<계정 해시>`)를 붙여, 다른 계정의 토큰으로는 같은 세션에 닿지 않게 한다.
 * McpAgent는 이름을 ':'로 나눠 앞 두 조각(전송 방식, 세션 ID)만 읽으므로 동작은 그대로이고, 클라이언트가 보는 세션 ID도 그대로다.
 */
async function ownerTag(props: Props): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(props.email.toLowerCase()));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function scopedNamespace<T extends DurableObjectNamespace>(ns: T, tag: string): T {
  const named = (name: string) => `${name}:${tag}`;
  return {
    newUniqueId: (o?: DurableObjectNamespaceNewUniqueIdOptions) => ns.newUniqueId(o),
    idFromName: (name: string) => ns.idFromName(named(name)),
    idFromString: (id: string) => ns.idFromString(id),
    get: (id: DurableObjectId, o?: DurableObjectNamespaceGetDurableObjectOptions) => ns.get(id, o),
    getByName: (name: string, o?: DurableObjectNamespaceGetDurableObjectOptions) => ns.getByName(named(name), o),
    jurisdiction: (j: DurableObjectJurisdiction) => scopedNamespace(ns.jurisdiction(j), tag),
  } as unknown as T;
}

type Handler<E> = { fetch: (req: Request, env: E, ctx: ExecutionContext) => Promise<Response> };

/** props는 OAuth 토큰(또는 고정 토큰 모드의 시크릿)에서 온 값이어야 한다 */
export function bindSessionToUser<E extends { MCP_OBJECT: DurableObjectNamespace }>(mcp: Handler<E>): Handler<E> {
  return {
    async fetch(req, env, ctx) {
      const props = (ctx as unknown as { props?: Props }).props;
      if (!props?.email) return new Response('Unauthorized', { status: 401 });
      return mcp.fetch(req, { ...env, MCP_OBJECT: scopedNamespace(env.MCP_OBJECT, await ownerTag(props)) }, ctx);
    },
  };
}
