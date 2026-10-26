import PostalMime, { type Email } from 'postal-mime';

/** 받은 메일 원문을 해석한다. 한국 메일에 흔한 cp949/ks_c_5601 표기도 받는다. */

/** TextDecoder가 모르는 한국어 문자셋 이름을 euc-kr(= windows-949 상위 집합)로 바꾼다 */
export function normalizeCharsets(raw: string): string {
  return raw
    .replace(/(charset\s*=\s*"?)(cp949|x-windows-949|ms949|uhc|windows-949|ks_c_5601-1987|ksc5601|ks_c_5601)("?)/gi, '$1euc-kr$3')
    .replace(/=\?(cp949|x-windows-949|ms949|uhc|windows-949|ksc5601)\?/gi, '=?euc-kr?');
}

export async function parseRaw(raw: Uint8Array | string): Promise<Email> {
  const text = typeof raw === 'string' ? raw : latin1(raw);
  // 8비트 본문을 망가뜨리지 않게 latin1로 읽어 문자셋 이름만 고친 뒤 다시 바이트로 돌린다
  const fixed = normalizeCharsets(text);
  return PostalMime.parse(fixed === text && typeof raw !== 'string' ? raw : fromLatin1(fixed));
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML 본문을 읽기 좋은 텍스트로 (링크 주소는 괄호로 남긴다) */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, '').trim();
      return href.startsWith('http') && l && !l.includes(href) ? `${l} (${href})` : l || href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!Number.isFinite(code)) return m;
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/[ \t ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function plainBody(m: Email): string {
  if (m.text?.trim()) return m.text.replace(/\r\n/g, '\n').trim();
  return m.html ? htmlToText(m.html) : '';
}

export function snippetOf(m: Email, max = 200): string {
  const t = plainBody(m).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export interface AddressOut {
  name?: string;
  address: string;
}

export function addresses(list: Email['to']): AddressOut[] {
  const out: AddressOut[] = [];
  for (const a of list ?? []) {
    if ('group' in a && a.group) out.push(...addresses(a.group));
    else if (a.address) out.push(a.name ? { name: a.name, address: a.address } : { address: a.address });
  }
  return out;
}

export const formatAddr = (a: AddressOut) => (a.name ? `${a.name} <${a.address}>` : a.address);

/** References/In-Reply-To/Message-ID에서 대화의 첫 메일 Message-ID를 고른다 */
export function threadRoot(m: { messageId?: string; inReplyTo?: string; references?: string }): string | undefined {
  const refs = (m.references ?? '').match(/<[^>]+>/g);
  if (refs?.length) return refs[0];
  const irt = (m.inReplyTo ?? '').match(/<[^>]+>/)?.[0];
  return irt ?? m.messageId?.match(/<[^>]+>/)?.[0] ?? m.messageId;
}
