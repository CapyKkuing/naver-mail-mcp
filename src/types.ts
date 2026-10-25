import type { Account } from './mail/imap';

/** Workers Rate Limiting 바인딩 (wrangler.jsonc `ratelimits`) */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  /** 로그인 시도(POST /authorize) 제한: IP마다 분당 10회 */
  LOGIN_LIMITER?: RateLimiter;
  /** 로그인 시도 전체 합산 제한: 분당 60회. IP를 바꿔 가며 시도해도 네이버가 Cloudflare IP를 차단하지 않게 */
  GLOBAL_LOGIN_LIMITER?: RateLimiter;
  /** 클라이언트 등록(/oauth/register, 처음 보는 client_id) 제한: IP마다 분당 30회 */
  REGISTER_LIMITER?: RateLimiter;
  /** OAuth 메타데이터에 쓰는 배포 주소. 비우면 요청이 들어온 주소 (사용자 도메인을 붙일 때만 설정) */
  PUBLIC_URL?: string;
  /** 쉼표로 구분한 네이버 아이디. 비어 있으면 누구나 자기 계정으로 연결할 수 있다 */
  ALLOWED_USERS?: string;
  /** "false"면 보낸 메일 사본을 보낸메일함에 넣지 않는다 (네이버가 자동 저장하는 경우) */
  SAVE_SENT_COPY?: string;
  IMAP_HOST?: string;
  IMAP_PORT?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  /** 고정 토큰 모드(헤더를 넣을 수 있는 클라이언트용): 이 토큰이 맞으면 NAVER_ID 계정으로 접속 */
  MCP_BEARER_TOKEN?: string;
  NAVER_ID?: string;
  NAVER_APP_PASSWORD?: string;
  NAVER_DISPLAY_NAME?: string;
}

/** OAuth 토큰에 암호화되어 붙는 사용자 정보 */
export type Props = Account & Record<string, unknown>;
