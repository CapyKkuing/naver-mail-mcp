import type { SearchObject } from 'imapflow';

/**
 * Gmail 검색 문법(from:, after:, is:unread, OR, -, 괄호 …)을 IMAP SEARCH 조건으로 바꾼다.
 * IMAP으로 표현할 수 없는 in:/label:은 검색할 메일함(scope)으로 빼고,
 * 지원하지 않는 연산자(category: 등)는 무시하고 warnings에 남긴다.
 */

export type Scope = { kind: 'role'; role: FolderRole } | { kind: 'path'; path: string } | { kind: 'anywhere' };
export type FolderRole = 'INBOX' | 'SENT' | 'DRAFT' | 'TRASH' | 'SPAM';

export interface ParsedQuery {
  /** undefined면 조건 없음 (전체) */
  search?: SearchObject;
  include: Scope[];
  exclude: Scope[];
  /** has:attachment / filename:. 네이버 IMAP은 헤더 검색을 믿을 수 없어 메일 구조(BODYSTRUCTURE)로 따로 거른다 */
  attachment?: { required: boolean; filename?: string };
  warnings: string[];
}

type Node =
  | { t: 'leaf'; q: SearchObject }
  | { t: 'and'; c: Node[] }
  | { t: 'or'; c: Node[] }
  | { t: 'not'; c: Node }
  | { t: 'scope'; s: Scope }
  | { t: 'attach'; filename?: string }
  | { t: 'all' };

type Token = { k: 'word'; v: string; quoted: boolean; neg: boolean } | { k: 'op'; v: '(' | ')' | '{' | '}' | 'OR' | 'AND'; neg: boolean };

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    let neg = false;
    if (ch === '-' && i + 1 < input.length && !/\s/.test(input[i + 1]!)) {
      neg = true;
      i++;
    }
    const c = input[i]!;
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      out.push({ k: 'op', v: c, neg });
      i++;
      continue;
    }
    if (c === '"') {
      const end = input.indexOf('"', i + 1);
      const v = end < 0 ? input.slice(i + 1) : input.slice(i + 1, end);
      out.push({ k: 'word', v, quoted: true, neg });
      i = end < 0 ? input.length : end + 1;
      continue;
    }
    // op:"value" 처럼 따옴표 값이 붙은 단어는 한 토큰으로 읽는다
    let j = i;
    let word = '';
    while (j < input.length && !/\s/.test(input[j]!) && !'(){}'.includes(input[j]!)) {
      if (input[j] === '"' && word.endsWith(':')) {
        const end = input.indexOf('"', j + 1);
        word += input.slice(j + 1, end < 0 ? undefined : end);
        j = end < 0 ? input.length : end + 1;
        break;
      }
      word += input[j];
      j++;
    }
    i = j;
    if (!neg && (word === 'OR' || word === 'AND')) out.push({ k: 'op', v: word, neg: false });
    else if (word) out.push({ k: 'word', v: word.replace(/^\+/, ''), quoted: false, neg });
  }
  return out;
}

const DAY = 86_400_000;

function parseDate(v: string): Date | undefined {
  const m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(v);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (us) return new Date(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2])));
  if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000);
  return undefined;
}

function parseRelative(v: string, now: Date): Date | undefined {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const d = new Date(now);
  if (unit === 'd') return new Date(now.getTime() - n * DAY);
  if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
}

function parseSize(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(v);
  if (!m) return undefined;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * mult);
}

const ROLE_ALIASES: Record<string, FolderRole> = {
  inbox: 'INBOX',
  sent: 'SENT',
  draft: 'DRAFT',
  drafts: 'DRAFT',
  trash: 'TRASH',
  bin: 'TRASH',
  spam: 'SPAM',
  junk: 'SPAM',
};

class Parser {
  private pos = 0;
  readonly warnings: string[] = [];
  constructor(
    private readonly tokens: Token[],
    private readonly now: Date,
  ) {}

  parse(): Node {
    const n = this.orExpr();
    if (this.pos < this.tokens.length) this.warnings.push(`해석하지 못한 부분을 무시했습니다: ${this.tokens.slice(this.pos).map((t) => t.v).join(' ')}`);
    return n;
  }

  private peek() {
    return this.tokens[this.pos];
  }

  private orExpr(): Node {
    const parts = [this.andExpr()];
    while (this.peek()?.k === 'op' && this.peek()!.v === 'OR') {
      this.pos++;
      parts.push(this.andExpr());
    }
    return parts.length === 1 ? parts[0]! : { t: 'or', c: parts };
  }

  private andExpr(): Node {
    const parts: Node[] = [];
    for (;;) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.k === 'op' && (tok.v === ')' || tok.v === '}' || tok.v === 'OR')) break;
      if (tok.k === 'op' && tok.v === 'AND') {
        this.pos++;
        continue;
      }
      parts.push(this.unary());
    }
    if (parts.length === 0) return { t: 'all' };
    return parts.length === 1 ? parts[0]! : { t: 'and', c: parts };
  }

  private unary(): Node {
    const tok = this.tokens[this.pos++]!;
    let node: Node;
    if (tok.k === 'op' && tok.v === '(') {
      node = this.orExpr();
      this.expect(')');
    } else if (tok.k === 'op' && tok.v === '{') {
      const parts: Node[] = [];
      while (this.peek() && !(this.peek()!.k === 'op' && this.peek()!.v === '}')) parts.push(this.unary());
      this.expect('}');
      node = parts.length === 1 ? parts[0]! : { t: 'or', c: parts };
    } else if (tok.k === 'word') {
      node = this.term(tok);
    } else {
      node = { t: 'all' };
    }
    return tok.neg ? negate(node) : node;
  }

  private expect(v: string) {
    if (this.peek()?.k === 'op' && this.peek()!.v === v) this.pos++;
  }

  private term(tok: Extract<Token, { k: 'word' }>): Node {
    const m = tok.quoted ? null : /^([a-zA-Z_]+):(.*)$/.exec(tok.v);
    if (!m) return keyword(tok.v);
    const op = m[1]!.toLowerCase();
    let value = m[2]!;
    // subject:(회의 자료) → subject:회의 subject:자료
    if (value === '' && this.peek()?.k === 'op' && this.peek()!.v === '(') {
      this.pos++;
      const words: string[] = [];
      while (this.peek() && !(this.peek()!.k === 'op' && this.peek()!.v === ')')) {
        const w = this.tokens[this.pos++]!;
        if (w.k === 'word') words.push(w.v);
      }
      this.expect(')');
      const nodes = words.map((w) => this.operator(op, w));
      return nodes.length === 1 ? nodes[0]! : { t: 'and', c: nodes };
    }
    const next = this.peek();
    if (value === '' && next?.k === 'word' && next.quoted) value = (this.tokens[this.pos++] as { v: string }).v;
    return this.operator(op, value);
  }

  private operator(op: string, value: string): Node {
    const leaf = (q: SearchObject): Node => ({ t: 'leaf', q });
    const v = value.toLowerCase();
    switch (op) {
      case 'from':
      case 'to':
      case 'cc':
      case 'bcc':
      case 'subject':
        return leaf({ [op]: value });
      case 'deliveredto':
        return leaf({ header: { 'Delivered-To': value } });
      case 'list':
        return leaf({ header: { 'List-Id': value } });
      case 'rfc822msgid':
        return leaf({ header: { 'Message-ID': value } });
      case 'after':
      case 'newer': {
        const d = parseDate(value);
        if (d) return leaf({ since: d });
        break;
      }
      case 'before':
      case 'older': {
        const d = parseDate(value);
        if (d) return leaf({ before: d });
        break;
      }
      case 'newer_than': {
        const d = parseRelative(value, this.now);
        if (d) return leaf({ since: d });
        break;
      }
      case 'older_than': {
        const d = parseRelative(value, this.now);
        if (d) return leaf({ before: d });
        break;
      }
      case 'larger':
      case 'size': {
        const n = parseSize(value);
        if (n !== undefined) return leaf({ larger: n });
        break;
      }
      case 'smaller': {
        const n = parseSize(value);
        if (n !== undefined) return leaf({ smaller: n });
        break;
      }
      case 'is':
        if (v === 'unread') return leaf({ seen: false });
        if (v === 'read') return leaf({ seen: true });
        if (v === 'starred') return leaf({ flagged: true });
        if (v === 'unstarred') return leaf({ flagged: false });
        if (v === 'important') {
          this.warnings.push('is:important는 네이버 메일에 없어 is:starred(중요 표시)로 바꿔 찾았습니다.');
          return leaf({ flagged: true });
        }
        if (v === 'answered' || v === 'replied') return leaf({ answered: true });
        break;
      case 'has':
        if (v === 'attachment') return { t: 'attach' };
        if (/^(yellow|red|orange|green|blue|purple)-star$/.test(v) || v === 'star') return leaf({ flagged: true });
        break;
      case 'filename':
        return { t: 'attach', filename: value };
      case 'in':
      case 'label': {
        if (v === 'anywhere' || v === 'all') return { t: 'scope', s: { kind: 'anywhere' } };
        const role = ROLE_ALIASES[v];
        if (role) return { t: 'scope', s: { kind: 'role', role } };
        if (v === 'starred') return leaf({ flagged: true });
        if (v === 'unread') return leaf({ seen: false });
        if (v === 'important') return leaf({ flagged: true });
        if (v === 'archive' || v === 'snoozed' || v === 'chats') break;
        return { t: 'scope', s: { kind: 'path', path: value } };
      }
    }
    this.warnings.push(`네이버 메일에서 지원하지 않는 검색 조건이라 무시했습니다: ${op}:${value}`);
    return { t: 'all' };
  }
}

/**
 * 낱말 검색. 네이버 IMAP의 TEXT 검색은 한글을 찾지 못해서(실제 계정에서 확인),
 * Gmail처럼 제목·보낸 사람·본문을 각각 찾아 합친다.
 */
function keyword(w: string): Node {
  return { t: 'leaf', q: { or: [{ subject: w }, { from: w }, { body: w }] } };
}

function negate(n: Node): Node {
  if (n.t === 'all') return n;
  if (n.t === 'not') return n.c;
  return { t: 'not', c: n };
}

/** in:/label:은 맨 바깥 AND에서만 메일함 범위로 쓴다 */
function extractScopes(root: Node, warnings: string[]) {
  const include: Scope[] = [];
  const exclude: Scope[] = [];
  let attachment: ParsedQuery['attachment'];
  const top = root.t === 'and' ? root.c : [root];
  const rest: Node[] = [];
  for (const n of top) {
    if (n.t === 'scope') include.push(n.s);
    else if (n.t === 'not' && n.c.t === 'scope') exclude.push(n.c.s);
    else if (n.t === 'attach') attachment = { required: true, filename: n.filename ?? attachment?.filename };
    else if (n.t === 'not' && n.c.t === 'attach' && !n.c.filename) attachment = { required: false };
    else rest.push(n);
  }
  const strip = (n: Node): Node => {
    if (n.t === 'scope') {
      warnings.push('메일함 조건(in:/label:)은 OR나 괄호 안에서는 쓸 수 없어 무시했습니다.');
      return { t: 'all' };
    }
    if (n.t === 'attach') {
      warnings.push('첨부 조건(has:attachment, filename:)은 OR나 괄호 안에서는 쓸 수 없어 무시했습니다.');
      return { t: 'all' };
    }
    if (n.t === 'and' || n.t === 'or') return { ...n, c: n.c.map(strip) };
    if (n.t === 'not') return { t: 'not', c: strip(n.c) };
    return n;
  };
  return { include, exclude, attachment, rest: rest.map(strip) };
}

/** 조건 없는 노드(all)를 걸러 낸다. OR 안에 all이 있으면 OR 전체가 all */
function simplify(n: Node): Node {
  if (n.t === 'and') {
    const c = n.c.map(simplify).filter((x) => x.t !== 'all');
    return c.length === 0 ? { t: 'all' } : c.length === 1 ? c[0]! : { t: 'and', c };
  }
  if (n.t === 'or') {
    const c = n.c.map(simplify);
    if (c.some((x) => x.t === 'all')) return { t: 'all' };
    return c.length === 1 ? c[0]! : { t: 'or', c };
  }
  if (n.t === 'not') {
    const c = simplify(n.c);
    return c.t === 'all' ? { t: 'all' } : { t: 'not', c };
  }
  return n;
}

/**
 * imapflow 검색 객체로 변환. 한 객체 안의 키는 AND인데 같은 키를 두 번 쓸 수 없으므로,
 * AND는 { or: [a], not: { not: 나머지 } } 꼴로 이어 붙인다 (원소 하나짜리 or는 그 조건 그대로).
 */
function toSearch(n: Node): SearchObject {
  switch (n.t) {
    case 'leaf':
      return n.q;
    case 'or':
      return { or: n.c.map(toSearch) };
    case 'not':
      return { not: toSearch(n.c) };
    case 'and': {
      const [first, ...rest] = n.c.map(toSearch);
      if (rest.length === 0) return first!;
      return { or: [first!], not: { not: toSearch({ t: 'and', c: n.c.slice(1) }) } };
    }
    default:
      return { all: true };
  }
}

export function parseGmailQuery(query: string | undefined, now = new Date()): ParsedQuery {
  const parser = new Parser(tokenize(query ?? ''), now);
  const root = parser.parse();
  const warnings = parser.warnings;
  const { include, exclude, attachment, rest } = extractScopes(root, warnings);
  const body = simplify({ t: 'and', c: rest });
  return { search: body.t === 'all' ? undefined : toSearch(body), include, exclude, ...(attachment ? { attachment } : {}), warnings };
}
