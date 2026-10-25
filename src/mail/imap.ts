import { Buffer } from 'node:buffer';
import { ImapFlow, type ListResponse } from 'imapflow';
import type { FolderRole } from './query';

export interface MailConfig {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** SMTP로 보낸 뒤 보낸메일함에 사본을 넣을지 */
  saveSentCopy: boolean;
  /** 테스트 전용: 자체 서명 인증서 허용 */
  insecureTls?: boolean;
}

export const NAVER_DEFAULTS: MailConfig = {
  imapHost: 'imap.naver.com',
  imapPort: 993,
  smtpHost: 'smtp.naver.com',
  smtpPort: 465,
  saveSentCopy: true,
};

export interface Account {
  /** IMAP/SMTP 로그인 아이디 (네이버 아이디, @naver.com 없이) */
  login: string;
  /** 보내는 주소 */
  email: string;
  password: string;
  /** 보내는 사람 이름 (선택) */
  displayName?: string;
}

/** "myid" 또는 "myid@naver.com" → 계정. 네이버 IMAP/SMTP 로그인은 아이디만 쓴다 */
export function naverAccount(user: string, password: string, displayName?: string): Account {
  const u = user.trim();
  const [id, domain] = u.includes('@') ? [u.split('@')[0]!, u.split('@')[1]!.toLowerCase()] : [u, 'naver.com'];
  return { login: domain === 'naver.com' ? id : u, email: `${id}@${domain}`, password: password.replace(/\s+/g, ''), displayName: displayName?.trim() || undefined };
}

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

export function createClient(account: Account, cfg: MailConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: account.login, pass: account.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    tls: { rejectUnauthorized: !cfg.insecureTls },
  });
}

/** 로그인 실패를 사람이 알아들을 말로 */
export function explainImapError(e: unknown): Error {
  const err = e as { authenticationFailed?: boolean; responseText?: string; message?: string; code?: string };
  if (err?.authenticationFailed) {
    return new MailError(
      '네이버 메일 로그인에 실패했습니다. 네이버 메일 환경설정에서 IMAP/SMTP 사용을 켰는지, 2단계 인증을 쓰면 일반 비밀번호 대신 애플리케이션 비밀번호를 넣었는지 확인하세요.' +
        (err.responseText ? ` (서버 응답: ${err.responseText})` : ''),
    );
  }
  if (e instanceof MailError) return e;
  return new MailError(`네이버 메일 서버 오류: ${err?.responseText || err?.message || String(e)}`);
}

export async function withClient<T>(account: Account, cfg: MailConfig, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = createClient(account, cfg);
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (e) {
    throw explainImapError(e);
  }
  try {
    return await fn(client);
  } catch (e) {
    throw explainImapError(e);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export interface Folder {
  path: string;
  name: string;
  delimiter: string;
  role?: FolderRole;
  specialUse?: string;
}

const ROLE_BY_SPECIAL: Record<string, FolderRole> = {
  '\\Inbox': 'INBOX',
  '\\Sent': 'SENT',
  '\\Drafts': 'DRAFT',
  '\\Trash': 'TRASH',
  '\\Junk': 'SPAM',
};

/** 특수 용도 표시가 없을 때 이름으로 추정 (네이버: 보낸메일함, 임시보관함, 휴지통, 스팸메일함) */
const ROLE_BY_NAME: Array<[RegExp, FolderRole]> = [
  [/^inbox$|받은\s*메일/i, 'INBOX'],
  [/sent|보낸\s*메일/i, 'SENT'],
  [/draft|임시\s*보관/i, 'DRAFT'],
  [/trash|deleted|휴지통/i, 'TRASH'],
  [/junk|spam|스팸/i, 'SPAM'],
];

export function classifyFolders(list: ListResponse[]): Folder[] {
  const folders: Folder[] = list
    .filter((f) => !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent'))
    .map((f) => ({ path: f.path, name: f.name, delimiter: f.delimiter || '/', specialUse: f.specialUse || undefined }));
  const taken = new Set<FolderRole>();
  for (const f of folders) {
    const role = f.path.toUpperCase() === 'INBOX' ? 'INBOX' : f.specialUse ? ROLE_BY_SPECIAL[f.specialUse] : undefined;
    if (role && !taken.has(role)) {
      f.role = role;
      taken.add(role);
    }
  }
  for (const [re, role] of ROLE_BY_NAME) {
    if (taken.has(role)) continue;
    const f = folders.find((x) => !x.role && re.test(x.name));
    if (f) {
      f.role = role;
      taken.add(role);
    }
  }
  return folders;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

/** 메일 ID = 메일함 경로 + UIDVALIDITY + UID. 메일함을 옮기면 ID가 바뀐다 (IMAP 한계) */
export function encodeMessageId(path: string, uidValidity: bigint | number | string, uid: number): string {
  return `${b64url(path)}.${String(uidValidity)}.${uid}`;
}

export function decodeMessageId(id: string): { path: string; uidValidity: string; uid: number } {
  const m = /^([A-Za-z0-9_-]+)\.(\d+)\.(\d+)$/.exec(id.trim());
  if (!m) throw new MailError(`올바르지 않은 메일 ID입니다: ${id}. search_threads나 get_thread 결과의 id를 쓰세요.`);
  return { path: unb64url(m[1]!), uidValidity: m[2]!, uid: Number(m[3]) };
}

/** 대화 ID = 대화 첫 메일의 Message-ID. Message-ID가 없는 메일은 메일 ID 그대로 */
export function encodeThreadId(root: string | undefined, messageId: string): string {
  return root ? `t${b64url(root)}` : `m${messageId}`;
}

export function decodeThreadId(id: string): { root?: string; messageId?: string } {
  const t = id.trim();
  if (t.startsWith('t')) return { root: unb64url(t.slice(1)) };
  if (t.startsWith('m')) return { messageId: t.slice(1) };
  throw new MailError(`올바르지 않은 대화 ID입니다: ${id}. search_threads 결과의 thread id를 쓰세요.`);
}
