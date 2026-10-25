# naver-mail-mcp

**An MCP server that lets AI agents read, search, summarize and reply to Naver Mail (네이버 메일) — with the same tools as the Gmail MCP.**

[한국어](README.md)

<p align="center"><img src="docs/demo.gif" width="640" alt="Demo: an AI assistant summarizing important Naver Mail messages and replying"></p>

Naver Mail is the most widely used email service in Korea, but unlike Gmail it has no official API or MCP connector. This server bridges it over IMAP/SMTP and exposes **30 tools whose names and inputs match the Gmail MCP** (`search_threads`, `get_thread`, `reply`, `forward`, `label_message`, `trash_message`, drafts …), so agent workflows built for Gmail work on Naver Mail unchanged.

- Gmail search syntax: `from:bank is:unread newer_than:7d`, `subject:(meeting notes) has:attachment`, `filename:pdf`, `in:sent`, `OR`, `-exclude`
- Read, reply / reply-all, forward with attachments, drafts, folders-as-labels, star, read/unread, trash, spam
- Korean legacy encodings handled (EUC-KR, `ks_c_5601-1987`, `cp949`)
- Remote server on Cloudflare Workers (Streamable HTTP + OAuth 2.1 with dynamic client registration and CIMD) for cloud agents, plus a local stdio mode
- Verified against a real Naver account (search, threads, attachments, sending)

## Connect

**Hosted server (no install):** `https://naver-mail-mcp.yeonuunim521.workers.dev/mcp`

Add it as a custom connector in Claude, Grok, Meta Muse or ChatGPT, or:

```bash
claude mcp add --transport http naver-mail https://naver-mail-mcp.yeonuunim521.workers.dev/mcp
codex mcp add naver-mail --url https://naver-mail-mcp.yeonuunim521.workers.dev/mcp && codex mcp login naver-mail
```

The login page asks for your Naver ID and an **app password** (requires 2-step verification; IMAP/SMTP must be enabled in Naver Mail settings → POP3/IMAP).

**Local (stdio):**

```json
{ "mcpServers": { "naver-mail": { "command": "npx", "args": ["-y", "naver-mail-mcp"],
  "env": { "NAVER_ID": "your-id", "NAVER_APP_PASSWORD": "app-password" } } } }
```

**Self-host:** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CapyKkuing/naver-mail-mcp)

## Differences from Gmail

Labels are folders (adding a folder label moves the message and changes its id), there is no archive, threads are rebuilt from Message-ID/References headers, and keyword search is split into subject/from/body searches because Naver's IMAP server rejects OR and full-text queries. See the Korean README for details.

## License

MIT
