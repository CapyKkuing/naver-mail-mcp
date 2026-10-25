import { Buffer } from 'node:buffer';
import net from 'node:net';
import tls from 'node:tls';

/**
 * 최소 SMTP 클라이언트 (465 포트 암묵적 TLS, AUTH PLAIN).
 * Cloudflare Workers는 이미 연결된 소켓을 TLS로 올릴 수 없어(STARTTLS 불가) 465만 쓴다.
 */

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  /** EHLO에 쓸 이름 */
  clientName?: string;
  /** 테스트 전용: 자체 서명 인증서 허용 */
  insecure?: boolean;
  timeoutMs?: number;
}

export class SmtpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

class Conn {
  private buf = '';
  private waiters: Array<() => void> = [];
  private closed: Error | null = null;

  constructor(private readonly socket: tls.TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      this.buf += d;
      this.wake();
    });
    socket.on('error', (e) => {
      this.closed = e;
      this.wake();
    });
    socket.on('close', () => {
      this.closed ??= new Error('SMTP 연결이 끊겼습니다');
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** 여러 줄 응답(250-...)을 마지막 줄(250 ...)까지 읽는다 */
  async read(): Promise<{ code: number; text: string }> {
    for (;;) {
      const lines = this.buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
          const text = lines.slice(0, i + 1).join('\n');
          this.buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(lines[i]!.slice(0, 3)), text };
        }
      }
      if (this.closed) throw this.closed;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  write(data: string) {
    this.socket.write(data);
  }

  async command(line: string, expect: number[], secretLabel?: string): Promise<string> {
    this.write(line + '\r\n');
    const res = await this.read();
    if (!expect.includes(res.code)) {
      const shown = secretLabel ?? line;
      throw new SmtpError(res.code, `SMTP ${shown} 실패: ${res.text}`);
    }
    return res.text;
  }

  close() {
    this.socket.end();
  }
}

function connect(o: SmtpOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const servername = net.isIP(o.host) ? undefined : o.host;
    const socket = tls.connect({ host: o.host, port: o.port, servername, rejectUnauthorized: !o.insecure }, () => resolve(socket));
    socket.once('error', reject);
  });
}

/** 원문 줄 끝을 CRLF로 맞추고, 점으로 시작하는 줄은 점을 하나 더 붙인다 (RFC 5321 4.5.2) */
export function dotStuff(raw: string): string {
  return raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

export async function sendMail(o: SmtpOptions, envelope: { from: string; to: string[] }, raw: string): Promise<{ accepted: string[]; response: string }> {
  if (!envelope.to.length) throw new Error('받는 사람이 없습니다');
  const timeout = o.timeoutMs ?? 30_000;
  const socket = await connect(o);
  socket.setTimeout(timeout, () => socket.destroy(new Error('SMTP 응답 시간이 초과되었습니다')));
  const c = new Conn(socket);
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw new SmtpError(greet.code, `SMTP 접속 실패: ${greet.text}`);
    await c.command(`EHLO ${o.clientName ?? 'naver-mail-mcp'}`, [250]);
    const plain = Buffer.from(`\0${o.user}\0${o.password}`, 'utf8').toString('base64');
    await c.command(`AUTH PLAIN ${plain}`, [235], 'AUTH');
    await c.command(`MAIL FROM:<${envelope.from}>`, [250]);
    const accepted: string[] = [];
    for (const rcpt of envelope.to) {
      await c.command(`RCPT TO:<${rcpt}>`, [250, 251]);
      accepted.push(rcpt);
    }
    await c.command('DATA', [354]);
    let data = dotStuff(raw);
    if (!data.endsWith('\r\n')) data += '\r\n';
    const response = await c.command(`${data}.`, [250], 'DATA');
    await c.command('QUIT', [221]).catch(() => undefined);
    return { accepted, response };
  } finally {
    c.close();
  }
}
