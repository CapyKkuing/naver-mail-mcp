import { NAVER_DEFAULTS, type MailConfig } from './mail/imap';

type ConfigEnv = Partial<Record<'IMAP_HOST' | 'IMAP_PORT' | 'SMTP_HOST' | 'SMTP_PORT' | 'SAVE_SENT_COPY', string>>;

export function mailConfig(env: ConfigEnv): MailConfig {
  return {
    imapHost: env.IMAP_HOST || NAVER_DEFAULTS.imapHost,
    imapPort: Number(env.IMAP_PORT) || NAVER_DEFAULTS.imapPort,
    smtpHost: env.SMTP_HOST || NAVER_DEFAULTS.smtpHost,
    smtpPort: Number(env.SMTP_PORT) || NAVER_DEFAULTS.smtpPort,
    saveSentCopy: env.SAVE_SENT_COPY !== 'false',
  };
}

/** ALLOWED_USERS가 비어 있으면 모두 허용 */
export function isAllowedUser(allowed: string | undefined, login: string): boolean {
  const list = (allowed ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/@naver\.com$/, ''))
    .filter(Boolean);
  return list.length === 0 || list.includes(login.toLowerCase().replace(/@naver\.com$/, ''));
}
