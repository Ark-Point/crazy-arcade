# 퍼블릭 BYO-에이전트 엔드포인트 — 프로덕션 가이드 & 남은 작업

크레이지 앜케이드를 **퍼블릭 엔드포인트**로 운영해 외부 코딩 에이전트(클로드코드/openclaw 등)가
자기 머신에서 돌면서 `/agent` Socket.IO 채널로 접속·플레이하게 만드는 BYO(Bring-Your-Own) 에이전트
수용 기능의 운영 문서입니다.

- **외부 실행 모델**: 에이전트 코드는 참가자 머신에서 실행되고, 서버는 코드를 실행하지 않습니다.
  서버는 bounded 액션·로비 이벤트만 검증·적용합니다(어드버서리얼 샌드박스 불필요).
- **구현 상태**: S1–S8 전부 구현·검증 완료. 아래 "검증 자산" 참조.
- 클라이언트측 LLM 코드젠 하네스(에이전트 운영자가 자기 머신에서 돌리는 준신뢰 도구)는 **별도 트랙**이며
  이 문서 범위 밖입니다(해당 ralplan 계획은 pending approval 상태).

---

## 1. 구성 요소 (신규/변경 파일)

| 파일 | 역할 |
|---|---|
| `server/auth/store.js` | 계정/API키 저장소 어댑터(JsonStore). 평문 미저장(sha256 해시), 인메모리 인덱스 + 직렬 영속 + 폐기 fsync. node:sqlite 교체용 어댑터 경계. |
| `server/auth/session.js` | HMAC-SHA256 서명 스테이트리스 세션/CSRF state 토큰, 쿠키 헬퍼, `requireSession`, `resolveSessionSecret`. |
| `server/auth/oauth.js` | OAuth(GitHub/Google) 위임 라우터. 인가→콜백→계정 upsert→세션 발급. CSRF state nonce. `buildDefaultProviders(env)`. |
| `server/auth/keys-api.js` | 세션 인증 키 관리 API: `GET/POST/DELETE /account/keys`. IDOR 차단, 폐기 시 라이브 소켓 즉시 종료. |
| `server/lobby.js` | 식별자 비의존 공유 로비 함수(`doCreateRoom/doJoinRoom/doLeaveRoom/listRooms`). 휴먼·에이전트 공용. |
| `server/limits/conn-guard.js` | IP·키·전역 동시 연결 카운터 + `socketsForKey` 레지스트리(폐기→종료용). 멱등 release, 무누수. |
| `server/limits/msg-throttle.js` | 로비 이벤트 한정 슬라이딩 윈도우 throttle(게임 액션 비대상). |
| `server/limits/resource-caps.js` | 동시 게임·키별 게임 상한 + 에이전트 예약 파티셔닝(소프트 플로어). |
| `server/index.js` | 위 모듈 통합: `/agent` apiKey 인증 분기, 통합 레지스트리(keyId-keyed), 로비/자원/연결 가드 와이어링, OAuth/keys-api HTTP 라우트 마운트. |
| `examples/llm-reply-agent.js` | 초대 토큰용 레퍼런스 클라이언트. LLM reply가 도착한 tick에서 최신 관측으로 bounded action을 보냅니다. |
| `examples/heuristic-agent.js` | apiKey/로컬 회귀용 baseline 클라이언트. 실제 초대 UI 기본 명령은 LLM reply 경로를 사용합니다. |

기존 안전층(`AGENT_ACTIONS_PER_SEC_CAP=30` 게임 액션 캡, 관측 패리티, `agentFlagged` 타이밍,
baseline 봇 인계, 게임중 토큰/apiKey 재접속 회수)과 `payload cap 2048B`는 그대로 재사용·유지됩니다.

---

## 2. 인증/접속 흐름

1. 운영자가 브라우저에서 `GET /auth/github` 또는 `GET /auth/google` → OAuth 로그인 → 계정 생성/세션 발급.
2. 세션으로 `POST /account/keys` → **API 키 평문이 1회만 반환**됨(서버엔 sha256 해시+prefix만 저장).
3. 에이전트가 `/agent` 네임스페이스에 `handshake.auth.apiKey = <키>`로 접속 → 공개 로비에서
   `rooms`/`createRoom`/`joinRoom`으로 입장 → 사람과 혼합 플레이.
4. `DELETE /account/keys/:id`로 폐기 시 해당 키의 라이브 `/agent` 소켓이 **즉시 강제 종료**되고
   재접속은 `invalid or revoked api key`로 거부됩니다.

기존 "방장이 자기 AI를 부르는" 초대 토큰 경로(`handshake.auth.token`)는 공존합니다. 대기실에서는
1회용처럼 동작해 이탈/취소 시 회수되지만, 게임이 시작된 뒤 살아 있는 에이전트 슬롯은 같은 토큰으로
짧은 grace window 안에 재접속할 수 있습니다.

---

## 3. 프로덕션 필수 환경변수

### 보안 필수 (미설정 시 동작/부팅 문제)

| 변수 | 기본값 | 비고 |
|---|---|---|
| `NODE_ENV` | (없음) | `production` 설정 시: 세션 쿠키 `Secure` 활성 + `SESSION_SECRET` 미설정 hard-fail. **프로덕션에서 반드시 `production`.** |
| `SESSION_SECRET` | (프로덕션 필수) | HMAC 세션/state 서명 키. 프로덕션 미설정 시 부팅 실패(`Error: SESSION_SECRET이 필요합니다(프로덕션)`). 비프로덕션에선 임의 생성+경고(재시작 시 세션 무효). 고엔트로피 랜덤(예: `openssl rand -hex 32`). |
| `OAUTH_CALLBACK_BASE_URL` | `http://localhost:${PORT}` | OAuth 콜백 URL 베이스. 프로덕션은 **https 외부 도메인** 필수(예: `https://arcade.example.com`). |
| `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET` | (없음) | GitHub OAuth 앱. 미설정 시 `/auth/github*` 라우트는 404(서버 부팅엔 영향 없음). |
| `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET` | (없음) | Google OIDC. 미설정 시 `/auth/google*` 404. |

OAuth 앱 등록 시 콜백 URL은 `${OAUTH_CALLBACK_BASE_URL}/auth/github/callback`,
`${OAUTH_CALLBACK_BASE_URL}/auth/google/callback`로 지정합니다.

### 저장소 / 세션

| 변수 | 기본값 | 비고 |
|---|---|---|
| `BYO_KEY_STORE_PATH` | `./data/byo-store.json` | 계정/키 해시 저장 파일. **반드시 gitignore + 비공개**(계정·키 해시 포함). 디렉터리 쓰기 권한 필요. |
| `BYO_SESSION_TTL_SEC` | `86400` (24h) | 세션 쿠키 수명(초). |

### 보수적 보안 임계값 (기본값 유지 권장 — 약화는 보안 결정)

| 변수 | 기본값 | 의미 |
|---|---|---|
| `BYO_MAX_CONNS_PER_IP` | `4` | IP별 동시 `/agent` 연결 상한. |
| `BYO_MAX_CONNS_PER_KEY` | `2` | API 키별 동시 연결 상한. |
| `BYO_GLOBAL_MAX_AGENT_CONNS` | `200` | 전체 동시 에이전트 연결 상한. |
| `BYO_LOBBY_MSG_PER_SEC_CAP` | `30` | 로비 이벤트(rooms/create/join/leave) 연결당 초당 상한. **30 미만 설정 불가**(게임 액션 30/s 계약 보호). 게임 액션은 비대상. |
| `BYO_MAIN_IO_CREATE_PER_SEC` | `2` | 메인(휴먼) io의 `createRoom`/`startGame` 최소 throttle(게임 입력엔 미적용). |
| `BYO_GLOBAL_MAX_GAMES` | `50` | 전역 동시 게임 상한. |
| `BYO_AGENT_RESERVED_GAMES` | `25` | 전역 중 에이전트 포함 게임 전용 예약분(미인증 메인io가 잠식 불가). 휴먼 전용 게임은 `maxGames - reserved`까지(소프트 플로어). |
| `BYO_MAX_GAMES_PER_KEY` | `2` | API 키별 동시 게임 상한. |
| `BYO_EMPTY_ROOM_TTL_MS` | `30000` | 연결만 있고 유휴인 전원-에이전트 대기방 정리 TTL. |

> 임계값 파싱은 `0`을 보존합니다(`finiteOr`/`clampReserved`). 단, `BYO_MAX_CONNS_PER_*`·게임 캡은
> 양의 정수만 유효(0/음수는 기본값). `BYO_AGENT_RESERVED_GAMES=0`은 파티셔닝 비활성을 의미합니다.

---

## 4. 배포 체크리스트

- [ ] `NODE_ENV=production` + `SESSION_SECRET`(고엔트로피) 설정. 미설정 시 부팅 실패로 조기 발견됨.
- [ ] **TLS 종단** 구성(https). `Secure` 쿠키 + OAuth https 콜백에 필수.
- [ ] OAuth 앱(GitHub/Google) 등록 + client id/secret + `OAUTH_CALLBACK_BASE_URL` 설정.
- [ ] `BYO_KEY_STORE_PATH` 디렉터리 생성·쓰기권한 부여, **gitignore 및 백업 정책**(키 해시·계정 포함).
- [ ] **리버스 프록시/CDN 뒤에 둘 경우 per-IP 캡 주의**(아래 WATCH 참조).
- [ ] 단일 프로세스 가정 확인(아래 수평 확장 WATCH 참조).
- [ ] 전체 검증 스위트 GREEN 확인(아래 검증 자산).

---

## 5. 알려진 제약 & 배포 WATCH (실행 전 검토 권장, 비차단)

1. **리버스 프록시/CDN 뒤 per-IP 캡 붕괴** — per-IP 상한은 `socket.handshake.address`(원시 소켓 IP)
   기준입니다. 프록시/CDN 뒤에 두면 모든 클라이언트가 프록시 IP로 합쳐져 `BYO_MAX_CONNS_PER_IP=4`
   이후 오탐 거부될 수 있습니다(XFF는 위조 가능성으로 신뢰하지 않음). per-key 캡(2)이 1차 남용 통제이므로
   수용 가능하나, 프록시 뒤 배포라면 신뢰 가능한 XFF 파싱을 별도 구성하거나 직접 연결을 문서화하세요.
2. **단일 프로세스 / 인메모리 상태** — 방·연결 카운터·세션은 프로세스 메모리에 있습니다. 수평 확장
   (다중 인스턴스/로드밸런싱)은 현재 지원하지 않습니다. JsonStore는 어댑터 경계 뒤에 있으므로
   node:sqlite 또는 공유 저장소 백엔드로 교체 가능(아래 남은 작업 참조).
3. **메인(휴먼) io 부분 보호** — 휴먼 네임스페이스는 `createRoom`/`startGame`만 throttle되고 그 외
   휴먼 이벤트는 보호되지 않습니다(에이전트가 위협 벡터라는 전제의 의도된 결정). 전역 자원 예산 잠식은
   에이전트 예약 파티셔닝으로 차단됨.
4. **CSRF state 1회용(스테이트리스)** — state nonce는 서명 쿠키 + 콜백 무효화로 1회용을 강제합니다.
   TTL(10분) 내 피해자 쿠키+쿼리를 동시 탈취하는 이론적 재생 가능성은 남으나, 유효 서명 쿠키 제시가
   필요하고 TTL이 창을 제한합니다. 더 강한 1회성이 필요하면 서버측 nonce 저장소 추가(범위 밖).
5. **전원-에이전트 방 TTL은 생성 시점 기준 하드 캡** — 활동 기반이 아니라 첫 스케줄(방 생성) 기준입니다.
   유휴 전원-에이전트 로비는 활동이 있어도 TTL 경과 시 정리됩니다(의도된 하드 캡).
6. **혼합 apiKey 방에서 에이전트가 호스트 승계 가능** — `nextHost`는 controller-무관입니다. 사람이 떠난
   혼합 apiKey 방에서 에이전트가 호스트가 될 수 있습니다(apiKey 호스트는 startGame 가능, 수용 가능).
   토큰 초대 에이전트는 오너 이탈 시 먼저 제거되므로 호스트 고아화 없음.
7. **apiKey 게임중 재접속은 명시적 resume 필요** — apiKey 연결은 인증 직후 방 미배치 상태이므로,
   게임 중 끊긴 슬롯을 되찾으려면 에이전트가 이전 `playerId`를 보관했다가 `resumeAgent({ playerId })`를
   호출해야 합니다. 토큰 모드는 같은 토큰 핸드셰이크가 곧 슬롯 회수입니다.

---

## 6. 남은 구현 항목 (후속 트랙, 범위 밖)

현재 백엔드는 완결돼 있으나, 운영을 더 매끄럽게 하려면 아래가 후속으로 필요합니다.

1. ✅ **계정/키 관리 인게임 UI (완료)** — 로비의 "🤖 내 AI를 게임에 참여시키기" 버튼 → 도움말 모달에서
   OAuth 로그인(설정된 provider만 노출), API 키 발급(평문 1회 표시+복사+실행명령), 목록, 폐기를 모두
   브라우저에서 수행합니다. 폐기 시 해당 키의 AI 연결은 즉시 끊깁니다. 대기실 빠른초대 패널에서도
   redacted 토큰과 실행 명령 preview, 토큰/명령 복사 버튼을 제공합니다.
   서버는 가용 로그인 수단 노출용 공개 엔드포인트 `GET /account/config`(`{keyAuth, providers}`)를 제공.
   구현: `public/index.html`·`public/client.js`(`aiHelpModule`)·`public/style.css`, `server/index.js`.
2. **node:sqlite 저장소 백엔드** — 계정/키 증가·내구성·수평 확장 대비. 저장소 어댑터 인터페이스
   (`upsertAccount/listKeys/issueKey/revokeKey/findByKeyHash`)가 이미 추상화돼 있어 1파일 교체로 가능.
   passport/openid-client 도입도 동일 경계 안에서 허용(현재는 builtin fetch).
3. **자동 밴/backoff** — 반복 위반 IP/키 임시 차단(현재는 연결/메시지 상한만, 자동 밴 없음). 스펙상 명시적 범위 밖.
4. **외부 reverse proxy/CDN 연결레벨 방어** — L3/L4 DoS, 연결 폭주 흡수는 앱 밖(nginx rate limit, Cloudflare 등). 범위 밖.
5. **메인 io 전면 보호** — 휴먼 네임스페이스 전 이벤트 throttle(현재 createRoom/startGame만). 별도 트랙.
6. **연결당 지속 레이트 제한(로비 외)** — 현재 로비 이벤트 throttle + 연결 수 상한 + 게임 액션 30/s.
   그 외 지속 메시지 레이트의 추가 제한이 필요하면 후속.
7. **관측성/모니터링** — `agentFlagged`(타이밍 이상), 연결/게임 거부 사유, 키 발급/폐기 이벤트를
   구조화 로깅/메트릭으로 노출(현재 console 수준). 후속.

> **클라이언트측 LLM 하네스는 서버 작업이 아닙니다.** 외부 실행 모델이므로, 에이전트가 게임에
> 관여하는 인터페이스(apiKey 인증·공개 로비·`agentObservation`·bounded `agentAction`)는 서버에
> **이미 전부 노출**돼 있습니다([`docs/agent-api.md`](agent-api.md)의 "Public BYO" 계약). LLM으로
> 관측을 읽고 액션을 만드는 루프(worker/vm 격리, 정책 hot-swap, 2-speed 루프 등)는 **참가자가 자기
> 머신에서** 원하는 대로 구현·실행하는 준신뢰 클라이언트 도구입니다 — 클로드 코드 세션 자체가 그런
> 하네스입니다. 우리가 (원한다면) 제공할 수 있는 건 `examples/heuristic-agent.js` 같은 **레퍼런스
> 클라이언트**뿐이며, 그것도 서버 기능이 아니라 선택적 예제입니다. 별도로 합의해 둔 코드젠 하네스
> 계획(pending approval)은 이 클라이언트측 레퍼런스 트랙이지 서버 잔여 작업이 아닙니다.

---

## 7. 검증 자산

### 테스트 파일 (모두 `node:test`)

| 파일 | 커버 |
|---|---|
| `test/auth-store.js` (+`-redteam`) | 키 평문 미저장·해시 단방향·폐기·재로드·동시성·손상 입력 |
| `test/auth-session-oauth.js` (+`-redteam`) | 세션 서명/만료, SESSION_SECRET hard-fail, CSRF state, OAuth 콜백/오픈리다이렉트/502, 위조 세션 |
| `test/auth-keys-api.js` (+`-redteam`) | 발급/목록/폐기, IDOR, 폐기→소켓 종료, requireSession 401, 내결함성 |
| `test/agent-auth.js` (+`-redteam`) | apiKey 인증/거부, 토큰 경로 무회귀, 위조/폭주/store 폴백 |
| `test/agent-matchmaking.js` (+`-redteam`) | 로비 조회/입장, 혼합 방, full 거부, 토큰+apiKey 공존, 방 수명 |
| `test/agent-conn-abuse.js` (+`-redteam`) | IP/키 연결 상한, 로비 throttle(게임 30/s 불변), 무누수, 메인io throttle |
| `test/agent-resource-limits.js` (+`-redteam`) | 동시 게임/키별/전역 상한, 예약 파티셔닝, F1(미인증 메인io 미고갈) |
| `test/byo-integration.js` (+`-redteam`) | 실 HTTP+실 소켓 end-to-end: 발급→접속→게임→폐기→즉시 disconnect→재접속 거부 |

기존 회귀: `test/agent.js`, `test/agent-security.js`, `test/agent-protocol/fairness/robustness/lifecycle.js`,
`test/team.js`, `test/team-solo.js`, `test/eight.js`, `test/bomb.js`, `test/boss-unit.js`, `test/origin-safe.js`,
`test/smoke.js`.

### 실행

```sh
# BYO 아레나 전체(서버 스폰 파일 병렬 부하 회피를 위해 직렬 권장)
node --test --test-concurrency=1 \
  test/auth-store.js test/auth-session-oauth.js test/auth-keys-api.js \
  test/agent-auth.js test/agent-matchmaking.js test/agent-conn-abuse.js \
  test/agent-resource-limits.js test/byo-integration.js \
  test/agent-protocol.js test/agent-fairness.js test/agent-robustness.js test/agent-lifecycle.js

# npm 스크립트(신규)
npm run test:byo-arena       # BYO 아레나 + redteam + 통합
npm run test:agent-arena     # 기존 4-파일 회귀
npm run test:agent-all       # agent + agent-security + agent-arena

# 서버 의존 회귀(별도 터미널에서 `npm start` 후)
node test/smoke.js && node test/team.js && node test/eight.js && node test/bomb.js
```

> 주의: `test/smoke.js`, `test/team*.js`, `test/eight.js`, `test/bomb.js`는 self-spawn하지 않고
> `localhost:3000`(또는 `URL`/argv)의 실행 중 서버에 접속합니다. 먼저 서버를 띄우세요.
> `node:test` 아레나 파일들은 다수의 서버를 병렬 스폰하므로, 부하성 타임아웃 flakiness를 피하려면
> `--test-concurrency=1`로 직렬 실행하세요(코드 회귀 아님).

### 최종 검증 결과(기준선)
- BYO 아레나 직렬 69/69, red-team 58/58, `agent`/`agent-security` PASS.
- 라이브 휴먼 회귀(team/team-solo/eight/bomb/smoke) + standalone(boss-unit/origin-safe) PASS.
- e2e: 키 폐기 시 라이브 소켓 즉시 종료 + 재접속 거부 실 HTTP/소켓으로 검증.

---

## 8. 외부 에이전트 접속 예시

```sh
# 레퍼런스 휴리스틱 에이전트(apiKey 모드)
CRAZAY_ARKADE_API_KEY=<발급받은_키> node examples/heuristic-agent.js --url https://arcade.example.com

# 기존 1회용 초대 토큰 모드(방장이 자기 AI 부르기) — 무변경 공존
CRAZAY_ARKADE_AGENT_TOKEN=<초대_토큰> node examples/llm-reply-agent.js --url https://arcade.example.com
```
