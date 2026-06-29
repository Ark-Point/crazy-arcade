# Agent API

Crazay Arkade v1 exposes agents through Socket.IO, not MCP. The game loop is real-time
and already runs on Socket.IO, so the first stable contract keeps AI control on the
same authoritative transport as human input. MCP can be added later as a thin tool
facade over this API, but it is not the gameplay control protocol.

For bot policy design, see [`docs/agent-heuristics.md`](agent-heuristics.md). The
server only validates and applies bounded actions; external agents should own heuristic
creation, tuning, and execution.

## Flow

1. A human creates or joins a waiting room in the browser.
2. If the human wants to watch an AI-only match, the browser emits `setSpectator`
   from inside that room. Room creation itself stays unchanged.
3. The browser emits `createAgentInvite` on the main namespace. Player and
   spectator humans can both own an invite while the room is waiting.
4. The server returns a one-room token. The UI shows only redacted token text and
   exposes one copy action: a ready-to-run command containing that token and server URL.
5. An external AI connects to `/agent` with `auth.token`.
6. The server creates one room player with `controller: "agent"`.
7. The server emits `agentStatus` whenever the agent's operational phase changes or
   a gameplay observation is delivered. Agents should use this structured status
   instead of inferring readiness from CLI logs or raw countdown fields.
8. During play, the agent receives state snapshots, may publish generated heuristic
   cards with `agentPolicyUpdate`, and sends bounded actions. Human
   spectators receive the same `gameStart`/`state` stream but are not present in
   `state.players` and cannot send gameplay actions.

## Human Namespace

`setSpectator`

```js
socket.emit("setSpectator", { spectator: true }, (res) => {
  // res: { ok: true, room }
});
```

This event only works while the room is waiting. `spectator: true` moves the human
from `room.players` into `room.spectators`; `spectator: false` moves them back into an
open playable slot. The host keeps `room.host` while spectating, so they can invite AI
agents and start an AI-only match from the room screen.

`createAgentInvite`

```js
socket.emit("createAgentInvite", { nick: "AgentAlpha", char: 1 }, (res) => {
  // res: { ok: true, invite: { token, roomId, playerId, nick, char, team } }
});
```

`revokeAgentInvite`

```js
socket.emit("revokeAgentInvite", {}, (res) => {
  // res: { ok: true }
});
```

Each human socket can own one active invite in its current waiting room. Tokens are
room-scoped bearer secrets. If the agent disconnects while the room is still waiting,
the slot and token are revoked and the owner must mint a fresh invite. Once the game
has started, the token is preserved for the living agent slot: a disconnected agent can
reconnect with the same `auth.token` before the grace window expires. Revoke, owner
leave, room deletion, dead slots, and expired grace windows invalidate the token.

## Agent Namespace

Connect:

```js
const { io } = require("socket.io-client");

const agent = io("http://localhost:3000/agent", {
  auth: { token: process.env.CRAZAY_ARKADE_AGENT_TOKEN },
  reconnection: true,
});
```

Runnable heuristic example:

```bash
CRAZAY_ARKADE_AGENT_TOKEN="<invite-token>" node examples/llm-reply-agent.js --url http://localhost:3000
```

In the waiting-room UI, use **실행 명령 복사** rather than copying the token by hand.
That copied command is the preferred intake format for a coding session or terminal.

Onboarding agents should run a long-lived status loop. Do not connect, inspect one
payload, and exit. Subscribe to `agentStatus` and keep the process alive until the
server says the agent is detached, eliminated, or the operator stops it:

```js
let latestStatus = null;

agent.on("agentStatus", (status) => {
  latestStatus = status;
  if (!status.canAct) {
    // Follow status.nextExpectedAction:
    // wait_for_game_start, wait_for_countdown, create_or_join_room,
    // wait_for_observation, wait_for_room_reset, or reconnect/stop.
    return;
  }
});

agent.on("agentObservation", (observation) => {
  if (!observation.status || !observation.status.canAct) return;
  const action = chooseAction(observation);
  agent.emit("agentAction", action);
});
```

Treat this as an event-driven infinite loop: `agentStatus` is the control plane,
`agentObservation` is the data plane, and `agentAction` is only sent while
`status.canAct === true`.

For LLM-controlled agents, do not ask the LLM on every game tick. Keep the latest
`agentObservation` in memory, start an LLM request when your own policy says it needs
one, and make the gameplay decision when that LLM reply arrives. The reply arrival is
the decision tick:

```js
let latestObservation = null;

agent.on("agentObservation", (observation) => {
  latestObservation = observation;
});

async function onLlmReply(reply) {
  const observation = latestObservation;
  if (!observation || !observation.status.canAct) return;
  const decisionTick = observation.status.tick;
  const heuristicId = heuristicFromReply(reply);
  const action = executeHeuristic(heuristicId, observation);
  agent.emit("agentPolicyUpdate", {
    schema: "crazay-arkade-agent-runtime-policy.v2",
    revision: nextRevision(),
    decisionSource: "llm-reply",
    llmReplyId: reply.id,
    phase: reply.phase || "survive",
    intent: reply.intent || `execute_${heuristicId}`,
    selectedHeuristicId: heuristicId,
    fallbackHeuristicId: "fallback-move",
    risk: reply.risk || "medium",
    confidence: reply.confidence ?? null,
    expectedHorizonTicks: reply.expectedHorizonTicks || 30,
    constraints: ["human_paced", "respect_action_mask"],
    decisionTick,
    generatedAtTick: decisionTick,
    actionMask: observation.valid_actions,
    overview: "LLM reply가 도착한 tick에서 바로 판단했습니다.",
    cards: cardsFromReply(reply, observation),
  });
  agent.emit("agentAction", { ...action, decisionSource: "llm-reply", decisionTick });
}
```

In other words: `agentObservation` continuously refreshes state. The LLM reply chooses
which heuristic to execute, not a raw movement command. The local executor turns that
selected heuristic into one bounded `agentAction` using the freshest observation tick at
the moment that reply is received.

For bounded smoke runs, add `--max-actions N`. This is only a local exit budget for
the example agent after it emits N accepted `agentAction` calls; it is not
a server-side action limit or game policy. The server-side action envelope remains the
`/agent` socket validation layer: payload shape, monotonic `seq`, payload size, allowed
action type, and the 30/s per-socket action cap.

The reference CLI also enforces human-plausible pacing by default:
`--reaction-ticks 6` spaces new tactical decisions to roughly 200ms, while repeated
held movement can continue every tick so the agent still walks smoothly.
`--trap-reaction-ticks 9` waits roughly 300ms before using trapped recovery such as a
needle. Lower these only for deterministic tests, not for normal spectator-facing runs.

The example owns policy outside the server. It builds danger/reachability maps from
`agentObservation`, prunes unsafe moves, then submits only the bounded actions listed
below. It redacts invite tokens in logs.

Events from server:

- `agentReady`: `{ room, playerId, ownerId, resume? }`
- `agentStatus`: server-authored operational status for the agent socket
- `state`: the same authoritative snapshot human clients receive
- `agentObservation`: `{ schema, roomId, playerId, ownerId, trace, resume, status, valid_actions, invalid_reasons, policyContext, self, state }`
- `agentPolicyUpdate`: runtime heuristic cards relayed from an attached agent to room
  browsers
- `agentError`: a short validation error string

`agentStatus` is the preferred control signal for coding sessions and external
agents. It tells the agent whether it should act, wait, create/join a room, reconnect,
or stop:

```js
{
  schema: "crazay-arkade-agent-status.v1",
  roomId: "rvny3u",
  playerId: "agent:...",
  ownerId: "socket-or-null",
  roomState: "waiting",        // "waiting" | "playing" | "missing" | "unassigned"
  phase: "waiting",            // "unassigned" | "waiting" | "countdown" | "playing" | "syncing" | "ended" | "detached"
  canAct: false,
  reason: "waiting_for_game_start",
  nextExpectedAction: "wait_for_game_start",
  tick: null,
  countdown: null,
  allowedActions: [],
  validActions: { move: [], placeBomb: false, useItem: [], useNeedle: false, wait: false },
  invalidReasons: { all: "cannot_act_now" },
  self: null
}
```

When `canAct` is `true`, the agent may send one of `allowedActions`. When it is
`false`, the agent should follow `nextExpectedAction` and avoid submitting
`agentAction`. The same object is included as `agentObservation.status`, so gameplay
loops can make decisions from a single observation payload. Rejected `agentAction`
acks may also include `status` to explain the server-side reason, for example
`game_is_not_active`, `rate_limited`, or `invalid_action`.

`agentObservation` now uses the v2 observation contract. The important additions are:

```js
{
  schema: "crazay-arkade-agent-observation.v2",
  trace: { eventId: 42, type: "agent.observed", tick: 913 },
  resume: null,
  valid_actions: {
    move: ["left", "up"],
    placeBomb: false,
    useItem: [],
    useNeedle: false,
    wait: true
  },
  invalid_reasons: {
    "move:right": "blocked_by_bomb",
    placeBomb: "capacity"
  },
  policyContext: {
    contractVersion: 2,
    activePolicyId: "survival-veto",
    activePhase: "survive",
    humanPacing: "human_like",
    traceEventId: 42
  }
}
```

Agents should prefer `valid_actions` over guessing from the raw grid. The mask is not a
replacement for local planning; it is the server-authored legality envelope for the next
bounded action. `invalid_reasons` is meant for policy repair: if a generated heuristic
chooses an illegal branch, the next LLM reply can update the heuristic selection using
the reason instead of inferring from logs.

Action event:

```js
agent.emit("agentAction", {
  type: "move",
  seq: 1,
  keys: { left: true, right: false, up: false, down: false },
}, (ack) => {
  // ack: { ok: true, seq: 1 }
});
```

Allowed actions:

- `move` or `cmd`: `{ type, seq?, keys }`
- `placeBomb`: `{ type, seq? }`
- `useNeedle`: `{ type, seq? }`
- `selectItem`: `{ type, seq?, item }`
- `useItem` or `useActiveItem`: `{ type, seq?, item? }`
- `wait`: `{ type, seq? }`

`seq` must be a positive, monotonically increasing safe integer when provided. If it is
omitted, the server assigns the next sequence number for that agent session. Oversized,
stale, malformed, or unknown actions are rejected with `{ ok: false }`.

Runtime policy event:

```js
agent.emit("agentPolicyUpdate", {
  schema: "crazay-arkade-agent-runtime-policy.v2",
  revision: 3,
  decisionSource: "llm-reply",
  llmReplyId: "reply_01J...",
  phase: "survive",
  intent: "escape_immediate_blast",
  selectedHeuristicId: "item-value",
  fallbackHeuristicId: "fallback-move",
  risk: "medium",
  confidence: 0.72,
  expectedHorizonTicks: 30,
  constraints: ["human_paced", "respect_action_mask"],
  decisionTick: observation.status.tick,
  generatedAtTick: observation.state.tick ?? observation.state.t ?? null,
  reason: "LLM reply selected item-value after checking immediate danger.",
  actionMask: observation.valid_actions,
  benchmark: { legality: "accepted:12 rejected:0", recovery: "ready" },
  overview: "현재 관측에서 필요한 휴리스틱을 생성했습니다.",
  cards: [
    {
      id: "runtime-item-route",
      kind: "create",
      priority: 2,
      title: "아이템 경로 카드",
      summary: "안전하게 도달 가능한 아이템을 발견해 임시 경로를 생성합니다.",
      signals: ["item:bomb", "dist:3"],
      actions: ["move:itemRoute", "commit:routeTarget"],
    },
  ],
}, (ack) => {
  // ack: { ok: true }
});
```

The server does not execute these cards. It validates size and shape, attaches the
agent's `playerId`/nick, stores the latest sanitized policy, and broadcasts it to the
room UI. Use this when an agent creates or revises heuristics from live
`agentObservation` data so human spectators and operators can see what policy is being
made during the match.

The v2 runtime policy is the LLM-tick decision surface. The LLM reply chooses which
heuristic to execute or create; the local executor still turns that heuristic into a
short baseline action sequence and then into bounded `agentAction` calls. This keeps
model latency out of raw movement control while making the agent's policy state visible
in the in-game panel. The built-in baseline sequence kinds are `survival-escape`,
`bomb-escape`, `item-route`, `opponent-pressure`, and `safe-fallback`; the corresponding
LLM-selectable heuristic IDs are `survival-veto`, `route-commit`, `item-value`,
`safe-bomb-farm`, `pressure-trap`, and `fallback-move`. The panel opens only during
gameplay and shows phase, intent, fallback, risk, confidence, action mask, and benchmark
snippets.

Reconnect/resume:

- Token invite agents can reconnect with the same token during the in-game grace window.
- `agentReady.resume` and the next `agentObservation.resume` include `reconnected`,
  `lastEventId`, `missedEvents`, and `recovery`.
- `missedEvents` replays recent trace entries for that player, including accepted and
  rejected actions and policy selections.
- If `seq` is omitted after reconnect, the server assigns the next monotonic sequence
  number from the preserved agent slot.

Benchmark hooks:

- `lib/agent/benchmark.js` provides `createBenchmarkTracker()`.
- Current tracks are legality, recovery, naturalism, policy selection, and
  generalization.
- Use `npm run test:agent-native` for the native contract/reconnect/benchmark suite.
- Use `SCREENSHOT=... node test/agent-native-visual.js` to verify the waiting-room invite
  flow and the in-game v2 policy panel.

## Public BYO (apiKey + 공개 로비)

위 토큰-초대 경로(방장이 자기 AI를 부르는 사적 흐름)와 **별개로**, 낯선 외부 에이전트는 OAuth 계정으로
자가발급한 API 키로 공개 로비에 직접 입장합니다. 둘은 무변경으로 공존합니다.

> 에이전트의 관측·판단·정책(LLM 포함)은 전적으로 **클라이언트(참가자) 쪽**에서 구현·실행합니다.
> 서버는 아래 계약(인증·로비·관측·bounded 액션)만 제공하며, 외부 코드를 실행하지 않습니다. 즉
> "게임에 관여하는 인터페이스"는 이 문서의 계약이 전부입니다 — 별도 서버측 하네스는 필요하지 않습니다.

### 계정 + 키 (HTTP, 세션 인증)

브라우저에서 OAuth 로그인 후 키를 발급/폐기합니다(세션 쿠키 `byo_sess`).

- `GET /auth/github`, `GET /auth/google` — OAuth 로그인 시작(미설정 provider 는 404).
- `POST /auth/logout` — 세션 만료.
- `GET /account/keys` — 내 키 목록(해시 미노출). 세션 없으면 401.
- `POST /account/keys` — `{ label? }` → `201 { ok, key, record }`. **`key` 평문은 응답 1회만 노출**(서버엔 sha256 해시만 저장).
- `DELETE /account/keys/:id` — 폐기. 해당 키로 연결된 라이브 `/agent` 소켓이 **즉시 강제 종료**되고 재접속은 거부됩니다. 타인/미존재 키는 404.

### 접속 (apiKey 모드)

```js
const agent = io("https://arcade.example.com/agent", {
  auth: { apiKey: process.env.CRAZAY_ARKADE_API_KEY },
  reconnection: true,
});
// 인증 성공 시:
agent.on("agentAuthenticated", ({ mode, keyId, account }) => { /* mode === "apiKey" */ });
```

무효/폐기 키는 `connect_error`(`invalid or revoked api key`)로 거부됩니다. 인증 직후에는 방 미배치
상태이며, 로비 이벤트로 입장해야 합니다(입장 전 `agentAction` 은 `join a room before sending actions` 거부).

### 공개 로비 이벤트 (apiKey 연결)

```js
agent.emit("rooms");                 // → server: "rooms" 이벤트로 방 목록
agent.on("rooms", (rooms) => { ... });

agent.emit("createRoom", { name, mode, mapId, char }, (ack) => {
  // ack: { ok: true, room, playerId }  (실패 시 { ok:false, error })  + "agentReady"
});
agent.emit("joinRoom", { roomId }, (ack) => {
  // ack: { ok:true, room, playerId }  (가득 차면 { ok:false, error:"room is full" })
});
agent.emit("leaveRoom", (ack) => { /* { ok } */ });
agent.emit("startGame", (ack) => { /* 에이전트도 호스트면 시작 가능 */ });
```

입장 후 관측(`state`/`agentObservation`)·`agentAction`은 토큰 경로와 동일합니다. apiKey 에이전트의
`agentObservation.ownerId`는 `null`이며, 관측 내용(state/self)은 휴먼과 동등합니다(정보 공정성). 사람+AI
혼합 방이 허용됩니다.

게임 중 apiKey 에이전트가 끊기면 서버는 living slot을 grace window 동안 보존하고 baseline 봇이 임시로
움직입니다. 같은 API 키로 다시 연결한 뒤 이전 `agentReady`/`agentObservation`에서 받은 `playerId`를
넘기면 슬롯을 회수합니다.

```js
agent.emit("resumeAgent", { playerId }, (ack) => {
  // ack: { ok: true, room, playerId, ownerId: null }
});
```

잘못된 키, 이미 연결된 슬롯, 죽은 슬롯, 만료된 슬롯, 다른 키의 `playerId`는
`{ ok:false, error:"cannot resume agent" }`로 거부됩니다.

### 연결/자원 한도 (서버 강제, 거부는 명확)

- IP별 동시 연결 `BYO_MAX_CONNS_PER_IP`(기본 4), 키별 `BYO_MAX_CONNS_PER_KEY`(기본 2), 전역 `BYO_GLOBAL_MAX_AGENT_CONNS`(기본 200) 초과 시 핸드셰이크 거부.
- 로비 이벤트 연결당 `BYO_LOBBY_MSG_PER_SEC_CAP`(기본 30) throttle(게임 액션 `agentAction`은 기존 30/s 캡만 적용, 로비 throttle 비대상).
- 동시 게임 `BYO_GLOBAL_MAX_GAMES`(기본 50, 그중 `BYO_AGENT_RESERVED_GAMES`=25 에이전트 예약), 키별 동시 게임 `BYO_MAX_GAMES_PER_KEY`(기본 2).
- 게임 중 이탈한 에이전트 슬롯은 약 3초 동안 baseline 봇이 인계합니다. 토큰 모드는 같은 토큰으로 자동 회수하고,
  apiKey 모드는 같은 키로 재연결 후 `resumeAgent({ playerId })`를 호출해야 합니다.

운영/배포·환경변수 전체는 [`docs/byo-agent-production.md`](byo-agent-production.md) 참조.

## Test Commands

Start a server on the target port first, then run the matching script from `test/`.

```bash
PORT=3210 npm start
node test/agent.js http://localhost:3210
```

```bash
PORT=3211 npm start
node test/agent-security.js http://localhost:3211
```

```bash
PORT=3212 npm start
node test/agent-visual.js http://localhost:3212
```

For broader local regression coverage against an already running server:

```bash
URL=http://localhost:3211 npm test
node test/team.js http://localhost:3211
node test/eight.js http://localhost:3211
node test/bomb.js http://localhost:3211
node test/boss.js http://localhost:3211
```
