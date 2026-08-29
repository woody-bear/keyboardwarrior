# 키보드워리어

> Jarvis 문서 · 음성/텍스트 피드백으로 보강됩니다 · 블록을 클릭하면 직접 편집

## ✅ 완성된 기능

> 이 프로젝트는 아직 git 저장소가 아니라 커밋 로그가 없습니다. 아래 "변화 과정"은 파일 수정 시각(8/8 초기 구축 → 8/17 TV·테마 확장)을 근거로 정리했으며, `git init` 후 커밋이 쌓이면 해시·메시지로 교체합니다.

- **실시간 팀 타자 대결 코어** — 서버가 단어 생성·낙하·판정·점수를 계산하고 20Hz로 `state` 브로드캐스트. 레드/블루 자동 배정, 공동 목숨 10개, 2분 30초 라운드, 종료 10초 뒤 자동 재시작. (`server/game.js`, `server/index.js`)
  <details><summary>변화 과정</summary>

  - 2026-08-08 초기 구축: Express + Socket.io 서버, 인메모리 상태, 7개 레인 겹침 방지, 콤보(4초 창, 최대 2배)
  - 2026-08-17 게임 루프 확장: 터치/타이핑 모드 사이클, 에코 타격(2.5초 내 무점수 연출), 보너스 단어 2배, 사용자 정의 단어 큐
  - 2026-08-29 터치 득점 사이클 제거 → 항상 타이핑 전용 (`inputMode`가 항상 `typing`, 터치 submit은 `typing-only`로 거부)
  </details>
- **난이도 진행형 출제 + 한컴타자식 지표** — 시간대별 짧은 낱말 → 보통 낱말 → 단문(속도 28% 감속). 자모 분해 기반 타수(CPM)·정확도(%) 실시간 계산. (`server/words.js`, `server/hangul.js`)
  <details><summary>변화 과정</summary>

  - 2026-08-08 `words.js` 3단계 풀, `hangul.js` 두벌식 기준 겹모음·겹받침 2타 계산 도입
  </details>
- **로그인 없는 참여** — QR/링크 접속만으로 자동 닉네임(형용사+명사, 중복 방지) 부여, 닉네임 변경·팀 전환·프로필 사진 업로드. (`server/nickname.js`, `profile:photo`)
  <details><summary>변화 과정</summary>

  - 2026-08-08 닉네임 자동 생성, `rename`/`team:switch`
  - 2026-08-17 `team:set` 직접 지정, `profile:photo` 데이터URL 전파 및 캔버스 아바타 렌더링
  </details>
- **HTTP/HTTPS 단일 포트 멀티플렉싱 + LAN 자체 서명 인증서** — TCP 첫 바이트(0x16)로 TLS 여부를 판별해 같은 포트에서 두 프로토콜 처리. LAN IP를 SAN에 넣은 인증서를 `.certs/`에 자동 생성·캐시. (`createMultiplexer`, `server/cert.js`)
  <details><summary>변화 과정</summary>

  - 2026-08-08 브라우저 HTTPS 자동 승격(ERR_SSL_PROTOCOL_ERROR) 대응으로 도입
  </details>
- **Cloudflare 임시 터널 원클릭 실행** — `npm run tunnel`로 서버+cloudflared를 함께 띄우고, 발급 주소를 `/api/public-url`로 전달해 QR·공유 링크 자동 교체. 기존 named 터널 설정과 격리. (`scripts/tunnel.js`)
  <details><summary>변화 과정</summary>

  - 2026-08-08 Docker Compose `tunnel` 프로필(고정 도메인) + quick 터널 스크립트 추가
  </details>
- **단어 테마 관리 페이지 `/keyword`** — 테마 생성/삭제, 단어 추가/제거, 활성 테마 선택, 게임 설정(단어 양 0.3~2배, 속도 0.5~2배, 라운드 30~600초). `keywords.json`에 영속화. 기본 테마: 자연·곤충·예절. (`server/keywords.js`, `public/keyword.html`)
  <details><summary>변화 과정</summary>

  - 2026-08-17 REST API 6종(`/api/keywords*`) + 관리 UI, 설정 변경 시 전체 `toast` 알림
  </details>
- **TV 관전 화면 `/tv`** — 오래된 TV 브라우저 호환을 위해 flexbox/grid/CSS 변수 없이 테이블·고정 위치 레이아웃과 ES5만 사용한 대형 관전 뷰. (`public/tv.html`)
  <details><summary>변화 과정</summary>

  - 2026-08-17 TV 전용 페이지 신설, 점수판·낙하 단어·순위표 표시
  </details>
- **Docker 배포** — `Dockerfile` + `docker-compose.yml`, `PUBLIC_URL`로 컨테이너 안에서 QR 주소 지정.

## ➕ 추가할 기능

- 프로젝트 `git init` 및 초기 커밋 — 변화 과정 섹션을 실제 커밋 해시로 갱신하기 위한 선행 작업
- 자동화 테스트 — `socket.io-client`, `puppeteer-core`가 devDependencies에 있으나 테스트 스크립트/파일이 없음 (`npm test` 부재)
- 관리 페이지(`/keyword`) 접근 제어 — 현재 누구나 테마·설정을 바꿀 수 있음 (간단한 토큰 또는 호스트 전용 제한)
- 라운드 결과 기록/히스토리 — 인메모리라 재시작 시 사라짐. 경량 JSON 로그로 최근 N라운드 보관
- 방(room) 분리 — 현재 단일 전역 게임. 여러 그룹이 동시에 별도 게임을 진행할 수 있도록 확장

## 🔧 개선할 기능

- README의 프로젝트 구조 표에 `keywords.js`/`keywords.json`, `keyword.html`, `tv.html`이 빠져 있고, 소켓 이벤트 표에 `me:update`·`me:profile`·`word:miss`·`toast`·`session`·`team:set`·`round:restart`·`word:custom`·`profile:photo`가 누락됨
- `package.json` 이름이 `team-drop-words`로 폴더명 `keyboardwarrior`와 불일치 — 명칭 통일 필요
- (확인 완료) `.gitignore`에 `.certs/`·`.env`가 이미 포함되어 있어 개인 키 유출 위험은 없음 — git 초기화 시 그대로 유지
- 터치 모드를 다시 쓰고 싶을 때를 대비해 `/api/keywords/settings`에 입력 모드(타이핑 전용 / 터치 허용) 옵션 추가
- `state.mode`·`modeRemainMs` 필드와 `modeBar` DOM이 하위 호환용으로 남아 있음 — 터치 모드를 완전히 폐기한다면 정리
- `profile:photo` 데이터URL 크기 제한/검증 강화 — 대용량 이미지가 모든 클라이언트로 브로드캐스트되는 부담

## 개요

**keyboardwarrior**(패키지명 `team-drop-words`)는 떨어지는 단어를 입력해 파괴하는 **실시간 팀 대결 한글 타자 게임**입니다. 로그인 없이 QR 스캔 또는 링크 접속만으로 참여하며, PC 화면(호스트)·휴대폰(참가자)·TV(관전)가 같은 게임 상태를 공유합니다.

- 서버가 Source of Truth: 단어 생성·낙하·판정·점수를 모두 서버에서 계산하고 20Hz로 브로드캐스트
- 클라이언트는 렌더링과 입력 전송만 담당, 좌표는 0~1 정규화 값
- DB/Redis 없이 인메모리 상태 (동시 접속 100명 규모 목표), 테마·설정만 `keywords.json`에 저장
- 기술 스택: Node.js(CommonJS), Express 5, Socket.io 4, qrcode, selfsigned / 프런트는 순수 HTML·Canvas·JS

## 주요 기능

| 영역 | 내용 |
|---|---|
| 게임 규칙 | 2분 30초(설정 가능) 또는 공동 목숨 10개 소진 시 종료, 인원 적은 팀 자동 배정, 점수 = 글자 수 × 10 × 콤보 배수(최대 2배), 보너스 단어 2배 |
| 입력 모드 | 항상 타이핑 전용. 휴대폰에서 캔버스를 터치하면 입력창에 포커스만 주고, 터치 submit은 실수 처리 없이 안내만 (2026-08-29 변경) |
| 에코 타격 | 방금(2.5초 내) 남이 파괴한 단어를 치면 실수로 세지 않고 점수 없는 타격 연출 |
| 난이도 | ~35초 짧은 낱말, 35~80초 보통 낱말, 80초~ 단문(낙하 28% 감속). 테마 활성화 시 테마 단어만 출제 |
| 지표 | 분당 타수(CPM), 정확도(%), 콤보/최고 콤보를 실시간 표시, 순위표 최대 5Hz |
| 참여 | 자동 닉네임, 닉네임 변경, 팀 전환/지정, 프로필 사진, 사용자 정의 단어 투입(`word:custom`) |
| 접속 | 같은 포트 HTTP/HTTPS 동시 처리, LAN 자체 서명 인증서, Cloudflare 터널(임시/고정), Docker |
| 관리/관전 | `/keyword` 테마·설정 관리, `/tv` 구형 TV 호환 관전 화면, `/healthz` 상태 확인 |

## 구조

```
server/
  index.js      Express + Socket.io, QR 생성, HTTP/HTTPS 멀티플렉싱, REST·소켓 라우팅 (323줄)
  game.js       게임 상태·20Hz 루프·판정·지표 — Source of Truth (508줄)
  keywords.js   단어 테마/게임 설정 관리, keywords.json 영속화 (173줄)
  words.js      난이도 단계별 기본 문제 풀 (72줄)
  hangul.js     한글 자모 분해 기반 타수 계산 (42줄)
  nickname.js   자동 닉네임 생성 (39줄)
  cert.js       LAN용 자체 서명 인증서 생성·캐시 (56줄)
public/
  index.html    플레이 화면 (QR/점수판, 캔버스, 입력)
  app.js        캔버스 렌더링, 소켓 수신, 터치/타이핑 입력 (1223줄)
  keyword.html  단어 테마 관리 UI
  tv.html       TV 관전 화면 (ES5, 테이블 레이아웃)
  style.css     다크 테마 + 모바일 반응형
scripts/
  tunnel.js     서버 + Cloudflare quick 터널 동시 실행
Dockerfile, docker-compose.yml, .certs/ (자동 생성 인증서)
```

### 소켓 이벤트

| 방향 | 이벤트 | 내용 |
|---|---|---|
| S→C | `welcome` | 내 닉네임·팀, 참여 URL, 현재 프로필 사진 목록 |
| S→C | `session` | 참여 URL·QR 데이터URL (터널 주소로 교체 시 재전송) |
| S→C | `state` | 20Hz 스냅샷 (단어 좌표, 점수, 목숨, 남은 시간, 입력 모드) |
| S→C | `roster` | 참가자 순위 (최대 5Hz) |
| S→C | `word:hit` / `word:dropped` / `word:miss` | 파괴 / 낙하 / 오타 이펙트 |
| S→C | `me:update` / `me:profile` | 내 점수·지표 / 내 닉네임·팀 갱신 |
| S→C | `round:start` / `round:over` | 라운드 시작·결과 |
| S→C | `toast` | 전체 알림 (테마 변경, 설정 변경, 단어 추가, 재시작) |
| S→C | `profile:photo` | 특정 참가자의 프로필 사진 |
| C→S | `submit(text, method)` | 입력 단어 + 입력 방식(`touch`/`typing`) |
| C→S | `rename` / `team:switch` / `team:set` | 내 정보 변경 |
| C→S | `round:restart` / `word:custom` / `profile:photo` | 라운드 재시작 / 단어 투입 / 사진 업로드 |

### REST API

| 메서드 | 경로 | 내용 |
|---|---|---|
| GET | `/api/session` | 참여 URL·QR |
| POST | `/api/public-url` | 터널 주소 등록 → QR 교체 |
| GET | `/healthz` | 상태·접속자 수 |
| GET | `/api/keywords` | 테마 목록·활성 테마·설정 |
| POST | `/api/keywords` · `/words` · `/remove-word` · `/delete` · `/active` · `/settings` | 테마 CRUD, 활성화, 게임 설정 |

## 작업 로그

- 2026-08-29 — 터치 득점 제거, 타이핑 전용으로 전환. `server/game.js` 모드 사이클 상수·`inputMode` 단순화, `public/app.js` 캔버스 터치 핸들러를 입력창 포커스로 대체하고 모드 배너/라벨 정리, `public/tv.html` 타이핑 타임 카운트다운 숨김. socket.io-client로 터치 submit 거부(`typing-only`)·타이핑 득점(+20) 검증.

- 2026-08-29 — 프로젝트 구조(server/public/scripts) 분석 후 개요·주요 기능·구조·소켓/REST 이벤트 표를 작성하고, 완성/추가/개선 3섹션을 현재 코드 기준으로 정리. git 저장소가 아니어서 변화 과정은 파일 수정 시각 기준으로 기록.
