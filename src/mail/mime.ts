import { Buffer } from 'node:buffer';

/** 보낼 메일을 RFC 5322/MIME 원문으로 만든다. 한글 헤더·본문은 UTF-8 base64로 인코딩한다. */

export interface Address {
  name?: string;
  address: string;
}

export interface OutgoingAttachment {
  /** base64 내용 */
  content: string;
  filename?: string;
  mimeType?: string;
  /** true면 본문 HTML에서 cid:<첨부 순번>으로 참조하는 인라인 이미지 */
  inline?: boolean;
}

export interface Outgoing {
  from: Address;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  inReplyTo?: string;
  references?: string[];
  messageId?: string;
  date?: Date;
  /** 임시보관함에 저장할 때만 true: 숨은참조(Bcc) 헤더를 원문에 남긴다 */
  keepBcc?: boolean;
}

const CRLF = '\r\n';

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

export function newMessageId(domain: string): string {
  return `<${Date.now().toString(36)}.${randomId()}@${domain}>`;
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word. 한 단어가 75자를 넘지 않게 UTF-8 글자 경계에서 자른다 */
export function encodeWord(value: string): string {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  const name = isAscii(a.name) ? (/[()<>[\]:;@\\,."]/.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : a.name) : encodeWord(a.name);
  return `${name} <${a.address}>`;
}

const formatList = (list: Address[]) => list.map(formatAddress).join(`,${CRLF} `);

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 날짜. 한국 사용자용이라 +0900으로 쓴다 */
export function formatDate(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[k.getUTCDay()]}, ${k.getUTCDate()} ${MONTHS[k.getUTCMonth()]} ${k.getUTCFullYear()} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())} +0900`;
}

function base64Lines(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);
}

interface Part {
  headers: string[];
  body: string;
}

function textPart(content: string, subtype: 'plain' | 'html'): Part {
  return {
    headers: [`Content-Type: text/${subtype}; charset=UTF-8`, 'Content-Transfer-Encoding: base64'],
    body: base64Lines(Buffer.from(content, 'utf8')),
  };
}

function multipart(subtype: string, parts: Part[]): Part {
  const boundary = `----=_NaverMailMcp_${randomId()}`;
  const body = parts.map((p) => `--${boundary}${CRLF}${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}${CRLF}`).join('') + `--${boundary}--`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body };
}

/** RFC 2231 파일 이름 (한글 파일 이름이 깨지지 않게 filename*도 함께) */
function filenameParams(name: string, param: 'filename' | 'name'): string {
  if (isAscii(name)) return `${param}="${name.replace(/["\\]/g, '\\$&')}"`;
  return `${param}="${encodeWord(name).replace(/\r\n /g, ' ')}"; ${param}*=UTF-8''${encodeURIComponent(name)}`;
}

function attachmentPart(a: OutgoingAttachment, index: number): Part {
  const type = a.mimeType || 'application/octet-stream';
  const name = a.filename;
  const headers = [`Content-Type: ${type}${name ? `; ${filenameParams(name, 'name')}` : ''}`, 'Content-Transfer-Encoding: base64'];
  headers.push(`Content-Disposition: ${a.inline ? 'inline' : 'attachment'}${name ? `; ${filenameParams(name, 'filename')}` : ''}`);
  if (a.inline) headers.push(`Content-ID: <${index}>`);
  return { headers, body: base64Lines(Buffer.from(a.content, 'base64')) };
}

export interface BuiltMessage {
  raw: string;
  messageId: string;
  /** SMTP 봉투 수신자 (받는사람+참조+숨은참조) */
  recipients: string[];
}

export function buildMessage(o: Outgoing): BuiltMessage {
  const domain = o.from.address.split('@')[1] || 'naver.com';
  const messageId = o.messageId ?? newMessageId(domain);
  const headers: string[] = [`From: ${formatAddress(o.from)}`];
  if (o.to?.length) headers.push(`To: ${formatList(o.to)}`);
  if (o.cc?.length) headers.push(`Cc: ${formatList(o.cc)}`);
  if (o.keepBcc && o.bcc?.length) headers.push(`Bcc: ${formatList(o.bcc)}`);
  if (o.replyTo?.length) headers.push(`Reply-To: ${formatList(o.replyTo)}`);
  headers.push(`Subject: ${encodeWord(o.subject ?? '')}`, `Date: ${formatDate(o.date ?? new Date())}`, `Message-ID: ${messageId}`);
  if (o.inReplyTo) headers.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references?.length) headers.push(`References: ${o.references.join(`${CRLF} `)}`);
  headers.push('MIME-Version: 1.0', 'X-Mailer: naver-mail-mcp');

  const text = o.text ?? (o.html ? undefined : '');
  let body: Part;
  if (text !== undefined && o.html) body = multipart('alternative', [textPart(text, 'plain'), textPart(o.html, 'html')]);
  else if (o.html) body = textPart(o.html, 'html');
  else body = textPart(text ?? '', 'plain');

  const attachments = o.attachments ?? [];
  const inline = attachments.map((a, i) => ({ a, i })).filter(({ a }) => a.inline);
  const regular = attachments.map((a, i) => ({ a, i })).filter(({ a }) => !a.inline);
  if (inline.length) body = multipart('related', [body, ...inline.map(({ a, i }) => attachmentPart(a, i))]);
  if (regular.length) body = multipart('mixed', [body, ...regular.map(({ a, i }) => attachmentPart(a, i))]);

  const raw = [...headers, ...body.headers].join(CRLF) + CRLF + CRLF + body.body + CRLF;
  const recipients = [...(o.to ?? []), ...(o.cc ?? []), ...(o.bcc ?? [])].map((a) => a.address);
  return { raw, messageId, recipients: [...new Set(recipients)] };
}

/** 받는 주소 문자열 목록 → Address. "이름 <a@b.c>" 꼴도 받는다 */
export function parseAddressList(list: string[] | undefined): Address[] {
  return (list ?? [])
    .flatMap((s) => s.split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(.*?)\s*<([^>]+)>$/.exec(s);
      if (m) return { name: m[1]!.replace(/^"|"$/g, '').trim() || undefined, address: m[2]!.trim() };
      return { address: s };
    });
}
