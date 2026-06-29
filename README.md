# 💧 크레이지 앜케이드 (웹 멀티플레이)

크레이지 앜케이드 스타일의 웹 기반 멀티플레이 물풍선 게임입니다.
Node.js + Socket.IO 서버가 게임 로직을 권위적으로 처리하고, 클라이언트는 HTML5 Canvas로 렌더링합니다.

## 실행

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속. 멀티플레이 테스트는 브라우저 탭을 여러 개 열면 됩니다.

Cloudflare Quick Tunnel로 임시 공개:

```bash
npm run deploy:tunnel
```

다른 포트로 띄우려면:

```bash
PORT=4000 npm run deploy:tunnel
```

스크립트는 로컬 서버가 이미 떠 있으면 재사용하고, 없으면 `npm start`로 서버를 실행한 뒤
`cloudflared tunnel --url http://localhost:$PORT`를 시작합니다. 기본 포트 `3000`에 다른 앱이 떠 있으면
이미 떠 있는 Crazay Arkade 서버를 먼저 찾고, 없으면 다음 빈 포트를 찾아 사용합니다. 터널 명령은 실행 중인 동안만
공개 URL이 살아 있으므로 URL이 출력된 뒤 터미널을 열어두세요. 이미 같은 서버로 `cloudflared`가 실행 중이면
기존 공개 URL을 출력합니다. Quick Tunnel은 개발/테스트용 임시 공유에 적합하며, 운영 배포는 Cloudflare의
관리형 Tunnel 설정을 사용하세요.

## 조작법

| 키 | 동작 |
|---|---|
| 방향키 / WASD | 이동 |
| 스페이스 | 물풍선 설치 |
| Ctrl / X | 바늘로 물방울 탈출 |

## 게임 규칙

- 방을 만들거나 입장 (방당 최대 4명), 방장이 ⚔️ 개인전 / 🤝 팀전 / 👾 보스전 선택 후 시작
- 물풍선은 3초 후 십자 물줄기로 폭발, 다른 풍선에 닿으면 연쇄 폭발 (설치된 풍선은 빠져나갈 수만 있는 벽 — 관통 불가)
- 물줄기에 맞으면 물방울에 갇힘(6초) — 시간 초과 또는 적 터치 시 탈락, 바늘로 탈출 가능
- 팀전: 갇힌 아군을 터치하면 구출, 한 팀 전멸 시 상대 팀 승리
- 보스전 (협동 PvE): 물줄기로 킹 옥토 공격. 빨간 예고 장판(물대포)을 피하고,
  착탄 직후 그로기 윈도우(데미지 2배)를 노리세요. HP 66%/33%에서 분노/폭주 페이즈
  (쫄몹 소환, 다중 물대포, 이동 가속). 보스/쫄몹 접촉 시 갇힘 — 동료가 구출.
  처치 시 클리어, 전원 탈락·시간 초과 시 실패.
- 아이템: 🎈 물풍선+1 · 💧 물줄기+1 · 🛼 속도+ · 🪡 바늘(최대 3) · 👟 물풍선 밀기 · 🌊 물줄기 최대
- 2분 라운드 제한 (보스전 3분), 시간 종료 시 무승부

## 아키텍처

- **서버** (`server/game.js`): 30Hz 권위적 시뮬레이션. 클라이언트 입력은 시퀀스 번호가 붙은
  커맨드 큐로 처리되고, 매 스냅샷에 마지막 처리 시퀀스를 에코해서 reconciliation을 지원.
- **공유 이동 코드** (`public/shared.js`): 서버 시뮬레이션과 클라이언트 예측이 동일한
  이동/충돌 코드를 실행 (Valve/Gambetta 표준 패턴).
- **클라이언트** (`public/client.js`):
  - 내 캐릭터 — 클라이언트 사이드 예측 + 서버 reconciliation (미확인 입력 재적용, 오차는 지수 감쇠로 부드럽게 보정)
  - 다른 플레이어 — 서버 타임스탬프 기반 엔티티 보간 (~100ms 과거 렌더, 패킷 1개 유실 허용)
  - 정적 타일 레이어는 오프스크린 캔버스에 프리렌더 후 매 프레임 한 번에 블릿
  - 파티클(물방울/파편/스파클), squash & stretch 애니메이션, 화면 흔들림 등 이펙트
- **AI 참가자 API** (`docs/agent-api.md`): 사람이 대기실에서 토큰을 발급하고 외부 AI가
  Socket.IO `/agent` 네임스페이스로 접속해 권위 서버 루프에 제한된 액션만 제출. 대기실 UI는
  토큰과 실행 명령을 각각 복사할 수 있게 보여주며, 게임 중 에이전트 연결이 끊기면 baseline 봇이
  잠시 슬롯을 인계하고 같은 토큰 또는 apiKey `resumeAgent`로 재접속할 수 있음.
- **AI 휴리스틱 가이드** (`docs/agent-heuristics.md`): 봄버맨/Pommerman 계열 자료를 바탕으로
  외부 에이전트가 안전 필터, 경로 탐색, 폭탄 배치, 아이템, 팀/보스전 휴리스틱을 생성하고 집행하는 방식.
- **AI 예제 봇** (`examples/heuristic-agent.js`, `lib/agent/heuristics.js`): 초대 토큰으로 `/agent`에
  접속해 danger map, BFS reachability, 안전 폭탄 lookahead를 이용해 실제 행동을 제출하는 baseline.

```
server/index.js   # Express 정적 서빙 + Socket.IO 방/로비/팀 관리
server/game.js    # 권위적 게임 시뮬레이션
public/shared.js  # 서버·클라이언트 공유 이동 코드
public/           # 캔버스 클라이언트
docs/agent-api.md  # 외부 AI 참가자용 Socket.IO 계약
docs/agent-heuristics.md # 외부 AI가 생성/집행할 휴리스틱 카드와 정책 루프
lib/agent/heuristics.js # 외부 AI baseline 휴리스틱 엔진
examples/heuristic-agent.js # 초대 토큰으로 실행하는 외부 AI 예제 CLI
test/smoke.js       # 2인 접속 → 이동/폭발/ack 검증
test/agent.js       # AI 참가자 초대→/agent 접속→상태 수신→이동/폭탄/ack 검증
test/agent-heuristic.js # 휴리스틱 엔진 danger/reachability/safe-bomb 단위 검증
test/agent-heuristic-live.js # 실제 서버+초대 토큰+예제 CLI 통합 검증
test/agent-security.js # 토큰 revoke/replay/lifecycle/owner cleanup 보안 회귀
test/agent-visual.js   # Playwright: AI 초대 UI, redaction, revoke, AI 배지 검증
test/team.js        # 팀전 배정/시작 거부/팀 승리 데이터 검증
test/team-solo.js   # 팀전 단독 시작 거부 검증
test/bomb.js        # 물풍선 관통 차단(exit-only) 회귀 테스트
test/boss.js        # 보스전 코어 루프: 텔레그래프→스플래시→갇힘→전멸 패배
test/boss-unit.js   # 보스전 유닛 로직 회귀
test/eight.js       # 8인 정원/4:4 팀 배정/스폰 검증
test/origin-safe.js # 폭발 원점/물줄기 안전성 회귀
test/agent-lifecycle.js # 에이전트 스톨 인계/게임 중 재접속 회수 검증
test/visual.js      # Playwright E2E: 실제 브라우저 2개로 게임 플레이 + 스크린샷
test/boss-visual.js # Playwright E2E: 보스전 플레이 + 스크린샷
```

테스트는 서버를 띄운 상태에서 실행합니다. 기본 smoke는 `npm test`이고, AI 표면은
`npm run test:agent`, `npm run test:agent-heuristic`, `npm run test:agent-security`,
`npm run test:agent-visual`로 확인합니다. 실행형 휴리스틱 봇은 서버를 띄운 뒤
`CRAZAY_ARKADE_AGENT_TOKEN=<초대토큰> node examples/heuristic-agent.js --url http://localhost:3000`으로 접속합니다.
짧은 게임플레이 회귀는 `npm run test:regression`을 사용합니다. 다른 포트 서버를 검증할 때는
`URL=http://localhost:<port> npm test` 또는 `node test/agent.js http://localhost:<port>`처럼
`URL` 환경변수나 첫 번째 CLI 인자를 넘기면 됩니다.
