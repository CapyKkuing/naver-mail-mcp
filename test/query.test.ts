import { describe, expect, it } from 'vitest';
import { parseGmailQuery } from '../src/mail/query';

const now = new Date('2026-10-25T00:00:00Z');
const q = (s: string) => parseGmailQuery(s, now);

describe('Gmail 검색 문법 → IMAP', () => {
  it('빈 검색은 조건 없음', () => {
    expect(q('')).toEqual({ search: undefined, include: [], exclude: [], warnings: [] });
  });

  it('연산자와 키워드', () => {
    expect(q('from:alice@example.com').search).toEqual({ from: 'alice@example.com' });
    expect(q('is:unread').search).toEqual({ seen: false });
    expect(q('"회의 자료"').search).toEqual({ text: '회의 자료' });
    expect(q('subject:"분기 보고"').search).toEqual({ subject: '분기 보고' });
    expect(q('larger:5M').search).toEqual({ larger: 5 * 1024 * 1024 });
  });

  it('날짜: after는 그날 포함, newer_than은 상대 기간', () => {
    expect(q('after:2026/02/01').search).toEqual({ since: new Date('2026-02-01T00:00:00Z') });
    expect(q('newer_than:7d').search).toEqual({ since: new Date('2026-10-18T00:00:00Z') });
  });

  it('AND는 같은 키가 겹쳐도 이어 붙인다', () => {
    expect(q('from:a from:b').search).toEqual({ or: [{ from: 'a' }], not: { not: { from: 'b' } } });
  });

  it('OR, 중괄호, 제외, 괄호', () => {
    expect(q('from:a OR from:b').search).toEqual({ or: [{ from: 'a' }, { from: 'b' }] });
    expect(q('{from:a from:b}').search).toEqual({ or: [{ from: 'a' }, { from: 'b' }] });
    expect(q('-from:spam').search).toEqual({ not: { from: 'spam' } });
    expect(q('subject:(회의 자료)').search).toEqual({ or: [{ subject: '회의' }], not: { not: { subject: '자료' } } });
  });

  it('in:/label:은 검색할 메일함으로 뺀다', () => {
    const r = q('in:sent -in:trash label:업무 is:starred');
    expect(r.include).toEqual([{ kind: 'role', role: 'SENT' }, { kind: 'path', path: '업무' }]);
    expect(r.exclude).toEqual([{ kind: 'role', role: 'TRASH' }]);
    expect(r.search).toEqual({ flagged: true });
  });

  it('지원하지 않는 조건은 무시하고 알려 준다', () => {
    const r = q('category:promotions 할인');
    expect(r.search).toEqual({ text: '할인' });
    expect(r.warnings[0]).toContain('category:promotions');
  });
});
