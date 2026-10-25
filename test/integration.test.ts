import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { naverAccount, type MailConfig } from '../src/mail/imap';
import { NaverMailService } from '../src/mail/service';

/**
 * 가짜 IMAP(hoodiecrow)·SMTP(smtp-server) 서버로 네이버 메일 흐름 전체를 돌린다.
 * 메일함 이름은 네이버처럼 한글이고 특수 용도 표시가 없다 (이름으로 역할을 찾아야 함).
 */

const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');

/** IMAP modified UTF-7 (RFC 3501 5.1.3) */
function utf7(s: string): string {
  return s.replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (run) => {
    const buf = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) buf.writeUInt16BE(run.charCodeAt(i), i * 2);
    return `&${buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  });
}

const eucKr = (s: string) => {
  // 테스트 문자열만 다루는 작은 EUC-KR 인코더: TextDecoder로 역표를 만든다
  const dec = new TextDecoder('euc-kr');
  const table = new Map<string, number[]>();
  for (let hi = 0xb0; hi <= 0xc8; hi++)
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      const ch = dec.decode(new Uint8Array([hi, lo]));
      if (ch.length === 1) table.set(ch, [hi, lo]);
    }
  const bytes: number[] = [];
  for (const ch of s) bytes.push(...(table.get(ch) ?? [ch.charCodeAt(0)]));
  return Buffer.from(bytes);
};

const MSG_EUCKR = Buffer.concat([
  Buffer.from(
    'From: =?euc-kr?B?' + eucKr('김철수').toString('base64') + '?= <alice@example.com>\r\n' +
      'To: testuser@naver.com\r\n' +
      'Subject: =?ks_c_5601-1987?B?' + eucKr('회의 일정 안내').toString('base64') + '?=\r\n' +
      'Date: Mon, 20 Oct 2026 09:00:00 +0900\r\n' +
      'Message-ID: <euckr-1@example.com>\r\n' +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/plain; charset="cp949"\r\n' +
      'Content-Transfer-Encoding: 8bit\r\n\r\n',
    'latin1',
  ),
  eucKr('내일 오후 3시에 회의가 있습니다.'),
  Buffer.from('\r\n'),
]).toString('latin1');

const MSG_BANK = [
  'From: Bank <noreply@bank.example>',
  'To: testuser@naver.com',
  'Subject: =?UTF-8?B?' + Buffer.from('카드 명세서').toString('base64') + '?=',
  'Date: Tue, 21 Oct 2026 10:00:00 +0900',
  'Message-ID: <bank-1@bank.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<html><body><p>이번 달 결제 금액은 <b>123,000원</b>입니다.</p><a href="https://bank.example/d">자세히</a></body></html>').toString('base64'),
  '--b1',
  'Content-Type: text/plain; name="statement.txt"',
  'Content-Disposition: attachment; filename="statement.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('total=123000').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

const plain = (headers: string[], body: string) => [...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body, ''].join('\r\n');

const THREAD_A = plain(['From: Bob <bob@example.com>', 'To: testuser@naver.com', 'Subject: 견적 요청', 'Date: Wed, 22 Oct 2026 09:00:00 +0900', 'Message-ID: <a@example.com>'], '견적서 부탁드립니다.');
const THREAD_MY = plain(
  ['From: testuser@naver.com', 'To: Bob <bob@example.com>', 'Subject: Re: 견적 요청', 'Date: Wed, 22 Oct 2026 10:00:00 +0900', 'Message-ID: <my@naver.com>', 'In-Reply-To: <a@example.com>', 'References: <a@example.com>'],
  '내일 보내드리겠습니다.',
);
const THREAD_B = plain(
  ['From: Bob <bob@example.com>', 'To: testuser@naver.com', 'Cc: Carol <carol@example.com>', 'Subject: Re: 견적 요청', 'Date: Thu, 23 Oct 2026 09:00:00 +0900', 'Message-ID: <b@example.com>', 'In-Reply-To: <my@naver.com>', 'References: <a@example.com> <my@naver.com>'],
  '감사합니다. 기다리겠습니다.',
);

function storage() {
  return {
    INBOX: {
      messages: [
        { raw: MSG_EUCKR, flags: [], internaldate: '20-Oct-2026 09:00:00 +0900' },
        { raw: MSG_BANK, flags: ['\\Seen'], internaldate: '21-Oct-2026 10:00:00 +0900' },
        { raw: THREAD_A, flags: ['\\Seen'], internaldate: '22-Oct-2026 09:00:00 +0900' },
        { raw: THREAD_B, flags: [], internaldate: '23-Oct-2026 09:00:00 +0900' },
      ],
    },
    '': {
      separator: '/',
      folders: {
        [utf7('보낸메일함')]: { messages: [{ raw: THREAD_MY, flags: ['\\Seen'], internaldate: '22-Oct-2026 10:00:00 +0900' }] },
        [utf7('임시보관함')]: {},
        [utf7('휴지통')]: {},
        [utf7('스팸메일함')]: {},
        [utf7('업무')]: {},
      },
    },
  };
}

let imap: { listen: (p: number, cb: () => void) => void; close: (cb: () => void) => void; address: () => AddressInfo };
let smtp: SMTPServer;
let smtpPort = 0;
const sent: { from: string; to: string[]; raw: string }[] = [];
let svc: NaverMailService;

async function startImap() {
  imap = hoodiecrow({ plugins: ['ID', 'ENABLE', 'UIDPLUS', 'MOVE', 'UNSELECT', 'LITERALPLUS', 'NAMESPACE'], secureConnection: true, storage: storage() });
  await new Promise<void>((r) => imap.listen(0, r));
  const cfg: MailConfig = { imapHost: '127.0.0.1', imapPort: imap.address().port, smtpHost: '127.0.0.1', smtpPort, saveSentCopy: true, insecureTls: true };
  svc = new NaverMailService(naverAccount('testuser', 'testpass', '테스트 사용자'), cfg);
}

beforeAll(async () => {
  smtp = new SMTPServer({
    secure: true,
    authMethods: ['PLAIN'],
    onAuth(auth, _s, cb) {
      if (auth.username === 'testuser' && auth.password === 'testpass') cb(null, { user: 'testuser' });
      else cb(new Error('bad auth'));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        sent.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
        cb();
      });
    },
    logger: false,
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => smtp.close(r));
});

beforeEach(async () => {
  if (imap) await new Promise<void>((r) => imap.close(r));
  sent.length = 0;
  await startImap();
});

const findThread = async (q: string) => {
  const r = await svc.searchThreads({ query: q });
  return r.threads;
};

describe('읽기', () => {
  it('프로필과 메일함 역할(한글 이름)을 찾는다', async () => {
    const p = await svc.getProfile();
    expect(p.emailAddress).toBe('testuser@naver.com');
    expect(p.unreadInInbox).toBe(2);
    const { labels } = await svc.listLabels();
    const byId = Object.fromEntries(labels.map((l) => [l.id, l.folderPath]));
    expect(byId.SENT).toBe('보낸메일함');
    expect(byId.DRAFT).toBe('임시보관함');
    expect(byId.TRASH).toBe('휴지통');
    expect(byId.SPAM).toBe('스팸메일함');
    expect(byId['업무']).toBe('업무');
  });

  it('검색 결과를 대화로 묶고 최신순으로 준다 (보낸메일함 포함)', async () => {
    const threads = await findThread('');
    expect(threads.map((t) => t.messageCount)).toEqual([3, 1, 1]);
    expect(threads[0]!.messages[0]!.subject).toBe('Re: 견적 요청');
    expect(threads[2]!.messages[0]!.subject).toBe('회의 일정 안내');
    expect(threads[2]!.messages[0]!.sender).toBe('김철수 <alice@example.com>');
    expect(threads[2]!.messages[0]!.snippet).toContain('내일 오후 3시');
    expect(threads[2]!.messages[0]!.labelIds).toEqual(['INBOX', 'UNREAD']);
  });

  it('Gmail 검색 문법: from:, is:unread, in:sent, has:attachment, 날짜, 제외', async () => {
    expect((await findThread('from:alice')).length).toBe(1);
    const unread = await findThread('is:unread');
    expect(unread.flatMap((t) => t.messages.map((m) => m.subject)).sort()).toEqual(['Re: 견적 요청', '회의 일정 안내']);
    const sentOnly = await findThread('in:sent');
    expect(sentOnly.flatMap((t) => t.messages.map((m) => m.labelIds[0]))).toEqual(['SENT']);
    expect((await findThread('has:attachment'))[0]!.messages[0]!.subject).toBe('카드 명세서');
    expect((await findThread('after:2026/10/22 before:2026/10/23')).flatMap((t) => t.messages).length).toBe(2);
    expect((await findThread('-from:bob in:inbox')).flatMap((t) => t.messages).length).toBe(2);
    expect((await findThread('from:alice OR from:bank')).length).toBe(2);
  });

  it('한글 낱말은 제목·보낸 사람·본문에서 찾고, 첨부는 메일 구조로 거른다', async () => {
    expect((await findThread('견적')).length).toBe(1);
    expect((await findThread('기다리겠습니다')).flatMap((t) => t.messages.map((m) => m.subject))).toEqual(['Re: 견적 요청']);
    expect((await findThread('filename:statement'))[0]!.messages[0]!.subject).toBe('카드 명세서');
    expect((await findThread('filename:nothing')).length).toBe(0);
    expect((await findThread('-has:attachment in:inbox')).flatMap((t) => t.messages).length).toBe(3);
  });

  it('페이지를 넘긴다', async () => {
    const p1 = await svc.searchThreads({ query: '', pageSize: 2 });
    expect(p1.nextPageToken).toBe('2');
    const p2 = await svc.searchThreads({ query: '', pageSize: 2, pageToken: p1.nextPageToken });
    const ids = [...p1.threads, ...p2.threads].flatMap((t) => t.messages.map((m) => m.id));
    expect(new Set(ids).size).toBe(4);
  });

  it('대화 전체를 메일함을 넘어 시간순으로 읽는다', async () => {
    const [t] = await findThread('subject:견적');
    const thread = await svc.getThread(t!.id, 'PLAIN_TEXT');
    expect(thread.messages.map((m) => m.plaintextBody)).toEqual(['견적서 부탁드립니다.', '내일 보내드리겠습니다.', '감사합니다. 기다리겠습니다.']);
    expect(thread.messages[1]!.labelIds[0]).toBe('SENT');
  });

  it('EUC-KR(cp949 표기) 본문과 HTML만 있는 메일을 텍스트로 읽고 첨부를 내려받는다', async () => {
    const [t] = await findThread('from:alice');
    const m = await svc.getMessage(t!.messages[0]!.id, 'PLAIN_TEXT');
    expect(m!.plaintextBody).toBe('내일 오후 3시에 회의가 있습니다.');
    const [bank] = await findThread('from:bank');
    const b = await svc.getMessage(bank!.messages[0]!.id, 'FULL_CONTENT');
    expect(b!.plaintextBody).toContain('123,000원');
    expect(b!.plaintextBody).toContain('자세히 (https://bank.example/d)');
    expect(b!.htmlBody).toContain('<b>123,000원</b>');
    expect(b!.attachments).toEqual([{ attachmentId: '0', filename: 'statement.txt', mimeType: 'text/plain', size: 12 }]);
    const att = await svc.getAttachment(b!.id, '0');
    expect(att.text).toBe('total=123000');
  });
});

describe('HEADER 검색이 안 되는 서버 (네이버)', () => {
  it('대화를 헤더를 직접 읽어 묶고, 답장도 같은 대화로 이어진다', async () => {
    const naverLike = new NaverMailService(svc.account, { ...svc.cfg, headerSearch: false });
    const [t] = (await naverLike.searchThreads({ query: 'subject:견적' })).threads;
    const thread = await naverLike.getThread(t!.id, 'METADATA_ONLY');
    expect(thread.messages).toHaveLength(3);
    const r = await naverLike.reply({ messageId: thread.messages.at(-1)!.id, body: '확인했습니다.' });
    expect((await naverLike.getThread(r.threadId, 'METADATA_ONLY')).messages).toHaveLength(4);
  });
});

describe('정리', () => {
  it('별표·읽음 표시, 사용자 메일함으로 이동, 휴지통 넣고 꺼내기', async () => {
    const [t] = await findThread('from:alice');
    const id = t!.messages[0]!.id;
    const r1 = await svc.updateMessageLabels(id, ['STARRED'], ['UNREAD']);
    expect(r1.labelIds).toEqual(['INBOX', 'STARRED']);
    const moved = await svc.updateMessageLabels(id, ['업무'], []);
    expect(moved.folder).toBe('업무');
    expect(moved.labelIds).toEqual(['업무', 'STARRED']);
    expect((await findThread('label:업무')).length).toBe(1);
    const trashed = await svc.updateMessageLabels(moved.id!, ['TRASH'], []);
    expect(trashed.folder).toBe('휴지통');
    expect((await findThread('from:alice')).length).toBe(0);
    const back = await svc.restoreMessage(trashed.id!, 'TRASH');
    expect(back.folder).toBe('INBOX');
  });

  it('보관(받은메일함에서 빼기)은 네이버에 없어서 안내한다', async () => {
    const [t] = await findThread('from:alice');
    await expect(svc.updateMessageLabels(t!.messages[0]!.id, [], ['INBOX'])).rejects.toThrow('보관');
  });

  it('대화 전체를 읽음 처리하고 스팸으로 보낸다', async () => {
    const [t] = await findThread('subject:견적');
    await svc.updateThreadLabels(t!.id, [], ['UNREAD']);
    expect((await findThread('is:unread')).length).toBe(1);
    await svc.updateThreadLabels(t!.id, ['SPAM'], []);
    expect((await findThread('in:spam')).flatMap((x) => x.messages).length).toBe(3);
  });

  it('라벨(메일함)을 만들고 이름을 바꾸고 지운다', async () => {
    await svc.createLabel('프로젝트/알파');
    let { labels } = await svc.listLabels();
    expect(labels.map((l) => l.id)).toContain('프로젝트/알파');
    await svc.updateLabel('프로젝트/알파', '프로젝트/베타');
    await svc.deleteLabel('프로젝트/베타');
    ({ labels } = await svc.listLabels());
    expect(labels.map((l) => l.id)).not.toContain('프로젝트/베타');
  });
});

describe('보내기', () => {
  it('새 메일을 보내고 보낸메일함에 사본을 남긴다 (숨은참조는 헤더에서 뺀다)', async () => {
    const r = await svc.sendMessage({ to: ['dave@example.com'], bcc: ['eve@example.com'], subject: '안녕하세요', body: '한글 본문입니다.\n.점으로 시작하는 줄' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe('testuser@naver.com');
    expect(sent[0]!.to).toEqual(['dave@example.com', 'eve@example.com']);
    expect(sent[0]!.raw).not.toMatch(/^Bcc:/im);
    expect(sent[0]!.raw).toContain('=?UTF-8?B?');
    const copy = await svc.getMessage(r.id!, 'PLAIN_TEXT');
    expect(copy!.subject).toBe('안녕하세요');
    expect(copy!.plaintextBody).toBe('한글 본문입니다.\n.점으로 시작하는 줄');
    expect(copy!.bccRecipients).toEqual(['eve@example.com']);
    expect(copy!.sender).toBe('테스트 사용자 <testuser@naver.com>');
  });

  it('전체 답장: 받는 사람·참조·제목·스레드 헤더·원문 인용', async () => {
    const thread = await svc.getThread((await findThread('subject:견적'))[0]!.id, 'METADATA_ONLY');
    const last = thread.messages.at(-1)!;
    const r = await svc.reply({ messageId: last.id, body: '자료 첨부합니다.', replyAll: true });
    const raw = sent[0]!.raw;
    expect(sent[0]!.to).toEqual(['bob@example.com', 'carol@example.com']);
    expect(raw).toMatch(/^In-Reply-To: <b@example\.com>/m);
    expect(raw).toMatch(/References: <a@example\.com>\r\n <my@naver\.com>\r\n <b@example\.com>/);
    const copy = await svc.getMessage(r.id!, 'PLAIN_TEXT');
    expect(copy!.subject).toBe('Re: 견적 요청');
    expect(copy!.plaintextBody).toContain('> 감사합니다. 기다리겠습니다.');
    // 답장은 같은 대화로 묶인다
    expect(copy!.threadId).toBe(last.threadId);
    expect((await svc.getThread(last.threadId, 'METADATA_ONLY')).messages).toHaveLength(4);
  });

  it('전달하면 원래 첨부가 따라간다', async () => {
    const [bank] = await findThread('from:bank');
    await svc.forward({ messageId: bank!.messages[0]!.id, to: ['me2@example.com'], forwardText: '확인 부탁해요' });
    const raw = sent[0]!.raw;
    expect(raw).toContain('filename="statement.txt"');
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it('임시보관: 만들기 → 고치기 → 목록 → 보내기', async () => {
    const d = await svc.createDraft({ to: ['frank@example.com'], subject: '초안', body: '첫 버전' });
    expect(d.id).toBeTruthy();
    const u = await svc.updateDraft({ draftId: d.id!, body: '둘째 버전' });
    expect(u.id).not.toBe(d.id);
    const list = await svc.listDrafts({ view: 'DRAFT_VIEW_FULL' });
    expect(list.drafts).toHaveLength(1);
    expect((list.drafts[0] as { plaintextBody?: string; subject?: string }).plaintextBody).toBe('둘째 버전');
    expect((list.drafts[0] as { subject?: string }).subject).toBe('초안');
    await svc.sendMessage({ draftId: u.id! });
    expect(sent[0]!.to).toEqual(['frank@example.com']);
    expect((await svc.listDrafts({})).drafts).toHaveLength(0);
    // (가짜 서버는 인코딩된 제목을 검색하지 못해 받는 사람으로 찾는다)
    expect((await findThread('in:sent to:frank')).length).toBe(1);
  });

  it('답장 초안은 받는 사람이 원래 보낸 사람으로 채워지고 원문을 인용한다', async () => {
    const [t] = await findThread('from:alice');
    const d = await svc.createDraft({ replyToMessageId: t!.messages[0]!.id, body: '참석하겠습니다.' });
    const m = await svc.getMessage(d.id!, 'PLAIN_TEXT');
    expect(m!.toRecipients).toEqual(['김철수 <alice@example.com>']);
    expect(m!.subject).toBe('Re: 회의 일정 안내');
    expect(m!.plaintextBody).toContain('> 내일 오후 3시에 회의가 있습니다.');
  });
});
