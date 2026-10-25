import type { Account } from './mail/imap';

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  /** OAuth 메타데이터에 쓰는 배포 주소 (예: https://naver-mail-mcp.<계정>.workers.dev) */
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
