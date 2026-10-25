# 변경 기록

## 0.1.0 (2026-10-25)

첫 공개 버전.

- Gmail MCP와 같은 이름·입력의 도구 28개 + `get_profile`, `get_attachment`
- Gmail 검색 문법 → IMAP 검색 변환. 네이버 IMAP에 맞춰 낱말은 제목·보낸 사람·본문을 따로 검색, 첨부는 메일 구조로 확인, 대화는 헤더를 직접 읽어 묶음
- 한국어 인코딩(EUC-KR, `ks_c_5601-1987`, `cp949`) 메일 해독
- 원격 서버(Cloudflare Workers, Streamable HTTP + OAuth): 네이버 아이디·애플리케이션 비밀번호 로그인, 처음 보는 Client ID 자동 등록, 주소형 Client ID(CIMD) 지원, Deploy to Cloudflare 버튼
- 로컬 stdio 모드 (`npx naver-mail-mcp`)
- 실제 네이버 계정에서 연결·검색·대화·첨부·발송 확인
- 보안 점검 반영: MCP 세션 저장소에 비밀번호를 남기지 않음(메모리만), 자동 등록 Client ID에 다른 호스트의 되돌아갈 주소를 덧붙이지 못하게, 알려진 AI 서비스가 아닌 곳으로 권한이 갈 때 로그인 화면에 경고, 로그인·등록 요청 횟수 제한
