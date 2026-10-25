# 변경 기록

## 0.1.2 (2026-10-25)

보안 점검 반영 (원격 서버 쪽 변경이라 npm 패키지(stdio)는 기능 차이 없음).

- MCP 세션(Durable Object) 저장소에 애플리케이션 비밀번호를 평문으로 남기던 것을 메모리에만 두도록 바꾸고, 기존 저장분은 삭제
- 자동 등록된 Client ID에는 같은 호스트의 되돌아갈 주소만 덧붙일 수 있게 (남의 Client ID로 토큰을 가로채는 경로 차단)
- 로그인 화면: 권한이 갈 곳이 알려진 AI 서비스(Claude·Grok·Meta Muse·ChatGPT)가 아니면 경고
- 요청 횟수 제한: 로그인 시도 IP당 분당 10회 + 전체 분당 60회, 클라이언트 등록 분당 30회
- README 보안 섹션을 실제 저장 방식대로 정확히 기술

## 0.1.1 (2026-10-26)

- MCP 레지스트리 이름을 `io.github.CapyKkuing/naver-mail-mcp`로 고침 (GitHub 계정 대소문자에 맞춤). 기능 변경 없음

## 0.1.0 (2026-10-25)

첫 공개 버전.

- Gmail MCP와 같은 이름·입력의 도구 28개 + `get_profile`, `get_attachment`
- Gmail 검색 문법 → IMAP 검색 변환. 네이버 IMAP에 맞춰 낱말은 제목·보낸 사람·본문을 따로 검색, 첨부는 메일 구조로 확인, 대화는 헤더를 직접 읽어 묶음
- 한국어 인코딩(EUC-KR, `ks_c_5601-1987`, `cp949`) 메일 해독
- 원격 서버(Cloudflare Workers, Streamable HTTP + OAuth): 네이버 아이디·애플리케이션 비밀번호 로그인, 처음 보는 Client ID 자동 등록, 주소형 Client ID(CIMD) 지원, Deploy to Cloudflare 버튼
- 로컬 stdio 모드 (`npx naver-mail-mcp`)
- 실제 네이버 계정에서 연결·검색·대화·첨부·발송 확인
