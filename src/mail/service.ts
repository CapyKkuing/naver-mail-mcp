import { Buffer } from 'node:buffer';
import type { FetchMessageObject, ImapFlow, MessageAddressObject, SearchObject } from 'imapflow';
import type { Email } from 'postal-mime';
import {
  classifyFolders,
  decodeMessageId,
  decodeThreadId,
  encodeMessageId,
  encodeThreadId,
  MailError,
  withClient,
  type Account,
  type Folder,
  type MailConfig,
} from './imap';
import { buildMessage, parseAddressList, type Address, type Outgoing, type OutgoingAttachment } from './mime';
import { addresses, formatAddr, htmlToText, parseRaw, plainBody, snippetOf, threadRoot, type AddressOut } from './parse';
import { andSearch, parseGmailQuery, type FolderRole, type ParsedQuery, type Scope } from './query';
import { sendMail } from './smtp';

/**
 * Gmail MCP의 도구를 네이버 메일(IMAP/SMTP) 위에서 같은 이름·같은 입력으로 구현한다.
 * - 라벨 = 메일함. 시스템 라벨 INBOX/SENT/DRAFT/TRASH/SPAM은 해당 메일함, STARRED/UNREAD는 플래그.
 * - 메일 ID는 메일함+UID라서 메일을 옮기면 바뀐다. 옮기는 도구는 새 ID를 돌려준다.
 */

export type MessageFormat = 'MESSAGE_FORMAT_UNSPECIFIED' | 'MINIMAL' | 'FULL_CONTENT' | 'METADATA_ONLY' | 'PLAIN_TEXT' | 'RAW';
export type ThreadView = 'THREAD_VIEW_UNSPECIFIED' | 'THREAD_VIEW_METADATA_ONLY' | 'THREAD_VIEW_MINIMAL';

export interface MessageOut {
  id: string;
  threadId: string;
  subject?: string;
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  date?: string;
  labelIds: string[];
  snippet?: string;
  plaintextBody?: string;
  htmlBody?: string;
  attachmentIds?: string[];
  attachments?: { attachmentId: string; filename?: string; mimeType: string; size: number; inline?: boolean }[];
  sizeEstimate?: number;
  raw?: string;
}

export interface AttachmentIn {
  content: string;
  filename?: string;
  mimeType?: string;
  inline?: boolean;
}

export interface ComposeIn {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: AttachmentIn[];
}

const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD'] as const;
const FOLDER_LABEL_NAMES: Record<FolderRole, string> = { INBOX: '받은메일함', SENT: '보낸메일함', DRAFT: '임시보관함', TRASH: '휴지통', SPAM: '스팸메일함' };
const HTML_LIMIT = 100_000;
const RAW_LIMIT = 2_000_000;
const SNIPPET_BYTES = 24 * 1024;
const ATTACHMENT_LIMIT = 25 * 1024 * 1024;
const MAX_ATTACHMENT_RETURN = 8 * 1024 * 1024;
const ATTACH_BATCH = 200;
const ATTACH_SCAN_LIMIT = 3000;
const THREAD_SCAN_LIMIT = 1000;

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const lower = (s: string) => s.toLowerCase();

function envelopeAddrs(list: MessageAddressObject[] | undefined): AddressOut[] {
  return (list ?? []).filter((a) => a.address).map((a) => (a.name ? { name: a.name, address: a.address! } : { address: a.address! }));
}

function headerValue(headers: Buffer | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const text = headers.toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(text);
  return m?.[1]?.trim();
}

const toDate = (d: Date | string | undefined) => (d ? new Date(d) : undefined);

/** 첨부 base64 합계 25MB 제한 (Gmail과 같음) */
function checkAttachmentSize(list: AttachmentIn[] | OutgoingAttachment[] | undefined) {
  const total = (list ?? []).reduce((n, a) => n + Math.floor((a.content.length * 3) / 4), 0);
  if (total > ATTACHMENT_LIMIT) throw new MailError('첨부파일 합계가 25MB를 넘습니다. 큰 파일은 클라우드 링크를 본문에 넣으세요.');
}

export class NaverMailService {
  constructor(
    readonly account: Account,
    readonly cfg: MailConfig,
  ) {}

  private run<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    return withClient(this.account, this.cfg, (c) => fn(new Session(c, this.account, this.cfg)));
  }

  // ───────────── 계정·라벨 ─────────────

  getProfile() {
    return this.run(async (s) => {
      const folders = await s.folders();
      const inbox = folders.find((f) => f.role === 'INBOX');
      const st = inbox ? (await s.client.status(inbox.path, { messages: true, unseen: true })) || undefined : undefined;
      return { emailAddress: this.account.email, messagesTotal: st?.messages, unreadInInbox: st?.unseen, folders: folders.length };
    });
  }

  listLabels() {
    return this.run(async (s) => {
      const folders = await s.folders();
      const labels: { id: string; name: string; type: 'system' | 'user'; folderPath?: string; messagesTotal?: number; messagesUnread?: number }[] = [];
      for (const f of folders) {
        const st = (await s.client.status(f.path, { messages: true, unseen: true }).catch(() => undefined)) || undefined;
        const counts = { messagesTotal: st?.messages, messagesUnread: st?.unseen };
        if (f.role) labels.push({ id: f.role, name: FOLDER_LABEL_NAMES[f.role], type: 'system', folderPath: f.path, ...counts });
        else labels.push({ id: f.path, name: f.path, type: 'user', folderPath: f.path, ...counts });
      }
      labels.push({ id: 'STARRED', name: '중요(별표)', type: 'system' }, { id: 'UNREAD', name: '안읽음', type: 'system' });
      return {
        labels,
        note: '네이버 메일의 라벨은 메일함입니다. 사용자 라벨을 붙이면 그 메일함으로 이동합니다(한 메일은 한 메일함에만 있음). STARRED는 중요 표시, UNREAD는 안읽음 표시입니다.',
      };
    });
  }

  createLabel(displayName: string) {
    return this.run(async (s) => {
      const folders = await s.folders();
      const delim = folders[0]?.delimiter ?? '/';
      const path = displayName.split('/').map((p) => p.trim()).filter(Boolean).join(delim);
      if (!path) throw new MailError('라벨 이름이 비어 있습니다');
      if (folders.some((f) => f.path === path)) throw new MailError(`이미 있는 메일함입니다: ${path}`);
      // 부모 메일함부터 차례로 만든다 (Gmail의 autoCreateParentLabels와 같음)
      const parts = path.split(delim);
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join(delim);
        if (!folders.some((f) => f.path === p)) await s.client.mailboxCreate(p);
      }
      return { id: path, name: path, type: 'user' };
    });
  }

  updateLabel(labelId: string, displayName: string) {
    return this.run(async (s) => {
      const f = await s.userFolder(labelId);
      const delim = f.delimiter;
      const newPath = displayName.split('/').map((p) => p.trim()).filter(Boolean).join(delim);
      await s.client.mailboxRename(f.path, newPath);
      return { id: newPath, name: newPath, type: 'user' };
    });
  }

  deleteLabel(labelId: string) {
    return this.run(async (s) => {
      const f = await s.userFolder(labelId);
      await s.client.mailboxDelete(f.path);
      return { deleted: f.path, note: '메일함과 그 안의 메일이 함께 삭제됩니다.' };
    });
  }

  // ───────────── 찾기·읽기 ─────────────

  searchThreads(a: { query?: string; pageSize?: number; pageToken?: string; includeTrash?: boolean; view?: ThreadView }) {
    return this.run(async (s) => {
      const page = await s.searchMessages(a.query, { pageSize: a.pageSize ?? 20, pageToken: a.pageToken, includeTrash: a.includeTrash, defaultExclude: ['TRASH', 'SPAM', 'DRAFT'] });
      const format: MessageFormat = a.view === 'THREAD_VIEW_METADATA_ONLY' ? 'METADATA_ONLY' : 'MINIMAL';
      const messages = await s.loadMessages(page.hits, format);
      const threads: { id: string; messageCount: number; messages: MessageOut[] }[] = [];
      const byId = new Map<string, (typeof threads)[number]>();
      for (const m of messages) {
        let t = byId.get(m.threadId);
        if (!t) {
          t = { id: m.threadId, messageCount: 0, messages: [] };
          byId.set(m.threadId, t);
          threads.push(t);
        }
        t.messageCount++;
        if (t.messages.length < 5) t.messages.push(m);
      }
      return {
        threads,
        nextPageToken: page.nextPageToken,
        searchedFolders: page.folders,
        ...(page.warnings.length ? { warnings: page.warnings } : {}),
        note: '검색 결과는 미리보기입니다. messageCount는 이번 페이지에 걸린 메일 수입니다. 대화 전체는 get_thread로 읽으세요.',
      };
    });
  }

  getThread(threadId: string, format: MessageFormat = 'FULL_CONTENT') {
    return this.run(async (s) => {
      const hits = await s.threadHits(threadId);
      const messages = await s.loadMessages(hits, format === 'RAW' ? 'FULL_CONTENT' : format);
      messages.sort((x, y) => (x.date ?? '').localeCompare(y.date ?? ''));
      return { id: threadId, messages };
    });
  }

  getMessage(messageId: string, format: MessageFormat = 'FULL_CONTENT') {
    return this.run(async (s) => {
      const hit = await s.resolve(messageId);
      const [m] = await s.loadMessages([hit], format);
      return m;
    });
  }

  getAttachment(messageId: string, attachmentId: string) {
    return this.run(async (s) => {
      const hit = await s.resolve(messageId);
      const { parsed } = await s.fetchFull(hit);
      const att = parsed.attachments[Number(attachmentId)];
      if (!att) throw new MailError(`첨부파일을 찾지 못했습니다: ${attachmentId}. get_message 결과의 attachmentId를 쓰세요.`);
      const bytes = Buffer.from(att.content as ArrayBuffer);
      const textual = /^text\/|json|xml|csv|javascript|calendar/.test(att.mimeType);
      const out: Record<string, unknown> = { attachmentId, filename: att.filename ?? undefined, mimeType: att.mimeType, size: bytes.length };
      if (textual) {
        const t = new TextDecoder().decode(bytes);
        out.text = att.mimeType.includes('html') ? htmlToText(t) : t;
      }
      if (bytes.length <= MAX_ATTACHMENT_RETURN) out.data = bytes.toString('base64');
      else out.note = '파일이 커서(8MB 초과) 내용은 돌려주지 않았습니다.';
      return out;
    });
  }

  // ───────────── 라벨·정리 ─────────────

  updateMessageLabels(messageId: string, add: string[] = [], remove: string[] = []) {
    return this.run(async (s) => s.modify(await s.resolve(messageId), add, remove));
  }

  updateThreadLabels(threadId: string, add: string[] = [], remove: string[] = []) {
    return this.run(async (s) => {
      const hits = await s.threadHits(threadId);
      const results = [];
      for (const h of hits) results.push(await s.modify(h, add, remove));
      return { id: threadId, messages: results };
    });
  }

  /** 휴지통·스팸에서 꺼낼 때: 내가 보낸 메일이면 보낸메일함, 아니면 받은메일함으로 */
  restoreMessage(messageId: string, from: 'TRASH' | 'SPAM') {
    return this.run(async (s) => s.restore(await s.resolve(messageId), from));
  }

  restoreThread(threadId: string, from: 'TRASH' | 'SPAM') {
    return this.run(async (s) => {
      const hits = (await s.threadHits(threadId, true)).filter((h) => h.folder.role === from);
      const results = [];
      for (const h of hits) results.push(await s.restore(h, from));
      return { id: threadId, messages: results };
    });
  }

  // ───────────── 보내기 ─────────────

  sendMessage(a: ComposeIn & { draftId?: string; replyToMessageId?: string; replyThreadId?: string }) {
    return this.run(async (s) => {
      if (a.draftId) return s.sendDraft(a.draftId, this.cfg);
      checkAttachmentSize(a.attachments);
      let threading: Pick<Outgoing, 'inReplyTo' | 'references'> = {};
      let subject = a.subject;
      const parentHit = a.replyToMessageId ? await s.resolve(a.replyToMessageId) : a.replyThreadId ? (await s.threadHits(a.replyThreadId)).at(-1) : undefined;
      if (parentHit) {
        const { parsed } = await s.fetchFull(parentHit);
        threading = replyThreading(parsed);
        subject ??= prefixSubject('Re: ', parsed.subject);
      }
      const out = this.outgoing({ ...a, subject }, threading);
      return s.deliver(out, this.cfg);
    });
  }

  reply(a: ComposeIn & { messageId: string; replyAll?: boolean }) {
    if (!a.body && !a.htmlBody) throw new MailError('body 또는 htmlBody가 필요합니다');
    checkAttachmentSize(a.attachments);
    return this.run(async (s) => {
      const hit = await s.resolve(a.messageId);
      const { parsed } = await s.fetchFull(hit);
      const rcpt = replyRecipients(parsed, this.account.email, !!a.replyAll);
      const quoted = quoteOriginal(parsed, a.body, a.htmlBody);
      const out = this.outgoing(
        { to: a.to?.length ? a.to : rcpt.to, cc: a.cc?.length ? a.cc : rcpt.cc, bcc: a.bcc, subject: prefixSubject('Re: ', parsed.subject), body: quoted.text, htmlBody: quoted.html, attachments: a.attachments },
        replyThreading(parsed),
      );
      const res = await s.deliver(out, this.cfg);
      await s.withLock(hit.folder.path, () => s.client.messageFlagsAdd([hit.uid], ['\\Answered'], { uid: true })).catch(() => undefined);
      return res;
    });
  }

  forward(a: Omit<ComposeIn, 'subject' | 'body'> & { messageId: string; forwardText?: string }) {
    return this.run(async (s) => {
      const hit = await s.resolve(a.messageId);
      const { parsed } = await s.fetchFull(hit);
      const original: OutgoingAttachment[] = parsed.attachments.map((x) => ({
        content: Buffer.from(x.content as ArrayBuffer).toString('base64'),
        filename: x.filename ?? undefined,
        mimeType: x.mimeType,
        inline: x.disposition === 'inline' && !!x.contentId,
      }));
      const attachments = [...original, ...(a.attachments ?? [])];
      checkAttachmentSize(attachments);
      const fwd = forwardBody(parsed, a.forwardText, a.htmlBody);
      const out = this.outgoing({ to: a.to, cc: a.cc, bcc: a.bcc, subject: prefixSubject('Fwd: ', parsed.subject), body: fwd.text, htmlBody: fwd.html, attachments }, {});
      return s.deliver(out, this.cfg);
    });
  }

  // ───────────── 임시보관함 ─────────────

  createDraft(a: ComposeIn & { replyToMessageId?: string }) {
    checkAttachmentSize(a.attachments);
    return this.run(async (s) => {
      let threading: Pick<Outgoing, 'inReplyTo' | 'references'> = {};
      let { to, cc, subject, body, htmlBody } = a;
      if (a.replyToMessageId) {
        const { parsed } = await s.fetchFull(await s.resolve(a.replyToMessageId));
        threading = replyThreading(parsed);
        subject ??= prefixSubject('Re: ', parsed.subject);
        if (!to?.length) to = replyRecipients(parsed, this.account.email, false).to;
        const q = quoteOriginal(parsed, body ?? (htmlBody ? undefined : ''), htmlBody);
        body = q.text;
        htmlBody = q.html;
      }
      const out = this.outgoing({ ...a, to, cc, subject, body, htmlBody }, threading);
      return s.saveDraft(out);
    });
  }

  updateDraft(a: ComposeIn & { draftId: string }) {
    checkAttachmentSize(a.attachments);
    return this.run(async (s) => {
      const hit = await s.resolve(a.draftId);
      if (hit.folder.role !== 'DRAFT') throw new MailError('임시보관함의 메일만 수정할 수 있습니다');
      const { parsed } = await s.fetchFull(hit);
      const keep = (given: string[] | undefined, old: Email['to']) => (given?.length ? given : addresses(old).map(formatAddr));
      // body만 주면 HTML은 지운다 (Gmail과 같음). 둘 다 비면 기존 본문 유지
      const hasBody = !!(a.body || a.htmlBody);
      const out = this.outgoing(
        {
          to: keep(a.to, parsed.to),
          cc: keep(a.cc, parsed.cc),
          bcc: keep(a.bcc, parsed.bcc),
          subject: a.subject || parsed.subject,
          body: hasBody ? a.body : parsed.text ?? undefined,
          htmlBody: hasBody ? a.htmlBody : parsed.html ?? undefined,
          attachments: a.attachments,
        },
        { inReplyTo: parsed.inReplyTo ?? undefined, references: (parsed.references ?? '').match(/<[^>]+>/g) ?? undefined },
      );
      const saved = await s.saveDraft(out);
      await s.withLock(hit.folder.path, () => s.client.messageDelete([hit.uid], { uid: true }));
      return { ...saved, previousId: a.draftId, note: 'IMAP에서는 임시보관 메일을 고칠 때 새로 저장하므로 ID가 바뀝니다. 이후에는 새 id를 쓰세요.' };
    });
  }

  deleteDraft(draftId: string) {
    return this.run(async (s) => {
      const hit = await s.resolve(draftId);
      if (hit.folder.role !== 'DRAFT') throw new MailError('임시보관함의 메일만 이 도구로 지울 수 있습니다');
      await s.withLock(hit.folder.path, () => s.client.messageDelete([hit.uid], { uid: true }));
      return { deleted: draftId };
    });
  }

  listDrafts(a: { query?: string; pageSize?: number; pageToken?: string; view?: 'DRAFT_VIEW_UNSPECIFIED' | 'DRAFT_VIEW_METADATA_ONLY' | 'DRAFT_VIEW_FULL' }) {
    return this.run(async (s) => {
      const drafts = await s.roleFolder('DRAFT');
      const page = await s.searchMessages(a.query, { pageSize: Math.min(a.pageSize ?? 20, 50), pageToken: a.pageToken, onlyFolders: [drafts] });
      const full = a.view === 'DRAFT_VIEW_FULL';
      const msgs = await s.loadMessages(page.hits, full ? 'PLAIN_TEXT' : 'METADATA_ONLY');
      return {
        drafts: msgs.map((m) => (full ? { ...m } : { id: m.id, threadId: m.threadId, toRecipients: m.toRecipients, ccRecipients: m.ccRecipients, bccRecipients: m.bccRecipients, date: m.date })),
        nextPageToken: page.nextPageToken,
        ...(page.warnings.length ? { warnings: page.warnings } : {}),
      };
    });
  }

  // ───────────── 내부 ─────────────

  private outgoing(a: ComposeIn, threading: Pick<Outgoing, 'inReplyTo' | 'references'>): Outgoing {
    const to = parseAddressList(a.to);
    const cc = parseAddressList(a.cc);
    const bcc = parseAddressList(a.bcc);
    return {
      from: { name: this.account.displayName, address: this.account.email },
      to,
      cc,
      bcc,
      subject: a.subject ?? '',
      text: a.body ?? (a.htmlBody ? htmlToText(a.htmlBody) : ''),
      html: a.htmlBody,
      attachments: a.attachments,
      ...threading,
    };
  }
}

interface Hit {
  folder: Folder;
  uid: number;
  uidValidity: string;
  date?: Date;
}

class Session {
  private folderCache?: Folder[];

  constructor(
    readonly client: ImapFlow,
    readonly account: Account,
    readonly cfg: MailConfig,
  ) {}

  async folders(): Promise<Folder[]> {
    this.folderCache ??= classifyFolders(await this.client.list());
    return this.folderCache;
  }

  async roleFolder(role: FolderRole): Promise<Folder> {
    const f = (await this.folders()).find((x) => x.role === role);
    if (!f) throw new MailError(`${FOLDER_LABEL_NAMES[role]}(${role})을 찾지 못했습니다. list_labels로 메일함 목록을 확인하세요.`);
    return f;
  }

  /** 라벨 ID(시스템 라벨 또는 메일함 경로/이름) → 메일함 */
  async labelFolder(labelId: string): Promise<Folder | undefined> {
    const id = labelId.trim();
    const folders = await this.folders();
    const role = id.toUpperCase();
    if (['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(role)) return this.roleFolder(role as FolderRole);
    return folders.find((f) => f.path === id) ?? folders.find((f) => lower(f.path) === lower(id) || lower(f.name) === lower(id));
  }

  async userFolder(labelId: string): Promise<Folder> {
    const f = await this.labelFolder(labelId);
    if (!f) throw new MailError(`라벨(메일함)을 찾지 못했습니다: ${labelId}`);
    if (f.role) throw new MailError(`시스템 메일함(${FOLDER_LABEL_NAMES[f.role]})은 바꾸거나 지울 수 없습니다`);
    return f;
  }

  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lock = await this.client.getMailboxLock(path);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  private currentUidValidity(): string {
    const mb = this.client.mailbox;
    return mb ? String(mb.uidValidity) : '0';
  }

  async resolve(messageId: string): Promise<Hit> {
    const { path, uidValidity, uid } = decodeMessageId(messageId);
    const folder = (await this.folders()).find((f) => f.path === path);
    if (!folder) throw new MailError('메일이 있던 메일함을 찾지 못했습니다. 메일이 옮겨졌다면 다시 검색하세요.');
    return { folder, uid, uidValidity };
  }

  private async scopeFolders(include: Scope[], exclude: Scope[], defaults: FolderRole[]): Promise<{ folders: Folder[]; warnings: string[] }> {
    const all = await this.folders();
    const warnings: string[] = [];
    const match = (s: Scope): Folder[] => {
      if (s.kind === 'anywhere') return all;
      if (s.kind === 'role') return all.filter((f) => f.role === s.role);
      const found = all.filter((f) => f.path === s.path || lower(f.path) === lower(s.path) || lower(f.name) === lower(s.path) || lower(f.path).replace(/[\s/.-]+/g, '-') === lower(s.path));
      if (!found.length) warnings.push(`메일함을 찾지 못했습니다: ${s.path}`);
      return found;
    };
    let folders = include.length ? uniq(include.flatMap(match)) : all.filter((f) => !f.role || !defaults.includes(f.role));
    const ex = new Set(exclude.flatMap(match).map((f) => f.path));
    folders = folders.filter((f) => !ex.has(f.path));
    return { folders, warnings };
  }

  async searchMessages(
    query: string | undefined,
    o: { pageSize: number; pageToken?: string; includeTrash?: boolean; defaultExclude?: FolderRole[]; onlyFolders?: Folder[] },
  ): Promise<{ hits: Hit[]; nextPageToken?: string; folders: string[]; warnings: string[] }> {
    const parsed = parseGmailQuery(query);
    const offset = Math.max(0, Number(o.pageToken ?? 0) || 0);
    const pageSize = Math.min(Math.max(o.pageSize, 1), 50);
    const defaults = (o.defaultExclude ?? []).filter((r) => !(o.includeTrash && r === 'TRASH'));
    const scoped = o.onlyFolders ? { folders: o.onlyFolders, warnings: [] } : await this.scopeFolders(parsed.include, parsed.exclude, defaults);
    const warnings = [...parsed.warnings, ...scoped.warnings];
    const need = offset + pageSize;
    const candidates: Hit[] = [];
    let more = false;
    const attach = parsed.attachment;
    for (const folder of scoped.folders) {
      await this.withLock(folder.path, async () => {
        const uids = await this.findUids(parsed, warnings);
        if (!uids.length) return;
        const sorted = [...uids].sort((x, y) => y - x);
        const uidValidity = this.currentUidValidity();
        if (!attach) {
          if (sorted.length > need) more = true;
          for await (const msg of this.client.fetch(sorted.slice(0, need), { uid: true, internalDate: true }, { uid: true })) {
            candidates.push({ folder, uid: msg.uid, uidValidity, date: toDate(msg.internalDate) });
          }
          return;
        }
        // 첨부 조건: 최신 메일부터 구조를 읽어 need개를 채울 때까지 거른다
        let found = 0;
        let scanned = 0;
        for (let i = 0; i < sorted.length && found < need; i += ATTACH_BATCH) {
          if (scanned >= ATTACH_SCAN_LIMIT) {
            more = true;
            warnings.push(`첨부 조건은 메일함마다 최근 ${ATTACH_SCAN_LIMIT}통까지만 확인했습니다 (${folder.path}). 기간 조건(after:, newer_than:)을 함께 쓰면 더 오래된 메일도 찾을 수 있습니다.`);
            return;
          }
          const batch = sorted.slice(i, i + ATTACH_BATCH);
          scanned += batch.length;
          for await (const msg of this.client.fetch(batch, { uid: true, internalDate: true, bodyStructure: true }, { uid: true })) {
            if (hasAttachment(msg.bodyStructure, attach.filename) !== attach.required) continue;
            candidates.push({ folder, uid: msg.uid, uidValidity, date: toDate(msg.internalDate) });
            found++;
          }
          if (found >= need && i + ATTACH_BATCH < sorted.length) more = true;
        }
      });
    }
    candidates.sort((x, y) => (y.date?.getTime() ?? 0) - (x.date?.getTime() ?? 0));
    const hits = candidates.slice(offset, offset + pageSize);
    if (candidates.length > offset + pageSize) more = true;
    return { hits, nextPageToken: more ? String(offset + pageSize) : undefined, folders: scoped.folders.map((f) => f.path), warnings: uniq(warnings) };
  }

  /** IMAP 검색 한 번. 서버가 거부하면(imapflow는 false를 돌려줌) null */
  private async trySearch(q: SearchObject): Promise<number[] | null> {
    const r = await this.client.search(q, { uid: true }).catch(() => false as const);
    return Array.isArray(r) ? r : null;
  }

  /** 선택된 메일함에서 조건에 맞는 UID. 낱말은 제목·보낸 사람·본문을 따로 검색해 합친다 */
  private async findUids(parsed: ParsedQuery, warnings: string[]): Promise<number[]> {
    if (!parsed.keywords?.length) {
      const r = await this.trySearch(parsed.search ?? { all: true });
      if (r === null) warnings.push('네이버 메일 서버가 이 검색 조건을 처리하지 못했습니다. 조건을 더 단순하게(예: subject:, from:) 바꿔 보세요.');
      return r ?? [];
    }
    let result: Set<number> | undefined;
    for (const w of parsed.keywords) {
      const found = new Set<number>();
      const failed: string[] = [];
      for (const field of ['subject', 'from', 'body'] as const) {
        const r = await this.trySearch(andSearch(parsed.search, { [field]: w }));
        if (r === null) failed.push(field);
        else r.forEach((u) => found.add(u));
      }
      if (failed.length === 3) warnings.push(`네이버 메일 서버가 "${w}" 검색을 처리하지 못했습니다.`);
      else if (failed.includes('body')) warnings.push('네이버 메일 서버가 본문 검색을 처리하지 못해 제목·보낸 사람에서만 찾았습니다.');
      result = result ? new Set([...result].filter((u) => found.has(u))) : found;
    }
    return [...(result ?? [])];
  }

  /**
   * 대화에 속한 메일: 첫 메일 Message-ID를 Message-ID/References/In-Reply-To에 가진 메일.
   * 네이버 IMAP의 HEADER 검색은 믿을 수 없어서(실제 계정에서 헤더 검색이 0건), 결과를 헤더로 다시 확인하고
   * 하나도 없으면 메일함마다 최근 메일의 헤더를 읽어 직접 찾는다.
   */
  async threadHits(threadId: string, includeTrashSpam = false): Promise<Hit[]> {
    const t = decodeThreadId(threadId);
    if (t.messageId) return [await this.resolve(t.messageId)];
    const root = t.root!;
    const folders = (await this.folders()).filter((f) => f.role !== 'DRAFT' && (includeTrashSpam || (f.role !== 'TRASH' && f.role !== 'SPAM')));
    const query: SearchObject = { or: [{ header: { 'message-id': root } }, { header: { references: root } }, { header: { 'in-reply-to': root } }] };
    const hits: Hit[] = [];
    for (const folder of folders) {
      await this.withLock(folder.path, async () => {
        const uidValidity = this.currentUidValidity();
        let uids: number[] = [];
        if (this.cfg.headerSearch !== false) {
          const r = await this.client.search(query, { uid: true }).catch(() => false as const);
          uids = Array.isArray(r) ? r.slice(-THREAD_SCAN_LIMIT) : [];
        }
        let matched = uids.length ? await this.matchThread(uids, root) : [];
        if (!matched.length) {
          const all = (await this.client.search({ all: true }, { uid: true })) || [];
          matched = await this.matchThread([...all].sort((x, y) => x - y).slice(-THREAD_SCAN_LIMIT), root);
        }
        for (const uid of matched) hits.push({ folder, uid, uidValidity });
      });
    }
    if (!hits.length && includeTrashSpam === false) return this.threadHits(threadId, true);
    if (!hits.length) throw new MailError(`대화를 찾지 못했습니다. 메일이 지워졌거나 메일함마다 최근 ${THREAD_SCAN_LIMIT}통보다 오래된 대화일 수 있습니다.`);
    return hits;
  }

  /** 선택된 메일함에서 헤더를 읽어 같은 대화인 UID만 남긴다 */
  private async matchThread(uids: number[], root: string): Promise<number[]> {
    if (!uids.length) return [];
    const out: number[] = [];
    for await (const msg of this.client.fetch(uids, { uid: true, headers: ['message-id', 'references', 'in-reply-to'] }, { uid: true })) {
      const mid = headerValue(msg.headers, 'message-id');
      const refs = `${headerValue(msg.headers, 'references') ?? ''} ${headerValue(msg.headers, 'in-reply-to') ?? ''}`;
      if (mid?.includes(root) || refs.includes(root)) out.push(msg.uid);
    }
    return out;
  }

  private checkValidity(hit: Hit) {
    if (hit.uidValidity !== '0' && hit.uidValidity !== this.currentUidValidity()) {
      throw new MailError('메일함이 다시 만들어져 메일 ID가 더 이상 맞지 않습니다. 다시 검색하세요.');
    }
  }

  async fetchFull(hit: Hit): Promise<{ msg: FetchMessageObject; parsed: Email }> {
    return this.withLock(hit.folder.path, async () => {
      this.checkValidity(hit);
      const msg = await this.client.fetchOne(String(hit.uid), { uid: true, flags: true, internalDate: true, size: true, source: true }, { uid: true });
      if (!msg || !msg.source) throw new MailError('메일을 찾지 못했습니다. 이미 옮겨졌거나 지워졌을 수 있습니다. 다시 검색하세요.');
      return { msg, parsed: await parseRaw(msg.source) };
    });
  }

  /** 메일함별로 묶어 한 번씩 가져온다 */
  async loadMessages(hits: Hit[], format: MessageFormat): Promise<MessageOut[]> {
    const fmt: MessageFormat = format === 'MESSAGE_FORMAT_UNSPECIFIED' ? 'FULL_CONTENT' : format;
    const byFolder = new Map<string, Hit[]>();
    for (const h of hits) byFolder.set(h.folder.path, [...(byFolder.get(h.folder.path) ?? []), h]);
    const out = new Map<string, MessageOut>();
    const wantBody = fmt === 'PLAIN_TEXT' || fmt === 'FULL_CONTENT' || fmt === 'RAW';
    for (const [path, group] of byFolder) {
      const folder = group[0]!.folder;
      await this.withLock(path, async () => {
        for (const h of group) this.checkValidity(h);
        const uidValidity = this.currentUidValidity();
        const query = {
          uid: true,
          flags: true,
          internalDate: true,
          size: true,
          envelope: true,
          headers: ['references', 'in-reply-to', 'message-id'],
          ...(wantBody ? { source: true } : fmt === 'MINIMAL' ? { source: { start: 0, maxLength: SNIPPET_BYTES } } : {}),
        };
        for await (const msg of this.client.fetch(group.map((h) => h.uid), query, { uid: true })) {
          const id = encodeMessageId(path, uidValidity, msg.uid);
          out.set(`${path}\0${msg.uid}`, await toMessageOut(msg, id, folder, fmt));
        }
      });
    }
    return hits.map((h) => out.get(`${h.folder.path}\0${h.uid}`)).filter((m): m is MessageOut => !!m);
  }

  async move(hit: Hit, dest: Folder): Promise<string | undefined> {
    if (dest.path === hit.folder.path) return encodeMessageId(hit.folder.path, hit.uidValidity, hit.uid);
    return this.withLock(hit.folder.path, async () => {
      this.checkValidity(hit);
      const res = await this.client.messageMove([hit.uid], dest.path, { uid: true });
      const newUid = res && res.uidMap?.get(hit.uid);
      if (res && newUid && res.uidValidity !== undefined) return encodeMessageId(dest.path, res.uidValidity, newUid);
      return undefined;
    });
  }

  /** 라벨 추가·제거 = 플래그 변경 + 메일함 이동 */
  async modify(hit: Hit, add: string[], remove: string[]) {
    const norm = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
    const addL = norm(add);
    const removeL = norm(remove);
    const notes: string[] = [];
    const flagOps: { add: string[]; remove: string[] } = { add: [], remove: [] };
    const folderAdds: Folder[] = [];
    const folderRemoves: Folder[] = [];
    const classify = async (label: string, adding: boolean) => {
      const u = label.toUpperCase();
      if (u === 'STARRED' || u === 'IMPORTANT') return (adding ? flagOps.add : flagOps.remove).push('\\Flagged');
      if (u === 'UNREAD') return (adding ? flagOps.remove : flagOps.add).push('\\Seen');
      if (u.startsWith('CATEGORY_')) return notes.push(`${label}: 네이버 메일에는 카테고리 탭이 없어 무시했습니다.`);
      if (u === 'SENT' || u === 'DRAFT') throw new MailError(`${label} 라벨은 직접 붙이거나 뗄 수 없습니다`);
      const f = await this.labelFolder(label);
      if (!f) throw new MailError(`라벨(메일함)을 찾지 못했습니다: ${label}. list_labels로 확인하세요.`);
      (adding ? folderAdds : folderRemoves).push(f);
    };
    for (const l of addL) await classify(l, true);
    for (const l of removeL) await classify(l, false);
    if (flagOps.add.length || flagOps.remove.length) {
      await this.withLock(hit.folder.path, async () => {
        this.checkValidity(hit);
        if (flagOps.add.length) await this.client.messageFlagsAdd([hit.uid], flagOps.add, { uid: true });
        if (flagOps.remove.length) await this.client.messageFlagsRemove([hit.uid], flagOps.remove, { uid: true });
      });
    }
    let target: Folder | undefined;
    const adds = folderAdds.filter((f) => f.path !== hit.folder.path);
    if (adds.length > 1) throw new MailError('네이버 메일에서 한 메일은 한 메일함에만 있을 수 있어, 메일함 라벨은 한 번에 하나만 붙일 수 있습니다');
    if (adds.length === 1) target = adds[0];
    else if (folderRemoves.some((f) => f.path === hit.folder.path)) {
      if (hit.folder.role === 'INBOX') throw new MailError('네이버 메일에는 보관(archive) 기능이 없습니다. 받은메일함에서 빼려면 옮길 메일함 라벨을 함께 붙이세요.');
      target = await this.roleFolder('INBOX');
    }
    let id = encodeMessageId(hit.folder.path, hit.uidValidity, hit.uid);
    let folder = hit.folder;
    if (target) {
      const moved = await this.move(hit, target);
      folder = target;
      if (moved) id = moved;
      else {
        notes.push('메일함을 옮겼지만 서버가 새 ID를 알려 주지 않았습니다. 다시 검색해 새 id를 얻으세요.');
        id = '';
      }
    }
    return { id: id || undefined, folder: folder.path, labelIds: id ? await this.labelsOf(id) : undefined, ...(notes.length ? { notes } : {}) };
  }

  async restore(hit: Hit, from: 'TRASH' | 'SPAM') {
    if (hit.folder.role !== from) throw new MailError(`이 메일은 ${FOLDER_LABEL_NAMES[from]}에 있지 않습니다`);
    const { parsed } = await this.fetchFull(hit);
    const mine = lower(parsed.from?.address ?? '') === lower(this.account.email);
    const dest = await this.roleFolder(mine ? 'SENT' : 'INBOX').catch(() => this.roleFolder('INBOX'));
    const id = await this.move(hit, dest);
    return { id, folder: dest.path };
  }

  async labelsOf(id: string): Promise<string[]> {
    const hit = await this.resolve(id);
    return this.withLock(hit.folder.path, async () => {
      const msg = await this.client.fetchOne(String(hit.uid), { uid: true, flags: true }, { uid: true });
      return labelIds(hit.folder, msg ? msg.flags : undefined);
    });
  }

  async append(role: FolderRole, raw: string, flags: string[]): Promise<{ id?: string; folder: string }> {
    const folder = await this.roleFolder(role);
    const res = await this.client.append(folder.path, raw, flags, new Date());
    if (res && res.uid && res.uidValidity !== undefined) return { id: encodeMessageId(folder.path, res.uidValidity, res.uid), folder: folder.path };
    // UIDPLUS가 없으면 방금 넣은 메일을 Message-ID로 찾는다
    const mid = /^Message-ID:\s*(\S+)/im.exec(raw)?.[1];
    if (!mid) return { folder: folder.path };
    return this.withLock(folder.path, async () => {
      const uids = (await this.client.search({ header: { 'message-id': mid } }, { uid: true })) || [];
      const uid = uids.at(-1);
      return { id: uid ? encodeMessageId(folder.path, this.currentUidValidity(), uid) : undefined, folder: folder.path };
    });
  }

  async saveDraft(out: Outgoing) {
    const built = buildMessage({ ...out, keepBcc: true });
    const saved = await this.append('DRAFT', built.raw, ['\\Draft', '\\Seen']);
    const root = threadRoot({ messageId: built.messageId, inReplyTo: out.inReplyTo, references: out.references?.join(' ') });
    return { id: saved.id, threadId: saved.id ? encodeThreadId(root, saved.id) : undefined, folder: saved.folder, message: { subject: out.subject, toRecipients: out.to?.map(addrString), ccRecipients: out.cc?.map(addrString), bccRecipients: out.bcc?.map(addrString) } };
  }

  /** SMTP로 보내고 보낸메일함에 사본 저장 */
  async deliver(out: Outgoing, cfg: MailConfig) {
    if (!out.to?.length && !out.cc?.length && !out.bcc?.length) throw new MailError('받는 사람(to, cc, bcc 중 하나)이 필요합니다');
    const date = new Date();
    const sending = buildMessage({ ...out, date });
    await sendMail(
      { host: cfg.smtpHost, port: cfg.smtpPort, user: this.account.login, password: this.account.password, insecure: cfg.insecureTls },
      { from: this.account.email, to: sending.recipients },
      sending.raw,
    );
    let saved: { id?: string; folder?: string } = {};
    if (cfg.saveSentCopy) {
      const copy = buildMessage({ ...out, date, messageId: sending.messageId, keepBcc: true });
      saved = await this.append('SENT', copy.raw, ['\\Seen']).catch((e: Error) => ({ error: `보냈지만 보낸메일함 저장에 실패했습니다: ${e.message}` }) as never);
    }
    const root = threadRoot({ messageId: sending.messageId, inReplyTo: out.inReplyTo, references: out.references?.join(' ') });
    return {
      id: saved.id,
      threadId: encodeThreadId(root, saved.id ?? sending.messageId),
      labelIds: saved.id ? ['SENT'] : undefined,
      messageIdHeader: sending.messageId,
      recipients: sending.recipients,
      ...saved,
    };
  }

  async sendDraft(draftId: string, cfg: MailConfig) {
    const hit = await this.resolve(draftId);
    if (hit.folder.role !== 'DRAFT') throw new MailError('임시보관함의 메일만 draftId로 보낼 수 있습니다');
    const { parsed } = await this.fetchFull(hit);
    const res = await this.deliver(
      {
        from: { name: this.account.displayName, address: this.account.email },
        to: toAddresses(parsed.to),
        cc: toAddresses(parsed.cc),
        bcc: toAddresses(parsed.bcc),
        subject: parsed.subject ?? '',
        text: parsed.text ?? undefined,
        html: parsed.html ?? undefined,
        attachments: parsed.attachments.map((x) => ({ content: Buffer.from(x.content as ArrayBuffer).toString('base64'), filename: x.filename ?? undefined, mimeType: x.mimeType, inline: x.disposition === 'inline' && !!x.contentId })),
        inReplyTo: parsed.inReplyTo ?? undefined,
        references: (parsed.references ?? '').match(/<[^>]+>/g) ?? undefined,
      },
      cfg,
    );
    await this.withLock(hit.folder.path, () => this.client.messageDelete([hit.uid], { uid: true }));
    return { ...res, sentDraftId: draftId };
  }
}

const addrString = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);
const toAddresses = (list: Email['to']): Address[] => addresses(list).map((a) => ({ name: a.name, address: a.address }));

interface StructureNode {
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

/** 메일 구조에 첨부(파일 이름이 있거나 attachment로 표시된 부분)가 있는지. filename이 있으면 이름에 그 글자가 든 첨부만 */
export function hasAttachment(node: StructureNode | undefined, filename?: string): boolean {
  if (!node) return false;
  if (node.childNodes?.length) return node.childNodes.some((c) => hasAttachment(c, filename));
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  const isAttachment = node.disposition?.toLowerCase() === 'attachment' || (!!name && !/^text\/(plain|html)$/i.test(node.type ?? ''));
  if (!isAttachment) return false;
  return !filename || (name ?? '').toLowerCase().includes(filename.toLowerCase());
}

function labelIds(folder: Folder, flags: Set<string> | undefined): string[] {
  const ids = [folder.role ?? folder.path];
  if (flags && !flags.has('\\Seen')) ids.push('UNREAD');
  if (flags?.has('\\Flagged')) ids.push('STARRED');
  return ids;
}

async function toMessageOut(msg: FetchMessageObject, id: string, folder: Folder, fmt: MessageFormat): Promise<MessageOut> {
  const env = msg.envelope;
  const refs = headerValue(msg.headers, 'references');
  const irt = headerValue(msg.headers, 'in-reply-to');
  const mid = headerValue(msg.headers, 'message-id') ?? env?.messageId;
  const root = threadRoot({ messageId: mid, inReplyTo: irt, references: refs });
  const parsed = msg.source ? await parseRaw(msg.source).catch(() => undefined) : undefined;
  const from = parsed?.from ? addresses([parsed.from]) : envelopeAddrs(env?.from);
  const list = (p: Email['to'] | undefined, e: MessageAddressObject[] | undefined) => (p?.length ? addresses(p) : envelopeAddrs(e)).map(formatAddr);
  const out: MessageOut = {
    id,
    threadId: encodeThreadId(root, id),
    sender: from[0] ? formatAddr(from[0]) : undefined,
    toRecipients: list(parsed?.to, env?.to),
    ccRecipients: list(parsed?.cc, env?.cc),
    bccRecipients: list(parsed?.bcc, env?.bcc),
    date: (toDate(env?.date) ?? toDate(msg.internalDate))?.toISOString(),
    labelIds: labelIds(folder, msg.flags),
    sizeEstimate: msg.size,
  };
  if (fmt === 'METADATA_ONLY') return out;
  out.subject = parsed?.subject ?? env?.subject ?? '';
  if (parsed) out.snippet = snippetOf(parsed);
  if (fmt === 'MINIMAL') return out;
  if (fmt === 'RAW') {
    const raw = msg.source?.toString('utf8') ?? '';
    out.raw = raw.length > RAW_LIMIT ? `${raw.slice(0, RAW_LIMIT)}\n…(잘림)` : raw;
    return out;
  }
  if (parsed) {
    out.plaintextBody = plainBody(parsed);
    out.attachments = parsed.attachments.map((a, i) => ({
      attachmentId: String(i),
      filename: a.filename ?? undefined,
      mimeType: a.mimeType,
      size: (a.content as ArrayBuffer).byteLength,
      ...(a.disposition === 'inline' ? { inline: true } : {}),
    }));
    out.attachmentIds = out.attachments.map((a) => a.attachmentId);
    if (fmt === 'FULL_CONTENT' && parsed.html) out.htmlBody = parsed.html.length > HTML_LIMIT ? `${parsed.html.slice(0, HTML_LIMIT)}<!-- 잘림 -->` : parsed.html;
  }
  return out;
}

export function prefixSubject(prefix: 'Re: ' | 'Fwd: ', subject: string | undefined): string {
  const s = (subject ?? '').trim();
  const re = prefix === 'Re: ' ? /^(re|회신|답장)\s*:/i : /^(fwd?|전달)\s*:/i;
  return re.test(s) ? s : `${prefix}${s}`;
}

export function replyThreading(parsed: Email): Pick<Outgoing, 'inReplyTo' | 'references'> {
  const mid = parsed.messageId?.match(/<[^>]+>/)?.[0];
  const refs = (parsed.references ?? '').match(/<[^>]+>/g) ?? (parsed.inReplyTo ? (parsed.inReplyTo.match(/<[^>]+>/g) ?? []) : []);
  return { inReplyTo: mid, references: mid ? uniq([...refs, mid]) : refs };
}

/** 답장 받는 사람: Reply-To > From. 내가 보낸 메일에 답하면 원래 받는 사람에게 */
export function replyRecipients(parsed: Email, self: string, all: boolean): { to: string[]; cc: string[] } {
  const me = lower(self);
  const from = addresses(parsed.replyTo?.length ? parsed.replyTo : parsed.from ? [parsed.from] : []);
  const origTo = addresses(parsed.to);
  const origCc = addresses(parsed.cc);
  const fromMe = from.every((a) => lower(a.address) === me);
  let to = fromMe ? origTo : from;
  if (!to.length) to = from;
  let cc: AddressOut[] = [];
  if (all) {
    const toSet = new Set(to.map((a) => lower(a.address)));
    cc = [...(fromMe ? [] : origTo), ...origCc].filter((a) => lower(a.address) !== me && !toSet.has(lower(a.address)));
  }
  const dedupe = (xs: AddressOut[]) => xs.filter((a, i) => xs.findIndex((b) => lower(b.address) === lower(a.address)) === i).map(formatAddr);
  return { to: dedupe(to), cc: dedupe(cc) };
}

function kstString(date: string | undefined): string {
  const d = date ? new Date(date) : undefined;
  if (!d || Number.isNaN(d.getTime())) return date ?? '';
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 답장 본문 아래에 원문을 인용한다 (Gmail과 같은 방식) */
export function quoteOriginal(parsed: Email, body: string | undefined, html: string | undefined): { text: string; html?: string } {
  const sender = parsed.from ? formatAddr(addresses([parsed.from])[0] ?? { address: '' }) : '';
  const header = `${kstString(parsed.date)}, ${sender} 작성:`;
  const original = plainBody(parsed);
  const text = `${body ?? (html ? htmlToText(html) : '')}\n\n${header}\n${original.split('\n').map((l) => `> ${l}`).join('\n')}`;
  if (!html) return { text };
  const origHtml = parsed.html ?? `<pre>${escapeHtml(original)}</pre>`;
  return { text, html: `${html}<br><br><div>${escapeHtml(header)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${origHtml}</blockquote>` };
}

export function forwardBody(parsed: Email, note: string | undefined, html: string | undefined): { text: string; html?: string } {
  const lines = [
    '---------- 전달된 메시지 ----------',
    `보낸사람: ${parsed.from ? formatAddr(addresses([parsed.from])[0] ?? { address: '' }) : ''}`,
    `날짜: ${kstString(parsed.date)}`,
    `제목: ${parsed.subject ?? ''}`,
    `받는사람: ${addresses(parsed.to).map(formatAddr).join(', ')}`,
    ...(parsed.cc?.length ? [`참조: ${addresses(parsed.cc).map(formatAddr).join(', ')}`] : []),
  ];
  const text = `${note ?? (html ? htmlToText(html) : '')}\n\n${lines.join('\n')}\n\n${plainBody(parsed)}`;
  if (!html && !parsed.html) return { text };
  const top = html ?? (note ? `<div>${escapeHtml(note).replace(/\n/g, '<br>')}</div>` : '');
  return { text, html: `${top}<br><br><div>${lines.map(escapeHtml).join('<br>')}</div><br>${parsed.html ?? `<pre>${escapeHtml(plainBody(parsed))}</pre>`}` };
}

export const LABEL_HELP = SYSTEM_LABELS.join(', ');
