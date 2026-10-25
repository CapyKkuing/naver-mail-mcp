import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { mailConfig } from './config';
import { MailError } from './mail/imap';
import { NaverMailService } from './mail/service';
import { SERVER_INSTRUCTIONS } from './mcp-instructions';
import { registerTools } from './tools';
import type { Env, Props } from './types';

export class NaverMailMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: 'naver-mail-mcp', version: '0.1.2' }, { instructions: SERVER_INSTRUCTIONS });

  /**
   * 기본 McpAgent는 props(앱 비밀번호 포함)를 Durable Object 저장소에 평문으로 남긴다.
   * 모든 MCP 요청이 OAuth 토큰에서 푼 props를 다시 가져오므로 저장할 필요가 없다: 메모리에만 두고,
   * 이 수정 전에 저장된 값이 있으면 지운다.
   */
  override async updateProps(props: Props | undefined) {
    this.props = props as Props;
    await this.ctx.storage.delete('props');
  }

  async init() {
    registerTools(this.server, () => {
      const p = this.props;
      if (!p?.login || !p.password) throw new MailError('네이버 메일 계정이 연결되지 않았습니다. 커넥터를 다시 연결하세요.');
      return new NaverMailService({ login: p.login, email: p.email, password: p.password, displayName: p.displayName }, mailConfig(this.env));
    });
  }
}
