import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { mailConfig } from './config';
import { MailError } from './mail/imap';
import { NaverMailService } from './mail/service';
import { SERVER_INSTRUCTIONS } from './mcp-instructions';
import { registerTools } from './tools';
import type { Env, Props } from './types';

export class NaverMailMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: 'naver-mail-mcp', version: '0.1.1' }, { instructions: SERVER_INSTRUCTIONS });

  async init() {
    registerTools(this.server, () => {
      const p = this.props;
      if (!p?.login || !p.password) throw new MailError('네이버 메일 계정이 연결되지 않았습니다. 커넥터를 다시 연결하세요.');
      return new NaverMailService({ login: p.login, email: p.email, password: p.password, displayName: p.displayName }, mailConfig(this.env));
    });
  }
}
