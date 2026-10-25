# naver-mail-mcp

**네이버 메일을 Gmail MCP와 똑같은 도구로 쓰게 해 주는 원격 MCP 서버**입니다.
Claude, Grok, Meta Muse, ChatGPT 같은 AI 에이전트에 "커스텀 커넥터"로 연결하면, Gmail에서 하던 것처럼 네이버 메일을 읽고 요약하고 중요한 메일을 찾아 알려 주고 답장까지 할 수 있습니다.

- 도구 이름과 입력이 Gmail MCP와 같습니다 (`search_threads`, `get_thread`, `reply`, `label_message` …). Gmail에서 쓰던 에이전트 흐름을 그대로 쓸 수 있습니다.
- Gmail 검색 문법을 그대로 받습니다: `from:bank is:unread newer_than:7d`, `subject:(회의 자료) has:attachment` 등.
- EUC-KR / `ks_c_5601-1987` / `cp949`로 된 한국 메일도 깨지지 않게 읽습니다.
- Cloudflare Workers에 올리는 원격 서버(Streamable HTTP + OAuth)라서 클라우드에서 도는 에이전트에서도 연결됩니다. 내 컴퓨터에서 쓰는 stdio 모드도 있습니다.

> 네이버의 공식 서비스가 아닙니다. 네이버 메일이 제공하는 IMAP/SMTP로 동작합니다.

### 실제 네이버 계정에서 확인한 것 (2026-10, Meta Muse 연결)

- 2단계 인증 계정을 애플리케이션 비밀번호로 연결
- 계정·안 읽은 메일 수 확인, 최근 메일 요약
- 검색: 한글 낱말(`결제`), 제목(`subject:`), 기간(`newer_than:30d`), 첨부(`has:attachment`, `filename:pdf`), 보낸메일함(`in:sent`)
- 대화 묶어 보기(`get_thread`), 첨부 이름 읽기
- 메일 발송과 보낸메일함 저장(중복 없음)

답장·전달·임시보관함·라벨 이동·휴지통은 가짜 메일 서버 통합 테스트로 확인했고, 실제 계정 확인은 진행 중입니다.

## 어떤 에이전트에 연결할 수 있나

클라우드에서 도는 에이전트는 **공개 HTTPS 주소의 원격 MCP 서버(Streamable HTTP)** 를 요구하고, 로그인은 OAuth로 합니다. 이 서버는 두 조건을 모두 갖췄습니다.

| 에이전트 | 연결하는 곳 |
| --- | --- |
| Claude (claude.ai, 데스크톱, 모바일) | 설정 → 커넥터 → 커스텀 커넥터 추가 → `https://<내 서버>/mcp` |
| Grok | grok.com/connectors → New Connector → Custom → `https://<내 서버>/mcp` |
| Meta Muse | 설정에서 커넥터 URL 추가, 또는 대화창에서 URL을 주고 연결 요청 |
| ChatGPT (OpenAI Dots 포함) | 설정 → 앱/커넥터 → 개발자 모드에서 커스텀 커넥터 추가 |
| Claude Code, Cursor 등 | `https://<내 서버>/mcp` (OAuth) 또는 고정 토큰 헤더, 또는 stdio 모드 |

주소를 넣으면 이 서버의 로그인 화면이 열립니다. **네이버 아이디와 애플리케이션 비밀번호**를 넣으면 IMAP 로그인으로 확인한 뒤 연결됩니다.
메뉴 이름이나 요금제별 허용 여부는 각 서비스 사정에 따라 바뀔 수 있습니다.

### 바로 설치 (배포된 서버 사용)

공개 서버 주소: `https://naver-mail-mcp.yeonuunim521.workers.dev/mcp`

**Claude Code**

```bash
claude mcp add --transport http naver-mail https://naver-mail-mcp.yeonuunim521.workers.dev/mcp
```

그다음 Claude Code에서 `/mcp`를 열어 naver-mail을 고르고 브라우저 로그인을 마칩니다.

**Codex CLI**

```bash
codex mcp add naver-mail --url https://naver-mail-mcp.yeonuunim521.workers.dev/mcp
codex mcp login naver-mail
```

옛 버전에서 OAuth가 안 되면 Codex를 업데이트하세요.

**AI에게 맡기기:** Claude Code나 Codex에 아래 문장을 붙여 넣으면 설치 명령은 AI가 실행합니다. 로그인(네이버 아이디·애플리케이션 비밀번호 입력)만 직접 브라우저에서 하면 됩니다.

```text
네이버 메일 MCP를 설치해줘. 원격 MCP 서버(Streamable HTTP, OAuth) 주소는
https://naver-mail-mcp.yeonuunim521.workers.dev/mcp 이고 이름은 naver-mail로 해줘.
설치 후 OAuth 로그인 방법을 알려줘.
```

## 네이버 메일 준비 (사용자마다 한 번)

1. 네이버 메일 → 환경설정 → **POP3/IMAP 설정** → **IMAP/SMTP 사용**을 켭니다.
2. 2단계 인증을 쓴다면 네이버 ID → 보안설정 → **애플리케이션 비밀번호**를 만듭니다. 평소 로그인 비밀번호는 거부됩니다.

접속 정보: IMAP `imap.naver.com:993`(SSL), SMTP `smtp.naver.com:465`(SSL)

## 배포 (Cloudflare Workers)

```bash
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV     # 나온 id를 wrangler.jsonc의 kv_namespaces에 넣기
# wrangler.jsonc의 PUBLIC_URL을 배포 주소로, ALLOWED_USERS에 쓸 네이버 아이디를 넣기
npx wrangler deploy
```

- `ALLOWED_USERS`: 쉼표로 구분한 네이버 아이디입니다. 비워 두면 누구나 자기 계정으로 연결할 수 있는 공개 서버가 됩니다. 개인용이면 꼭 내 아이디만 넣으세요.
- `SAVE_SENT_COPY`: 기본값 `true`이고, 보낸 메일의 사본을 보낸메일함에 넣습니다. 네이버가 SMTP 발송분을 자동으로 저장해서 사본이 두 번 생기면 `false`로 바꾸세요.

### 고정 토큰 모드 (선택)

헤더를 넣을 수 있는 클라이언트(Claude Code, API 호출 등)는 OAuth 없이 쓸 수 있습니다.

```bash
npx wrangler secret put MCP_BEARER_TOKEN      # 긴 무작위 문자열
npx wrangler secret put NAVER_ID
npx wrangler secret put NAVER_APP_PASSWORD
```

요청 헤더에 `Authorization: Bearer <MCP_BEARER_TOKEN>`를 넣으면 위 계정으로 접속합니다.

## 내 컴퓨터에서 쓰기 (stdio)

```bash
NAVER_ID=myid NAVER_APP_PASSWORD=앱비밀번호 npm run stdio
```

Claude Desktop 설정 예:

```json
{
  "mcpServers": {
    "naver-mail": {
      "command": "npx",
      "args": ["tsx", "/절대/경로/naver-mail-mcp/src/stdio.ts"],
      "env": { "NAVER_ID": "myid", "NAVER_APP_PASSWORD": "앱비밀번호" }
    }
  }
}
```

## 도구 (Gmail MCP와 같은 이름)

| 분류 | 도구 |
| --- | --- |
| 찾기·읽기 | `search_threads`, `get_thread`, `get_message`, `get_attachment`, `get_profile` |
| 보내기 | `send_message`, `reply`(전체 답장), `forward`(원래 첨부 포함) |
| 임시보관함 | `create_draft`, `update_draft`, `delete_draft`, `list_drafts`, `get_draft` |
| 라벨 | `list_labels`, `create_label`, `update_label`, `delete_label`, `label_message`, `unlabel_message`, `update_message_labels`, `label_thread`, `unlabel_thread` |
| 휴지통·스팸 | `trash_message`, `trash_thread`, `untrash_message`, `untrash_thread`, `mark_message_spam`, `mark_thread_spam`, `unmark_message_spam`, `unmark_thread_spam` |

`get_profile`과 `get_attachment`는 Gmail MCP에는 없는 추가 도구입니다.

### Gmail과 다른 점 (IMAP의 한계)

- **라벨은 메일함입니다.** `INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`은 해당 메일함이고, 사용자 라벨은 메일함 경로입니다. 한 메일은 한 메일함에만 있으므로, 메일함 라벨을 붙이면 **이동**합니다. `STARRED`(중요 표시)와 `UNREAD`(안읽음)는 플래그입니다.
- **메일 ID는 메일함과 UID로 만듭니다.** 메일을 옮기면 ID가 바뀌고, 옮기는 도구가 새 ID를 돌려줍니다. 임시보관 메일을 고칠 때도 새로 저장하므로 ID가 바뀝니다.
- **보관(archive)이 없습니다.** 받은메일함에서 빼려면 다른 메일함 라벨을 붙이세요.
- **대화(thread)는 Message-ID/References 헤더로 묶습니다.** 받은메일함, 보낸메일함, 사용자 메일함을 가로질러 모읍니다. 네이버 IMAP은 헤더 검색이 잘 안 돼서, 메일함마다 최근 1,000통의 헤더를 직접 읽어 찾습니다.
- **낱말 검색**은 제목, 보낸 사람, 본문을 각각 찾아 합칩니다 (네이버 IMAP의 전체 텍스트 검색이 한글을 찾지 못함). `has:attachment`, `filename:`은 메일 구조를 직접 확인하며 메일함마다 최근 3,000통까지 봅니다. 더 오래된 메일은 `after:` 같은 기간 조건을 함께 쓰세요.
- **기본 검색 범위**는 휴지통, 스팸, 임시보관함을 뺀 모든 메일함입니다. `category:`, `AROUND` 같은 Gmail 전용 조건은 무시하고 결과의 `warnings`에 알려 줍니다.
- 서명 자동 붙이기(`includeSignature`)와 카테고리 탭은 지원하지 않습니다.

## 보안

- 앱 비밀번호는 OAuth 토큰에 담겨 라이브러리(`@cloudflare/workers-oauth-provider`)가 토큰으로 암호화해 저장합니다. 세션 동안에는 그 세션의 Durable Object 저장소에도 보관됩니다.
- 연결을 완전히 끊으려면 네이버에서 해당 애플리케이션 비밀번호를 삭제하세요.
- 메일을 보내는 도구(`send_message`, `reply`, `forward`)를 쓰기 전에는 에이전트가 사용자에게 확인하도록 서버 안내문에 적어 두었습니다.

## 개발

```bash
npm test          # 가짜 IMAP/SMTP 서버로 전체 흐름 통합 테스트 + 검색 문법 단위 테스트
npm run typecheck
npm run dev       # 로컬 Worker (http://localhost:8787/mcp). .dev.vars에 PUBLIC_URL=http://localhost:8787
```

## 라이선스

MIT
