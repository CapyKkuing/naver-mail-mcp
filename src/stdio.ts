import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mailConfig } from './config';
import { naverAccount } from './mail/imap';
import { NaverMailService } from './mail/service';
import { SERVER_INSTRUCTIONS } from './mcp-instructions';
import { registerTools } from './tools';

/** 내 컴퓨터에서 바로 쓰는 stdio 모드 (Claude Desktop·Claude Code 등). 원격 배포 없이 시험할 때도 쓴다 */
const { NAVER_ID, NAVER_APP_PASSWORD, NAVER_DISPLAY_NAME } = process.env;
if (!NAVER_ID || !NAVER_APP_PASSWORD) {
  console.error('NAVER_ID와 NAVER_APP_PASSWORD 환경 변수가 필요합니다.');
  process.exit(1);
}
const svc = new NaverMailService(naverAccount(NAVER_ID, NAVER_APP_PASSWORD, NAVER_DISPLAY_NAME), mailConfig(process.env));
const server = new McpServer({ name: 'naver-mail-mcp', version: '0.1.3' }, { instructions: SERVER_INSTRUCTIONS });
registerTools(server, () => svc);
await server.connect(new StdioServerTransport());
console.error(`naver-mail-mcp (stdio): ${svc.account.email}`);
