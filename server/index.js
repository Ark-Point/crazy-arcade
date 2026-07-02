const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Game, COLS, ROWS, TILE } = require('./game');
const { createActionPacer } = require('../lib/agent/action-pacer');
const Catalog = require('../public/catalog');
const {
  createHeuristicAgent,
  HEURISTIC_POLICY_OVERVIEW,
  AGENT_ACTION_BUDGET_NOTE,
  HEURISTIC_POLICY_CARDS,
} = require('../lib/agent/heuristics');
const { createStore, hashKey } = require('./auth/store');
const { resolveSessionSecret, requireSession } = require('./auth/session');
const { createOAuthRouter, buildDefaultProviders } = require('./auth/oauth');
const { createKeysRouter } = require('./auth/keys-api');
const lobby = require('./lobby');
const { createConnGuard } = require('./limits/conn-guard');
const { createMsgThrottle } = require('./limits/msg-throttle');
const { createResourceCaps } = require('./limits/resource-caps');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const BYO_EMPTY_ROOM_TTL_MS = Number(process.env.BYO_EMPTY_ROOM_TTL_MS) || 30000;

// S6 연결남용/DoS 가드 임계값(env, 미설정 시 보수적 기본). 보안 결정으로 기본값을 약화하지 않는다.
const BYO_MAX_CONNS_PER_IP = Number(process.env.BYO_MAX_CONNS_PER_IP) || 4;
const BYO_MAX_CONNS_PER_KEY = Number(process.env.BYO_MAX_CONNS_PER_KEY) || 2;
const BYO_GLOBAL_MAX_AGENT_CONNS = Number(process.env.BYO_GLOBAL_MAX_AGENT_CONNS) || 200;
// 로비 메시지 throttle 상한(30 미만 금지).
const BYO_LOBBY_MSG_PER_SEC_CAP = Math.max(30, Number(process.env.BYO_LOBBY_MSG_PER_SEC_CAP) || 30);
// 메인 io 방 생성/시작 최소 throttle(게임 입력 미적용).
const BYO_MAIN_IO_CREATE_PER_SEC = Number(process.env.BYO_MAIN_IO_CREATE_PER_SEC) || 2;
const CHAT_MAX_CHARS = 100;
const CHAT_HISTORY_LIMIT = 50;
const CHAT_MESSAGES_PER_SEC = 5;

// G007(S7) 자원/동시성 상한(env, 미설정 시 운영 기본). 휴먼 비회귀를 위해 기본값은 넉넉히 둔다.
// finiteOr: 0 을 포함한 유효 숫자는 보존하고, 미설정/비숫자만 기본값으로(0 묵살 footgun 방지).
const finiteOr = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const BYO_GLOBAL_MAX_GAMES = finiteOr(process.env.BYO_GLOBAL_MAX_GAMES, 50);
const BYO_AGENT_RESERVED_GAMES = finiteOr(process.env.BYO_AGENT_RESERVED_GAMES, 25);
const BYO_MAX_GAMES_PER_KEY = finiteOr(process.env.BYO_MAX_GAMES_PER_KEY, 2);

// 입장 거부 메시지(경로별): 휴먼은 기존 한국어, 에이전트는 기존 영어 메시지 유지.
const HUMAN_JOIN_ERROR = {
  not_found: '방이 존재하지 않습니다.',
  playing: '게임이 이미 진행 중입니다.',
  full: '방이 가득 찼습니다.',
};
const AGENT_JOIN_ERROR = {
  not_found: 'room not found',
  playing: 'game already in progress',
  full: 'room is full',
};

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/agent/heuristic-policy', (req, res) => {
  res.json({
    schema: 'crazay-arkade-agent-policy-ui.v1',
    overview: HEURISTIC_POLICY_OVERVIEW,
    actionBudgetNote: AGENT_ACTION_BUDGET_NOTE,
    cards: HEURISTIC_POLICY_CARDS,
  });
});

const server = http.createServer(app);
const io = new Server(server);
const agentIo = io.of('/agent');

const rooms = new Map(); // roomId -> room
const agentTokens = new Map();
const agentRecordsByOwner = new Map(); // token 모드 보조 인덱스: ownerId(host socket.id) -> record
const agentRecords = new Map(); // 통합 primary 레지스트리: playerId -> record (고유)
const agentRecordsByKey = new Map(); // apiKey 모드 보조 인덱스: keyId -> Set<record>

// S6 연결 가드/메시지 throttle 인스턴스(부팅 시 1회 생성).
// connGuard 는 S8 에서 keys-api 의 liveSocketRegistry 로 주입할 수 있게 보관/노출한다.
const connGuard = createConnGuard({
  maxPerIp: BYO_MAX_CONNS_PER_IP,
  maxPerKey: BYO_MAX_CONNS_PER_KEY,
  globalMax: BYO_GLOBAL_MAX_AGENT_CONNS,
});
const msgThrottle = createMsgThrottle({ perSecCap: BYO_LOBBY_MSG_PER_SEC_CAP });
// 메인 io createRoom/startGame 은 각각 독립 슬라이딩 윈도우로 둔다(서로 슬롯을 잠식하지 않게).
const mainCreateThrottle = createMsgThrottle({ perSecCap: BYO_MAIN_IO_CREATE_PER_SEC });
const mainStartThrottle = createMsgThrottle({ perSecCap: BYO_MAIN_IO_CREATE_PER_SEC });
const mainChatThrottle = createMsgThrottle({ perSecCap: CHAT_MESSAGES_PER_SEC });

// G007(S7) 자원/동시성 상한 인스턴스. rooms 의 'playing' 방 수를 전역/예약/키별로 게이트한다.
// isAgentRoom/keyIdsForRoom 은 room.players + agentRecords 로 방의 성격/키 소속을 해석한다.
const resourceCaps = createResourceCaps({
  maxGames: BYO_GLOBAL_MAX_GAMES,
  agentReservedGames: BYO_AGENT_RESERVED_GAMES,
  maxGamesPerKey: BYO_MAX_GAMES_PER_KEY,
  rooms,
  isAgentRoom,
  keyIdsForRoom,
});

// F2 로비 throttle 게이트: 허용이면 true, 초과면 ack {ok:false,error:'rate limited'} 거부 후 false.
// 인자 중 함수(ack)를 찾아 응답한다(createRoom/joinRoom 은 (payload, ack), leaveRoom 은 (ack)).
function lobbyThrottleOk(socket, ...args) {
  if (msgThrottle.allow(socket)) return true;
  const ack = args.find((a) => typeof a === 'function');
  if (typeof ack === 'function') ack({ ok: false, error: 'rate limited' });
  return false;
}

// BYO apiKey 저장소 — 부팅 시 1회 로드. ENOENT 는 빈 store(G001 보장).
// 로드 실패(손상 등) 시 store=null 로 두어 apiKey 인증만 비활성화하고, 토큰 경로엔 영향 주지 않는다.
let agentKeyStore = null;
try {
  agentKeyStore = createStore(process.env.BYO_KEY_STORE_PATH || './data/byo-store.json');
} catch (err) {
  agentKeyStore = null;
  console.error('[agent] BYO key store 로드 실패 — apiKey 인증 비활성화:', err && err.message);
}

// G008(S8) 통합 와이어링: 세션 시크릿 해석 + OAuth/keys 라우터 마운트.
// resolveSessionSecret 는 프로덕션 미설정 시 hard-fail(throw)하고, 비프로덕션 미설정 시
// 임의 시크릿+1회 경고로 부팅을 막지 않는다(session.js 계약). OAuth env 미설정이면
// buildDefaultProviders 가 {} 를 돌려 /auth/* 는 404 가 되지만 서버 부팅엔 영향 없다.
// store 로드 실패(agentKeyStore=null)면 두 라우터 모두 건너뛴다(apiKey 인증과 동일한 degradation).
// 정적 파일 서빙은 위에서 먼저 등록되어 있고, /auth/* 와 /account/* 는 정적 경로와 겹치지 않는다.
const sessionSecret = resolveSessionSecret(process.env);
if (agentKeyStore) {
  const authProviders = buildDefaultProviders(process.env);
  // 인게임 "내 AI" UI 가 가용 로그인 수단을 알 수 있게 하는 공개(무인증) 설정 엔드포인트.
  // 비밀은 노출하지 않고 어떤 provider 가 설정됐는지·apiKey 인증이 켜졌는지만 알린다.
  // keys 라우터의 requireSession 이 모든 후속 요청을 가로채므로 반드시 그 앞에 둔다.
  app.get('/account/config', (req, res) => {
    res.json({
      keyAuth: true,
      providers: {
        github: !!authProviders.github,
        google: !!authProviders.google,
      },
    });
  });
  app.use(
    createOAuthRouter({
      store: agentKeyStore,
      secret: sessionSecret,
      providers: authProviders,
      callbackBaseUrl: process.env.OAUTH_CALLBACK_BASE_URL || `http://localhost:${PORT}`,
      ttlSec: Number(process.env.BYO_SESSION_TTL_SEC) || undefined,
    })
  );
  app.use(
    createKeysRouter({
      store: agentKeyStore,
      requireSession: requireSession(sessionSecret),
      liveSocketRegistry: connGuard,
    })
  );
}

const AGENT_TOKEN_BYTES = 32;
const AGENT_DEFAULT_NICK = 'AI Bot';
const ACTIVE_ITEMS = new Set(Catalog.ACTIVE_ITEMS || []);

// G001 공정성: 에이전트 액션 안전장치 상수.
// 레이트캡은 인간 입력 상한(30Hz) 이상으로 둔다 — /agent(에이전트) 경로에만 적용된다.
const AGENT_ACTIONS_PER_SEC_CAP = 30; // 소켓별 초당 슬라이딩 윈도우 수락 상한
const AGENT_POLICY_UPDATES_PER_SEC_CAP = 8;
const AGENT_POLICY_UPDATE_MAX_BYTES = 4096;
const AGENT_TIMING_WINDOW = 10;       // 보관할 최근 inter-arrival 간격 개수
const AGENT_TIMING_SAMPLE_SIZE = 8;   // 분산 판정에 필요한 최소 간격 표본 수
const AGENT_TIMING_STDDEV_MS = 8;     // 표준편차가 이 미만이면 비인간(0분산) 패턴으로 플래그

// G002 생존성: 멈춤→봇 인계, 게임중 이탈→유예 후 정리 상수(틱 단위, 30Hz).
const AGENT_STALL_TICKS = 30;  // ≈1s: 클라 액션 없이 이만큼 지나면 baseline 봇이 인계
const AGENT_GRACE_TICKS = 90;  // ≈3s(<8s): 게임중 이탈 슬롯을 봇이 끌다가 만료 시 회수
const AGENT_OBSERVATION_SCHEMA_V2 = 'crazay-arkade-agent-observation.v2';
const AGENT_POLICY_SCHEMA_V1 = 'crazay-arkade-agent-runtime-policy.v1';
const AGENT_POLICY_SCHEMA_V2 = 'crazay-arkade-agent-runtime-policy.v2';
const AGENT_TRACE_LIMIT = 160;

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function makeAgentToken() {
  return crypto.randomBytes(AGENT_TOKEN_BYTES).toString('base64url');
}

function roomList() {
  return lobby.listRooms(lobbyCtx);
}

function broadcastRooms() {
  io.to('lobby').emit('rooms', roomList());
}

function roomDetail(room) {
  const spectators = room.spectators || new Map();
  return {
    id: room.id,
    name: room.name,
    host: room.host,
    state: room.state,
    mode: room.mode,
    mapId: room.mode === 'boss' ? 'boss-cove' : room.mapId,
    players: [...room.players.entries()].map(([id, p]) => ({
      id,
      nick: p.nick,
      team: p.team,
      char: p.char,
      controller: p.controller || 'human',
      ownerId: (p.controller || 'human') === 'agent' ? p.ownerId || null : null,
    })),
    spectators: [...spectators.entries()].map(([id, s]) => ({
      id,
      nick: s.nick,
      char: s.char,
      controller: 'human',
    })),
  };
}

function roomTick(room) {
  return room && room.game ? room.game.tick : null;
}

function ensureAgentTraceLog(room) {
  if (!room.agentTraceLog) room.agentTraceLog = [];
  if (!Number.isSafeInteger(room.agentTraceSeq)) room.agentTraceSeq = 0;
}

function appendAgentTrace(room, type, record, data = {}) {
  if (!room) return null;
  ensureAgentTraceLog(room);
  room.agentTraceSeq += 1;
  const event = {
    eventId: room.agentTraceSeq,
    type,
    tick: Number.isFinite(data.tick) ? data.tick : roomTick(room),
    at: Date.now(),
    playerId: record && record.playerId ? record.playerId : null,
    seq: Number.isFinite(data.seq) ? data.seq : null,
    reason: data.reason || null,
  };
  room.agentTraceLog.push(event);
  if (room.agentTraceLog.length > AGENT_TRACE_LIMIT) room.agentTraceLog.shift();
  return event;
}

function traceCursor(room) {
  ensureAgentTraceLog(room);
  return room.agentTraceSeq;
}

function missedAgentEvents(room, record, sinceEventId = 0) {
  if (!room || !room.agentTraceLog) return [];
  return room.agentTraceLog
    .filter((event) => event.eventId > sinceEventId && (!record || !event.playerId || event.playerId === record.playerId))
    .slice(-24);
}

function markAgentTraceSeen(record, trace) {
  if (!record || !trace || !Number.isSafeInteger(trace.eventId)) return;
  record.lastSeenEventId = Math.max(record.lastSeenEventId || 0, trace.eventId);
}

function compactResume(room, record, reconnected) {
  if (!room || !record) return null;
  const lastSeen = Number.isSafeInteger(record.lastSeenEventId) ? record.lastSeenEventId : 0;
  const events = missedAgentEvents(room, record, lastSeen);
  const lastEventId = traceCursor(room);
  record.lastSeenEventId = lastEventId;
  return {
    reconnected: !!reconnected,
    lastEventId,
    missedEvents: events,
    recovery: {
      mode: record.botActive ? 'fallback-bot-active' : (record.disconnectedAtTick === null ? 'agent-control' : 'resume-pending'),
      disconnectedAtTick: Number.isFinite(record.disconnectedAtTick) ? record.disconnectedAtTick : null,
    },
  };
}

const AGENT_ALLOWED_ACTIONS = Object.freeze([
  'move',
  'placeBomb',
  'useNeedle',
  'selectItem',
  'useItem',
  'wait',
]);

function compactAgentSelf(self) {
  if (!self) return null;
  return {
    alive: self.alive !== false,
    trapped: !!self.trapped,
    needles: Number.isFinite(self.needles) ? self.needles : 0,
    activeBombs: Number.isFinite(self.activeBombs) ? self.activeBombs : 0,
    maxBombs: Number.isFinite(self.maxBombs) ? self.maxBombs : null,
    selectedItem: self.selectedItem || null,
    inventory: self.inventory || {},
    cell: Number.isFinite(self.x) && Number.isFinite(self.y)
      ? { x: Math.floor(self.x / TILE), y: Math.floor(self.y / TILE) }
      : null,
    lastSeq: Number.isFinite(self.lastSeq) ? self.lastSeq : null,
    lastQueuedSeq: Number.isFinite(self.lastQueuedSeq) ? self.lastQueuedSeq : null,
  };
}

function agentStatusPayload(record, room, state, reasonOverride) {
  const tick = state && Number.isFinite(state.tick) ? state.tick : (room && room.game ? room.game.tick : null);
  const countdown = state && Number.isFinite(state.countdown) ? state.countdown : null;
  const stateSelf = state && Array.isArray(state.players)
    ? state.players.find((p) => p.id === record.playerId)
    : null;
  const gameSelf = room && room.game && room.game.players ? room.game.players.get(record.playerId) : null;
  const self = stateSelf || gameSelf || null;
  let phase = 'waiting';
  let canAct = false;
  let reason = 'waiting_for_game_start';
  let nextExpectedAction = 'wait_for_game_start';

  if (!room) {
    phase = 'detached';
    reason = 'room_unavailable';
    nextExpectedAction = 'stop_or_reconnect_with_new_invite';
  } else if (!room.players.has(record.playerId)) {
    phase = 'detached';
    reason = 'agent_slot_unavailable';
    nextExpectedAction = 'stop_or_reconnect_with_new_invite';
  } else if (room.state !== 'playing' || !room.game) {
    phase = 'waiting';
    reason = 'waiting_for_game_start';
    nextExpectedAction = 'wait_for_game_start';
  } else if (!self) {
    phase = 'syncing';
    reason = 'waiting_for_observation';
    nextExpectedAction = 'wait_for_observation';
  } else if (self.alive === false) {
    phase = 'ended';
    reason = 'agent_eliminated';
    nextExpectedAction = 'wait_for_room_reset';
  } else if (countdown > 0) {
    phase = 'countdown';
    reason = 'countdown';
    nextExpectedAction = 'wait_for_countdown';
  } else {
    phase = 'playing';
    canAct = true;
    reason = self.trapped ? 'trapped_agent_can_use_escape_action' : 'ready_for_action';
    nextExpectedAction = self.trapped ? 'send_escape_action' : 'send_agent_action';
  }

  if (reasonOverride) reason = reasonOverride;

  const actionContract = buildAgentActionContract(record, room, state, { canAct, self });
  return {
    schema: 'crazay-arkade-agent-status.v1',
    roomId: room ? room.id : record.roomId,
    playerId: record.playerId,
    ownerId: record.ownerId ?? null,
    roomState: room ? room.state : 'missing',
    phase,
    canAct,
    reason,
    nextExpectedAction,
    tick,
    countdown,
    allowedActions: canAct ? AGENT_ALLOWED_ACTIONS : [],
    validActions: actionContract.validActions,
    invalidReasons: actionContract.invalidReasons,
    self: compactAgentSelf(self),
  };
}

function emitAgentStatus(socket, record, room, state, reasonOverride) {
  const payload = agentStatusPayload(record, room, state, reasonOverride);
  socket.emit('agentStatus', payload);
  return payload;
}

function moveBlockedReason(room, state, self, dir) {
  if (!room || !room.game || !state || !self) return 'not_ready';
  const nx = Math.floor(self.x / TILE) + dir.dx;
  const ny = Math.floor(self.y / TILE) + dir.dy;
  const solid = room.game.solidFor(self, nx, ny);
  if (!solid) return '';
  if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) return 'board_edge';
  const tile = state.grid && state.grid[ny] ? state.grid[ny][nx] : null;
  if (tile === 1) return 'soft_block';
  if (tile === 2) return 'hard_block';
  if (room.game.bombAt(nx, ny)) return 'blocked_by_bomb';
  if (solid === 2) return 'blocked_by_player';
  return '';
}

function buildAgentActionContract(record, room, state, context = {}) {
  const self = context.self || (state && Array.isArray(state.players) ? state.players.find((p) => p.id === record.playerId) : null);
  const canAct = context.canAct === true;
  const validActions = { move: [], placeBomb: false, useItem: [], useNeedle: false, wait: canAct };
  const invalidReasons = {};
  if (!canAct || !self || self.alive === false) {
    invalidReasons.all = !self || self.alive === false ? 'agent_not_alive' : 'cannot_act_now';
    return { validActions, invalidReasons };
  }
  const moves = [
    ['up', { dx: 0, dy: -1 }],
    ['down', { dx: 0, dy: 1 }],
    ['left', { dx: -1, dy: 0 }],
    ['right', { dx: 1, dy: 0 }],
  ];
  for (const [name, dir] of moves) {
    const reason = moveBlockedReason(room, state, self, dir);
    if (reason) invalidReasons[`move:${name}`] = reason;
    else validActions.move.push(name);
  }
  if (self.trapped) {
    validActions.useNeedle = (self.needles || 0) > 0;
    if (!validActions.useNeedle) invalidReasons.useNeedle = 'none_available';
    if (self.inventory && self.inventory.oxygen > 0) validActions.useItem.push('oxygen');
    if (!validActions.useItem.length) invalidReasons.useItem = 'no_escape_item';
    invalidReasons.placeBomb = 'trapped';
    return { validActions, invalidReasons };
  }
  const activeBombs = Number.isFinite(self.activeBombs) ? self.activeBombs : 0;
  const maxBombs = Number.isFinite(self.maxBombs) ? self.maxBombs : 1;
  validActions.placeBomb = activeBombs < maxBombs;
  if (!validActions.placeBomb) invalidReasons.placeBomb = 'capacity';
  const inventory = self.inventory || {};
  for (const item of ACTIVE_ITEMS) {
    if (inventory[item] > 0) validActions.useItem.push(item);
  }
  if (!validActions.useItem.length) invalidReasons.useItem = 'empty_inventory';
  return { validActions, invalidReasons };
}

function observationPolicyContext(record, room) {
  const runtime = record.runtimePolicy || null;
  return {
    contractVersion: 2,
    activePolicyId: runtime && runtime.selectedHeuristicId ? runtime.selectedHeuristicId : null,
    activePhase: runtime && runtime.phase ? runtime.phase : null,
    humanPacing: 'human_like',
    traceEventId: traceCursor(room),
  };
}

function emitUnassignedAgentStatus(socket, reason = 'authenticated_not_in_room') {
  socket.emit('agentStatus', {
    schema: 'crazay-arkade-agent-status.v1',
    roomId: null,
    playerId: null,
    ownerId: null,
    roomState: 'unassigned',
    phase: 'unassigned',
    canAct: false,
    reason,
    nextExpectedAction: 'create_or_join_room',
    tick: null,
    countdown: null,
    allowedActions: [],
    self: null,
  });
}

const CHAR_COUNT = Catalog.CHARACTERS.length;

function smallerTeam(room) {
  let red = 0;
  let blue = 0;
  for (const p of room.players.values()) {
    if (p.team === 'red') red++;
    else if (p.team === 'blue') blue++;
  }
  return red <= blue ? 'red' : 'blue';
}

function isHumanPlayer(p) {
  return (p.controller || 'human') === 'human';
}

// G007(S7): 방 성격/키 소속 해석 — resourceCaps 주입용.
// 에이전트 player(controller==='agent')가 한 명이라도 있으면 '에이전트 포함 게임'.
function isAgentRoom(room) {
  if (!room || !room.players) return false;
  for (const p of room.players.values()) {
    if (!isHumanPlayer(p)) return true;
  }
  return false;
}

// 방에 참여한 apiKey 에이전트들의 keyId 집합(토큰 에이전트는 keyId 없음 → 제외).
function keyIdsForRoom(room) {
  const keyIds = new Set();
  if (!room || !room.players) return keyIds;
  for (const id of room.players.keys()) {
    const rec = agentRecords.get(id);
    if (rec && rec.keyId) keyIds.add(rec.keyId);
  }
  return keyIds;
}

function isActivePlayerId(room, id) {
  const p = room.players.get(id);
  if (!p) return false;
  if (isHumanPlayer(p)) return true;
  const rec = agentRecords.get(id);
  return !!(rec && rec.socket && rec.socket.connected);
}

function isActiveRoomMemberId(room, id) {
  if (room.players.has(id)) return isActivePlayerId(room, id);
  return !!(room.spectators && room.spectators.has(id) && io.sockets.sockets.get(id)?.connected);
}

function hasActiveRoomMember(room) {
  for (const id of room.players.keys()) {
    if (isActiveRoomMemberId(room, id)) return true;
  }
  const spectators = room.spectators || new Map();
  for (const id of spectators.keys()) {
    if (isActiveRoomMemberId(room, id)) return true;
  }
  return false;
}

function nextHost(room) {
  for (const id of room.players.keys()) {
    if (isActivePlayerId(room, id)) return id;
  }
  const spectators = room.spectators || new Map();
  for (const id of spectators.keys()) {
    if (isActiveRoomMemberId(room, id)) return id;
  }
  return null;
}

function roomHasHuman(room) {
  for (const p of room.players.values()) {
    if (isHumanPlayer(p)) return true;
  }
  const spectators = room.spectators || new Map();
  for (const p of spectators.values()) {
    if (isHumanPlayer(p)) return true;
  }
  return false;
}

function cleanNick(nick, fallback) {
  if (typeof nick !== 'string') return fallback;
  const trimmed = nick.trim();
  return trimmed ? trimmed.slice(0, 12) : fallback;
}

function cleanChar(char, fallback = 0) {
  return Number.isInteger(char) && char >= 0 && char < CHAR_COUNT ? char : fallback;
}

function cleanTeam(room, team) {
  if (team === 'red' || team === 'blue') return team;
  return smallerTeam(room);
}

function serializeInvite(record) {
  return {
    token: record.token,
    roomId: record.roomId,
    playerId: record.playerId,
    ownerId: record.ownerId,
    nick: record.nick,
    char: record.char,
    team: record.team,
  };
}

function respond(socket, ack, event, payload) {
  if (typeof ack === 'function') ack(payload);
  socket.emit(event, payload);
}

function ownerSocket(record) {
  return io.sockets.sockets.get(record.ownerId);
}

function sendAgentInvite(socket, ack, record) {
  const invite = serializeInvite(record);
  if (typeof ack === 'function') ack({ ok: true, invite });
  socket.emit('agentInvite', invite);
}

function forgetAgentToken(record) {
  if (!record.token) return;
  agentTokens.delete(record.token);
  record.token = null;
}

function forgetAgentRecord(record) {
  forgetAgentToken(record);
  agentRecords.delete(record.playerId);
  if (record.ownerId && agentRecordsByOwner.get(record.ownerId) === record) {
    agentRecordsByOwner.delete(record.ownerId);
  }
  if (record.keyId) {
    const set = agentRecordsByKey.get(record.keyId);
    if (set) {
      set.delete(record);
      if (set.size === 0) agentRecordsByKey.delete(record.keyId);
    }
  }
}

function maybeDeleteRoom(room) {
  if (hasActiveRoomMember(room)) return false;
  if (room.game) room.game.stop();
  for (const record of [...agentRecords.values()]) {
    if (record.roomId === room.id) removeAgent(record, { revokeInvite: true, disconnectSocket: true, emitUpdates: false });
  }
  clearRoomLifecycleTimer(room);
  rooms.delete(room.id);
  return true;
}

// 전원-에이전트 방 수명: 사람/게임 없는 유휴 대기방을 정리한다.
// - 연결 활성 방 구성원 0 → maybeDeleteRoom 으로 즉시 정리.
// - 연결 에이전트만 남은 대기방 → BYO_EMPTY_ROOM_TTL_MS 경과 후 정리.
function clearRoomLifecycleTimer(room) {
  if (room && room.lifecycleTimer) {
    clearTimeout(room.lifecycleTimer);
    room.lifecycleTimer = null;
  }
}

function forceDeleteAgentRoom(room) {
  if (room.game) room.game.stop();
  for (const record of [...agentRecords.values()]) {
    if (record.roomId === room.id) removeAgent(record, { revokeInvite: true, disconnectSocket: true, emitUpdates: false });
  }
  clearRoomLifecycleTimer(room);
  rooms.delete(room.id);
}

function reviewRoomLifecycle(room) {
  if (!room || !rooms.has(room.id)) return;
  if (room.state === 'playing' || roomHasHuman(room)) {
    clearRoomLifecycleTimer(room);
    return;
  }
  if (!hasActiveRoomMember(room)) {
    clearRoomLifecycleTimer(room);
    if (maybeDeleteRoom(room)) broadcastRooms();
    return;
  }
  if (!room.lifecycleTimer) {
    room.lifecycleTimer = setTimeout(() => {
      room.lifecycleTimer = null;
      const current = rooms.get(room.id);
      if (!current || current.state === 'playing' || roomHasHuman(current)) return;
      forceDeleteAgentRoom(current);
      broadcastRooms();
    }, BYO_EMPTY_ROOM_TTL_MS);
    if (typeof room.lifecycleTimer.unref === 'function') room.lifecycleTimer.unref();
  }
}

// 로비 공유함수 주입 컨텍스트(휴먼/에이전트 공용).
const lobbyCtx = {
  rooms,
  MAX_PLAYERS,
  io,
  makeRoomId,
  smallerTeam,
  roomDetail,
  broadcastRooms,
  maybeDeleteRoom,
  nextHost,
};

function removeAgent(record, options = {}) {
  const {
    revokeInvite = true,
    disconnectSocket = true,
    emitUpdates = true,
  } = options;
  const room = rooms.get(record.roomId);
  const socket = record.socket;

  if (revokeInvite) forgetAgentRecord(record);
  if (socket) {
    record.socket = null;
    socket.data.agentRecord = null;
    socket.data.playerId = null;
    if (disconnectSocket && socket.connected) socket.disconnect(true);
  }
  if (room && record.playerId && room.players.delete(record.playerId) && room.game) {
    room.game.removePlayer(record.playerId);
  }
  if (!room || !emitUpdates) return;
  if (maybeDeleteRoom(room)) {
    broadcastRooms();
    return;
  }
  io.to(room.id).emit('roomUpdate', roomDetail(room));
  broadcastRooms();
}

function expireWaitingInvitesForRoom(room) {
  for (const record of [...agentRecords.values()]) {
    if (record.roomId !== room.id || !record.token) continue;
    // G002 A3: 연결된 에이전트의 토큰은 게임중 재접속용으로 보존(미연결 invite 만 회수).
    if (record.socket) continue;
    forgetAgentToken(record);
    const owner = ownerSocket(record);
    if (owner) owner.emit('agentInviteRevoked', { ok: true, reason: 'game started' });
    if (!record.socket && !room.players.has(record.playerId)) {
      forgetAgentRecord(record);
    }
  }
}

function validateAgentRecord(record) {
  if (!record || !record.token) return { ok: false, error: 'invalid agent token' };
  const room = rooms.get(record.roomId);
  if (!room) {
    forgetAgentRecord(record);
    return { ok: false, error: 'room is unavailable' };
  }
  if (room.state === 'playing') {
    // G002 A3: 게임중 재접속 회수 — 기존 슬롯이 살아있고 연결된 소켓이 없으면 허용.
    const slot = room.game && room.game.players.get(record.playerId);
    const reclaimable = !!slot && slot.alive && room.players.has(record.playerId)
      && (!record.socket || !record.socket.connected);
    if (reclaimable) return { ok: true, room, reclaim: true };
    forgetAgentToken(record);
    return { ok: false, error: 'room is already playing' };
  }
  const ownerPresent = record.ownerId && (room.players.has(record.ownerId)
    || (room.spectators && room.spectators.has(record.ownerId)));
  if (record.ownerId && !ownerPresent) {
    forgetAgentRecord(record);
    return { ok: false, error: 'owner is unavailable' };
  }
  if (record.socket && record.socket.connected) {
    return { ok: false, error: 'agent is already connected' };
  }
  if (!room.players.has(record.playerId) && room.players.size >= MAX_PLAYERS) {
    return { ok: false, error: 'room is full' };
  }
  return { ok: true, room };
}

function emitAgentObservations(room, state) {
  for (const record of agentRecords.values()) {
    if (record.roomId !== room.id || !record.socket || !record.socket.connected) continue;
    if (!room.players.has(record.playerId)) continue;
    const self = state.players.find((p) => p.id === record.playerId) || null;
    const status = emitAgentStatus(record.socket, record, room, state);
    const actionContract = buildAgentActionContract(record, room, state, { canAct: status.canAct, self });
    status.validActions = actionContract.validActions;
    status.invalidReasons = actionContract.invalidReasons;
    const trace = appendAgentTrace(room, 'agent.observed', record, { tick: state.t });
    const resume = record.resumeContext || null;
    record.resumeContext = null;
    record.socket.emit('state', state);
    record.socket.emit('agentObservation', {
      schema: AGENT_OBSERVATION_SCHEMA_V2,
      roomId: room.id,
      playerId: record.playerId,
      ownerId: record.ownerId ?? null,
      trace,
      resume,
      status,
      valid_actions: actionContract.validActions,
      invalid_reasons: actionContract.invalidReasons,
      policyContext: observationPolicyContext(record, room),
      self,
      state,
    });
    markAgentTraceSeen(record, trace);
  }
}

function cleanPolicyText(value, fallback, max = 120) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return (trimmed || fallback).slice(0, max);
}

function cleanPolicyList(value, maxItems = 6, maxText = 48) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => cleanPolicyText(item, '', maxText)).filter(Boolean);
}

function cleanPolicyObject(value, maxKeys = 8) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cleaned = Object.create(null);
  for (const [key, entry] of Object.entries(value).slice(0, maxKeys)) {
    const safeKey = cleanPolicyText(key, '', 40);
    if (safeKey === '__proto__' || safeKey === 'constructor' || safeKey === 'prototype') continue;
    if (!safeKey) continue;
    if (Array.isArray(entry)) cleaned[safeKey] = cleanPolicyList(entry, 8, 40);
    else if (typeof entry === 'boolean') cleaned[safeKey] = entry;
    else if (Number.isFinite(Number(entry))) cleaned[safeKey] = Number(entry);
    else if (typeof entry === 'string') cleaned[safeKey] = cleanPolicyText(entry, '', 80);
  }
  return Object.keys(cleaned).length ? cleaned : null;
}

function cleanSequencePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value.target && typeof value.target === 'object' && !Array.isArray(value.target)
    ? cleanPolicyObject(value.target, 6)
    : null;
  const cleaned = {
    heuristicId: cleanHeuristicId(value.heuristicId),
    kind: cleanPolicyText(value.kind, '', 40),
    objective: cleanPolicyText(value.objective, '', 64),
    target,
    interrupts: cleanPolicyList(value.interrupts, 6, 40),
    remainingMoves: Number.isFinite(Number(value.remainingMoves)) ? Math.max(0, Math.min(99, Math.floor(Number(value.remainingMoves)))) : null,
    horizonTicks: Number.isFinite(Number(value.horizonTicks)) ? Math.max(0, Math.min(99, Math.floor(Number(value.horizonTicks)))) : null,
    score: Number.isFinite(Number(value.score)) ? Math.round(Number(value.score) * 100) / 100 : null,
    scoreBreakdown: cleanPolicyObject(value.scoreBreakdown, 4),
  };
  return cleaned.kind || cleaned.objective || cleaned.target ? cleaned : null;
}

function policyPayloadIsTooLarge(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8') > AGENT_POLICY_UPDATE_MAX_BYTES;
  } catch {
    return true;
  }
}

function policyUpdateRateLimited(socket) {
  const now = Date.now();
  if (!Array.isArray(socket.data.agentPolicyStamps)) socket.data.agentPolicyStamps = [];
  const stamps = socket.data.agentPolicyStamps;
  while (stamps.length && now - stamps[0] >= 1000) stamps.shift();
  if (stamps.length >= AGENT_POLICY_UPDATES_PER_SEC_CAP) return true;
  stamps.push(now);
  return false;
}

function policyTick(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function cleanDecisionSource(value) {
  if (value === 'llm-reply') return 'llm-reply';
  if (value === 'heuristic') return 'heuristic';
  return null;
}

function cleanHeuristicId(value) {
  if (typeof value !== 'string') return null;
  return cleanPolicyText(value, '', 64) || null;
}

function cleanPolicyPhase(value) {
  return ['survive', 'farm', 'contest', 'recover', 'endgame'].includes(value) ? value : 'survive';
}

function cleanRisk(value) {
  return ['low', 'medium', 'high'].includes(value) ? value : 'medium';
}

function cleanConfidence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

function sanitizeAgentPolicyUpdate(payload, record, roomId, source) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.schema !== AGENT_POLICY_SCHEMA_V1 && payload.schema !== AGENT_POLICY_SCHEMA_V2) return null;
  const cards = Array.isArray(payload.cards) ? payload.cards.slice(0, 6) : [];
  const cleanedCards = cards.map((card, index) => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
    const kind = card.kind === 'enforce' ? 'enforce' : 'create';
    return {
      id: cleanPolicyText(card.id, `runtime-card-${index}`, 64),
      kind,
      priority: Number.isInteger(card.priority) ? Math.max(1, Math.min(99, card.priority)) : index + 1,
      title: cleanPolicyText(card.title, kind === 'enforce' ? '실시간 집행 카드' : '실시간 생성 카드', 48),
      summary: cleanPolicyText(card.summary, '에이전트가 현재 관측에서 생성한 휴리스틱입니다.', 160),
      signals: cleanPolicyList(card.signals),
      actions: cleanPolicyList(card.actions),
    };
  }).filter(Boolean);
  if (!cleanedCards.length) return null;
  const decisionSource = cleanDecisionSource(payload.decisionSource);
  const generatedAtTick = policyTick(payload.generatedAtTick);
  return {
    schema: payload.schema === AGENT_POLICY_SCHEMA_V2 ? AGENT_POLICY_SCHEMA_V2 : AGENT_POLICY_SCHEMA_V1,
    roomId,
    source,
    playerId: record.playerId,
    ownerId: record.ownerId ?? null,
    nick: cleanPolicyText(record.nick, AGENT_DEFAULT_NICK, 24),
    revision: Number.isInteger(payload.revision) ? Math.max(0, payload.revision) : 0,
    decisionSource,
    llmReplyId: decisionSource === 'llm-reply' ? cleanPolicyText(payload.llmReplyId, 'llm-reply', 64) : null,
    decisionTick: policyTick(payload.decisionTick),
    generatedAtTick,
    selectedHeuristicId: cleanHeuristicId(payload.selectedHeuristicId || payload.heuristicId),
    phase: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanPolicyPhase(payload.phase) : null,
    intent: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanPolicyText(payload.intent, 'execute_policy', 80) : null,
    fallbackHeuristicId: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanHeuristicId(payload.fallbackHeuristicId) : null,
    risk: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanRisk(payload.risk) : null,
    confidence: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanConfidence(payload.confidence) : null,
    expectedHorizonTicks: payload.schema === AGENT_POLICY_SCHEMA_V2 && Number.isFinite(Number(payload.expectedHorizonTicks))
      ? Math.max(1, Math.min(300, Math.floor(Number(payload.expectedHorizonTicks))))
      : null,
    constraints: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanPolicyList(payload.constraints, 6, 40) : [],
    reason: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanPolicyText(payload.reason, '', 160) : '',
    sequencePlan: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanSequencePlan(payload.sequencePlan) : null,
    actionMask: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanPolicyObject(payload.actionMask, 10) : null,
    benchmark: payload.schema === AGENT_POLICY_SCHEMA_V2 ? cleanPolicyObject(payload.benchmark, 10) : null,
    overview: cleanPolicyText(payload.overview, '에이전트가 게임 중 휴리스틱을 생성했습니다.', 180),
    cards: cleanedCards,
  };
}

function publishAgentPolicyUpdate(record, room, payload, source) {
  const update = sanitizeAgentPolicyUpdate(payload, record, room.id, source);
  if (!update) return null;
  update.trace = appendAgentTrace(room, 'agent.policy.selected', record, { tick: update.decisionTick, reason: update.selectedHeuristicId });
  record.runtimePolicy = update;
  io.to(room.id).emit('agentPolicyUpdate', update);
  return update;
}

function handleAgentPolicyUpdate(socket, payload, ack) {
  const reply = (response) => { if (typeof ack === 'function') ack(response); };
  const record = socket.data.agentRecord;
  if (!record || record.socket !== socket) {
    reply({ ok: false, error: 'agent is not attached' });
    return;
  }
  const room = rooms.get(record.roomId);
  if (!room || !room.players.has(record.playerId)) {
    reply({ ok: false, error: 'room is unavailable' });
    return;
  }
  if (room.state !== 'playing') {
    reply({ ok: false, error: 'game is not active' });
    return;
  }
  if (policyPayloadIsTooLarge(payload)) {
    reply({ ok: false, error: 'policy update too large' });
    return;
  }
  if (policyUpdateRateLimited(socket)) {
    reply({ ok: false, error: 'policy update rate limited' });
    return;
  }
  const update = publishAgentPolicyUpdate(record, room, payload, 'agent');
  if (!update) {
    reply({ ok: false, error: 'invalid policy update' });
    return;
  }
  markAgentTraceSeen(record, update.trace);
  reply({ ok: true, trace: update.trace });
}

// G002 생존성: baseline 봇 액션을 driveBotInput 용 방향키로 변환.
// move 만 키로 매핑하고, 그 외(placeBomb/useNeedle/useItem/wait)는 호출부에서 별도 처리한다.
function botActionToKeys(action) {
  if (action && action.type === 'move' && action.keys && typeof action.keys === 'object') {
    return {
      up: action.keys.up === true,
      down: action.keys.down === true,
      left: action.keys.left === true,
      right: action.keys.right === true,
    };
  }
  return { up: false, down: false, left: false, right: false };
}

// G002 A2/A3 워치독: 멈춤(스톨)/이탈한 에이전트 슬롯을 baseline 봇이 인계하고,
// 게임중 이탈 슬롯은 유예가 만료되면 회수한다. startGame 의 emit('state') 콜백에서
// 매 state(30Hz, 카운트다운 정렬)마다 호출된다 — game.js 는 lib/agent 를 모른다.
function driveStalledAgents(room, state) {
  if (!room.game) return;
  for (const record of [...agentRecords.values()]) {
    if (record.roomId !== room.id || !room.players.has(record.playerId)) continue;
    const slot = room.game.players.get(record.playerId);
    if (!slot || (slot.controller || 'human') !== 'agent') continue;
    const disconnected = !record.socket || !record.socket.connected;

    // A3 유예 만료: 이탈 슬롯을 GRACE 만큼 봇이 끌다가 만료 시 제거→checkEnd→gameOver(B10 보존).
    if (disconnected && typeof record.disconnectedAtTick === 'number'
      && state.t - record.disconnectedAtTick > AGENT_GRACE_TICKS) {
      removeAgent(record, { revokeInvite: true, disconnectSocket: false, emitUpdates: true });
      continue;
    }

    // 카운트다운 중에는 step() 이 processCmds 를 스킵하므로 봇도 구동하지 않는다.
    // 스톨 기준선을 매 카운트다운 틱에 현재 틱으로 당겨, 매치 시작 후 STALL 만큼의 유예를 준다.
    if (state.countdown !== 0) {
      if (!disconnected) record.lastClientTick = state.t;
      continue;
    }

    if (typeof record.lastClientTick !== 'number') record.lastClientTick = state.t;
    const stalled = disconnected || (state.t - record.lastClientTick > AGENT_STALL_TICKS);
    if (!stalled) continue;

    if (!record.bot) record.bot = createHeuristicAgent();
    if (!record.botPacer) record.botPacer = createActionPacer();
    const observation = {
      status: {
        canAct: true,
        tick: state.t,
        reason: slot.trapped ? 'trapped_agent_can_use_escape_action' : 'ready_for_action',
      },
      state,
      playerId: record.playerId,
    };
    const desiredAction = record.bot.chooseAction(observation);
    const action = record.botPacer.nextAction(observation, desiredAction);
    const policy = typeof record.bot.policySnapshot === 'function' ? record.bot.policySnapshot() : null;
    if (policy && policy.revision !== record.botPolicyRevision && Array.isArray(policy.cards) && policy.cards.length) {
      record.botPolicyRevision = policy.revision;
      publishAgentPolicyUpdate(record, room, policy, 'fallbackBot');
    }
    if (!action) continue;
    room.game.driveBotInput(record.playerId, botActionToKeys(action));
    if (action) {
      if (action.type === 'placeBomb') room.game.placeBomb(record.playerId);
      else if (action.type === 'useNeedle') room.game.useNeedle(record.playerId);
      else if (action.type === 'useItem') room.game.useActiveItem(record.playerId, action.item);
    }
    record.botActive = true;
  }
}

function agentPayloadIsTooLarge(action) {
  try {
    return Buffer.byteLength(JSON.stringify(action), 'utf8') > 2048;
  } catch {
    return true;
  }
}

function nextAgentSeq(socket, seq) {
  if (seq === undefined || seq === null) {
    socket.data.agentSeq += 1;
    if (socket.data.agentRecord) socket.data.agentRecord.lastAgentSeq = socket.data.agentSeq;
    return socket.data.agentSeq;
  }
  if (!Number.isSafeInteger(seq) || seq <= 0 || seq <= socket.data.agentSeq) return null;
  socket.data.agentSeq = seq;
  if (socket.data.agentRecord) socket.data.agentRecord.lastAgentSeq = socket.data.agentSeq;
  return seq;
}

function normalizeAgentAction(socket, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  if (agentPayloadIsTooLarge(action)) return null;
  if (action.type === 'cmd' || action.type === 'move') {
    const keys = action.keys && typeof action.keys === 'object' && !Array.isArray(action.keys) ? action.keys : {};
    const seq = nextAgentSeq(socket, action.seq);
    if (!seq) return null;
    return {
      type: 'cmd',
      cmd: {
        seq,
        keys: {
          up: keys.up === true,
          down: keys.down === true,
          left: keys.left === true,
          right: keys.right === true,
        },
      },
    };
  }
  if (action.type === 'wait') {
    const seq = nextAgentSeq(socket, action.seq);
    return seq ? { type: 'wait', seq } : null;
  }
  if (action.type === 'placeBomb') {
    const seq = nextAgentSeq(socket, action.seq);
    return seq ? { type: 'placeBomb', seq } : null;
  }
  if (action.type === 'useNeedle') {
    const seq = nextAgentSeq(socket, action.seq);
    return seq ? { type: 'useNeedle', seq } : null;
  }
  if (action.type === 'selectItem') {
    const seq = nextAgentSeq(socket, action.seq);
    const item = action.item || action.itemType;
    return seq && ACTIVE_ITEMS.has(item) ? { type: 'selectItem', item, seq } : null;
  }
  if (action.type === 'useItem' || action.type === 'useActiveItem') {
    const seq = nextAgentSeq(socket, action.seq);
    const item = action.item || action.itemType;
    return seq && (!item || ACTIVE_ITEMS.has(item)) ? { type: 'useItem', item, seq } : null;
  }
  return null;
}

function handleAgentAction(socket, action, ack) {
  const reply = (payload) => {
    if (typeof ack === 'function') ack(payload);
  };
  const record = socket.data.agentRecord;
  if (!record || record.socket !== socket) {
    reply({ ok: false, error: 'agent is not attached' });
    return;
  }
  const room = rooms.get(record.roomId);
  if (!room || !room.game || !room.players.has(record.playerId)) {
    reply({
      ok: false,
      error: 'game is not active',
      status: agentStatusPayload(record, room, null, 'game_is_not_active'),
    });
    return;
  }
  // G001 공정성: 레이트캡/타이밍 탐지 — normalize(seq 소비) 이전에 평가한다.
  const now = Date.now();

  // 0분산 타이밍 탐지: 액션 도착 간격을 슬라이딩 보관하고 표준편차로 비인간 패턴을 판정한다.
  // (액션을 거부하지 않는 별도 신호. 소켓당 1회만 'agentFlagged' 송신.)
  if (!Array.isArray(socket.data.agentActionGaps)) socket.data.agentActionGaps = [];
  if (typeof socket.data.agentLastActionAt === 'number') {
    const gaps = socket.data.agentActionGaps;
    gaps.push(now - socket.data.agentLastActionAt);
    if (gaps.length > AGENT_TIMING_WINDOW) gaps.shift();
    if (!socket.data.agentTimingFlagged && gaps.length >= AGENT_TIMING_SAMPLE_SIZE) {
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
      if (Math.sqrt(variance) < AGENT_TIMING_STDDEV_MS) {
        socket.data.agentTimingFlagged = true;
        socket.emit('agentFlagged', { playerId: record.playerId, reason: 'timing' });
      }
    }
  }
  socket.data.agentLastActionAt = now;

  // 초당 슬라이딩 윈도우 레이트캡: 최근 1초 내 수락 액션이 캡 이상이면 거부(seq 미소비).
  if (!Array.isArray(socket.data.agentRateStamps)) socket.data.agentRateStamps = [];
  const stamps = socket.data.agentRateStamps;
  while (stamps.length && now - stamps[0] >= 1000) stamps.shift();
  if (stamps.length >= AGENT_ACTIONS_PER_SEC_CAP) {
    const trace = appendAgentTrace(room, 'agent.action.rejected', record, { reason: 'rate_limited' });
    markAgentTraceSeen(record, trace);
    reply({
      ok: false,
      error: 'rate limited',
      status: agentStatusPayload(record, room, null, 'rate_limited'),
      trace,
    });
    return;
  }
  stamps.push(now);
  const normalized = normalizeAgentAction(socket, action);
  if (!normalized) {
    socket.emit('agentError', 'invalid action');
    const trace = appendAgentTrace(room, 'agent.action.rejected', record, { reason: 'invalid_action' });
    markAgentTraceSeen(record, trace);
    reply({
      ok: false,
      error: 'invalid action',
      status: agentStatusPayload(record, room, null, 'invalid_action'),
      trace,
    });
    return;
  }
  // G002 A2/A3: 클라 액션 수락 → 스톨 기준선 갱신 + 봇 제어 회수(release).
  // 봇은 lastSeq 만 진행하고 lastQueuedSeq 는 안 건드리므로 클라 seq 레인은 깨끗하다.
  // 재동기는 안전망(reclaim 은 connection 핸들러에서 agentSeq=lastQueuedSeq 로 처리).
  record.lastClientTick = room.game.tick;
  if (record.botActive) {
    if (record.bot) record.bot.reset();
    if (record.botPacer) record.botPacer.reset();
    record.botPolicyRevision = null;
    const slot = room.game.players.get(record.playerId);
      if (slot) socket.data.agentSeq = Math.max(socket.data.agentSeq, slot.lastQueuedSeq, record.lastAgentSeq || 0);
    record.botActive = false;
  }
  if (normalized.type === 'cmd') room.game.queueCmd(record.playerId, normalized.cmd);
  else if (normalized.type === 'wait') {
    const trace = appendAgentTrace(room, 'agent.action.accepted', record, { seq: normalized.seq });
    markAgentTraceSeen(record, trace);
    reply({ ok: true, seq: normalized.seq, trace });
    return;
  }
  else if (normalized.type === 'placeBomb') room.game.placeBomb(record.playerId);
  else if (normalized.type === 'useNeedle') room.game.useNeedle(record.playerId);
  else if (normalized.type === 'selectItem') room.game.selectItem(record.playerId, normalized.item);
  else if (normalized.type === 'useItem') room.game.useActiveItem(record.playerId, normalized.item);
  const ackSeq = normalized.cmd ? normalized.cmd.seq : normalized.seq;
  const trace = appendAgentTrace(room, 'agent.action.accepted', record, { seq: ackSeq });
  markAgentTraceSeen(record, trace);
  reply({ ok: true, seq: ackSeq, trace });
}

function leaveRoom(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;
  const agentRecord = agentRecordsByOwner.get(socket.id);
  if (agentRecord) {
    removeAgent(agentRecord, { revokeInvite: true, disconnectSocket: true, emitUpdates: false });
  }
  socket.leave(room.id);
  socket.data.roomId = null;
  const res = lobby.doLeaveRoom(lobbyCtx, { id: socket.id, controller: 'human' });
  if (res.room) reviewRoomLifecycle(res.room);
}

function normalizeChatText(payload) {
  const raw = payload && typeof payload === 'object' ? payload.text : payload;
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_CHARS);
}

function roomMember(room, socket) {
  return room.players.get(socket.id) || (room.spectators && room.spectators.get(socket.id)) || null;
}

function appendChatMessage(room, socket, text) {
  if (!Array.isArray(room.chat)) room.chat = [];
  if (!Number.isSafeInteger(room.chatSeq)) room.chatSeq = 0;
  room.chatSeq += 1;
  const member = roomMember(room, socket);
  const message = {
    id: `${Date.now().toString(36)}-${room.chatSeq}`,
    scope: room.state === 'playing' ? 'game' : 'room',
    senderId: socket.id,
    nick: (member && member.nick) || socket.data.nick || '플레이어',
    text,
    sentAt: Date.now(),
  };
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
  return message;
}

function sendChatHistory(socket, room) {
  socket.emit('chatHistory', Array.isArray(room.chat) ? room.chat.slice(-CHAT_HISTORY_LIMIT) : []);
}

function handleChatMessage(socket, payload, ack) {
  const reply = (response) => { if (typeof ack === 'function') ack(response); };
  const room = rooms.get(socket.data.roomId);
  if (!room || !roomMember(room, socket)) {
    reply({ ok: false, error: 'not in room' });
    return;
  }
  if (!mainChatThrottle.allow(socket)) {
    reply({ ok: false, error: 'rate limited' });
    return;
  }
  const text = normalizeChatText(payload);
  if (!text) {
    reply({ ok: false, error: 'empty message' });
    return;
  }
  const message = appendChatMessage(room, socket, text);
  io.to(room.id).emit('chatMessage', message);
  reply({ ok: true, message });
}

function startGame(room) {
  if (room.players.size === 0) return { ok: false, error: '게임을 시작하려면 플레이어가 필요합니다.' };
  // G007(S7) 공유 게이트: 방이 에이전트 포함이면 전역+키별 상한, 휴먼 전용이면 소프트 플로어를
  // 적용한다. 초과 시 상태 변형 없이 { ok:false, error } 를 돌려주고 호출부가 errorMsg/ack 로 거부.
  const decision = resourceCaps.evaluateStart(room);
  if (!decision.ok) return decision;
  room.state = 'playing';
  expireWaitingInvitesForRoom(room);
  const players = [...room.players.entries()].map(([id, p]) => ({
    id,
    nick: p.nick,
    team: room.mode === 'team' ? p.team : null,
    char: p.char || 0,
    controller: p.controller || 'human',
  }));
  const mapId = room.mode === 'boss' ? 'boss-cove' : room.mapId;
  room.game = new Game(
    players,
    (event, data) => {
      io.to(room.id).emit(event, data);
      if (event === 'state') {
        emitAgentObservations(room, data);
        driveStalledAgents(room, data);
      }
    },
    () => {
      room.game = null;
      room.state = 'waiting';
      io.to(room.id).emit('roomUpdate', roomDetail(room));
      broadcastRooms();
    },
    room.mode,
    mapId
  );
  io.to(room.id).emit('gameStart', { players: players.map((p, i) => ({ ...p, color: i })), map: Catalog.getMap(mapId) });
  io.to(room.id).emit('roomUpdate', roomDetail(room));
  broadcastRooms();
  return { ok: true };
}

// --- /agent apiKey 로비 핸들러(공유 로비함수 위에서 동작) ---------------------
function normalizeRoomOpts(payload) {
  if (typeof payload === 'string') return { name: payload };
  if (payload && typeof payload === 'object') {
    return { name: payload.name, nick: payload.nick, char: payload.char };
  }
  return {};
}

function apiKeyAgentIdentity(socket, opts = {}) {
  const keyId = socket.data.keyId;
  return {
    id: `agent:key:${keyId}:${crypto.randomBytes(8).toString('hex')}`,
    nick: cleanNick(opts.nick, AGENT_DEFAULT_NICK),
    char: cleanChar(opts.char, 0),
    controller: 'agent',
    ownerId: null,
    keyId,
  };
}

function registerApiKeyAgent(socket, identity, room) {
  const player = room.players.get(identity.id);
  const record = {
    token: null,
    roomId: room.id,
    ownerId: null,
    keyId: identity.keyId,
    playerId: identity.id,
    nick: identity.nick,
    char: identity.char,
    team: player ? player.team : 'red',
    socket,
  };
  agentRecords.set(record.playerId, record);
  let set = agentRecordsByKey.get(identity.keyId);
  if (!set) {
    set = new Set();
    agentRecordsByKey.set(identity.keyId, set);
  }
  set.add(record);
  socket.data.agentRecord = record;
  socket.data.playerId = record.playerId;
  socket.data.roomId = room.id;
  socket.data.ownerId = null;
  socket.data.agentSeq = 0;
  return record;
}

function handleAgentCreateRoom(socket, payload, ack) {
  if (typeof payload === 'function') { ack = payload; payload = undefined; }
  const reply = (p) => { if (typeof ack === 'function') ack(p); };
  if (socket.data.agentRecord) {
    reply({ ok: false, error: 'already in a room' });
    return;
  }
  // G007(S7) 키별 동시 게임 상한 선제 게이트: 이미 maxGamesPerKey 개 진행중인 키는 새 방 생성 거부.
  const keyGate = resourceCaps.evaluateKeyRoom(socket.data.keyId);
  if (!keyGate.ok) {
    socket.emit('errorMsg', keyGate.error);
    reply({ ok: false, error: keyGate.error });
    return;
  }
  const opts = normalizeRoomOpts(payload);
  const identity = apiKeyAgentIdentity(socket, opts);
  const { room } = lobby.doCreateRoom(lobbyCtx, identity, { name: opts.name });
  registerApiKeyAgent(socket, identity, room);
  socket.join(room.id);
  reply({ ok: true, room: roomDetail(room), playerId: identity.id });
  socket.emit('agentReady', { room: roomDetail(room), playerId: identity.id, ownerId: null });
  emitAgentStatus(socket, socket.data.agentRecord, room, null);
  broadcastRooms();
  reviewRoomLifecycle(room);
}

function handleAgentJoinRoom(socket, payload, ack) {
  if (typeof payload === 'function') { ack = payload; payload = undefined; }
  const reply = (p) => { if (typeof ack === 'function') ack(p); };
  if (socket.data.agentRecord) {
    reply({ ok: false, error: 'already in a room' });
    return;
  }
  // G007(S7) 키별 동시 게임 상한 선제 게이트: 이미 maxGamesPerKey 개 진행중인 키는 입장 거부.
  const keyGate = resourceCaps.evaluateKeyRoom(socket.data.keyId);
  if (!keyGate.ok) {
    socket.emit('errorMsg', keyGate.error);
    reply({ ok: false, error: keyGate.error });
    return;
  }
  const roomId = typeof payload === 'string' ? payload : (payload && payload.roomId);
  const opts = payload && typeof payload === 'object' ? normalizeRoomOpts(payload) : {};
  const identity = apiKeyAgentIdentity(socket, opts);
  const result = lobby.doJoinRoom(lobbyCtx, identity, roomId);
  if (result.error) {
    const msg = AGENT_JOIN_ERROR[result.error] || 'cannot join room';
    socket.emit('errorMsg', msg);
    reply({ ok: false, error: msg });
    return;
  }
  const room = result.room;
  registerApiKeyAgent(socket, identity, room);
  socket.join(room.id);
  reply({ ok: true, room: roomDetail(room), playerId: identity.id });
  socket.emit('agentReady', { room: roomDetail(room), playerId: identity.id, ownerId: null });
  emitAgentStatus(socket, socket.data.agentRecord, room, null);
  io.to(room.id).emit('roomUpdate', roomDetail(room));
  broadcastRooms();
  reviewRoomLifecycle(room);
}

function handleAgentLeaveRoom(socket, ack) {
  const reply = (p) => { if (typeof ack === 'function') ack(p); };
  const record = socket.data.agentRecord;
  if (!record) { reply({ ok: true }); return; }
  socket.leave(record.roomId);
  const identity = { id: record.playerId, controller: 'agent' };
  forgetAgentRecord(record);
  record.socket = null;
  socket.data.agentRecord = null;
  socket.data.playerId = null;
  socket.data.roomId = null;
  const res = lobby.doLeaveRoom(lobbyCtx, identity);
  if (res.room) reviewRoomLifecycle(res.room);
  reply({ ok: true });
}

function handleAgentStartGame(socket, ack) {
  const reply = (p) => { if (typeof ack === 'function') ack(p); };
  const record = socket.data.agentRecord;
  const room = record && rooms.get(record.roomId);
  if (!room || room.host !== record.playerId || room.state === 'playing') {
    reply({ ok: false, error: 'cannot start game' });
    return;
  }
  if (room.mode === 'team') {
    if (room.players.size < 2) { reply({ ok: false, error: 'team mode needs at least 2 players' }); return; }
    const teams = new Set([...room.players.values()].map((p) => p.team));
    if (teams.size < 2) { reply({ ok: false, error: 'team mode needs players on both teams' }); return; }
  }
  const started = startGame(room);
  if (!started.ok) { reply({ ok: false, error: started.error }); return; }
  reply({ ok: true });
}

function handleAgentResume(socket, payload, ack) {
  const reply = (p) => { if (typeof ack === 'function') ack(p); };
  if (socket.data.agentRecord) {
    reply({ ok: false, error: 'already in a room' });
    return;
  }
  const playerId = payload && typeof payload === 'object' ? payload.playerId : null;
  const record = typeof playerId === 'string' ? agentRecords.get(playerId) : null;
  const room = record && rooms.get(record.roomId);
  const slot = room && room.game && room.game.players.get(record.playerId);
  const canResume = record && record.keyId === socket.data.keyId
    && room && room.state === 'playing' && room.players.has(record.playerId)
    && slot && (slot.controller || 'human') === 'agent' && slot.alive
    && (!record.socket || !record.socket.connected);
  if (!canResume) {
    reply({ ok: false, error: 'cannot resume agent' });
    return;
  }
  record.socket = socket;
  record.disconnectedAtTick = null;
  record.lastClientTick = room.game.tick;
  record.botActive = false;
  if (record.bot) record.bot.reset();
  if (record.botPacer) record.botPacer.reset();
  record.botPolicyRevision = null;
  socket.data.agentRecord = record;
  socket.data.playerId = record.playerId;
  socket.data.roomId = record.roomId;
  socket.data.ownerId = null;
  socket.data.agentSeq = Math.max(slot.lastQueuedSeq, record.lastAgentSeq || 0);
  socket.join(room.id);
  const payloadReady = { room: roomDetail(room), playerId: record.playerId, ownerId: null };
  socket.emit('agentReady', payloadReady);
  emitAgentStatus(socket, record, room, null);
  reply({ ok: true, ...payloadReady });
}

function handleAgentDisconnect(socket) {
  const record = socket.data.agentRecord;
  if (!record || record.socket !== socket) return;
  const currentRoom = rooms.get(record.roomId);
  const slot = currentRoom && currentRoom.game && currentRoom.game.players.get(record.playerId);
  const playingAlive = currentRoom && currentRoom.state === 'playing'
    && currentRoom.players.has(record.playerId)
    && slot && (slot.controller || 'human') === 'agent' && slot.alive;
  if (playingAlive) {
    // G002 A3: 게임중 이탈 → 토큰/슬롯 보존. 봇이 인계하고 워치독이 유예 만료 시 회수한다.
    record.socket = null;
    socket.data.agentRecord = null;
    socket.data.playerId = null;
    record.disconnectedAtTick = currentRoom.game.tick;
    record.botActive = false;
    if (record.bot) record.bot.reset();
    return;
  }
  // 대기실(또는 이미 죽은/종료 슬롯): 기존대로 토큰/슬롯 회수.
  removeAgent(record, { revokeInvite: true, disconnectSocket: false, emitUpdates: true });
  const room = rooms.get(record.roomId);
  if (room) reviewRoomLifecycle(room);
}

agentIo.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const ip = socket.handshake.address;
  const apiKey = auth.apiKey;
  // apiKey 모드: 키 검증만 수행하고 방 배치는 S5 로비에서. record 는 아직 없다.
  if (typeof apiKey === 'string') {
    if (!agentKeyStore) return next(new Error('invalid or revoked api key'));
    let keyRecord = null;
    try {
      keyRecord = agentKeyStore.findByKeyHash(hashKey(apiKey));
    } catch {
      keyRecord = null;
    }
    if (!keyRecord || keyRecord.revoked) return next(new Error('invalid or revoked api key'));
    // F5: 키 검증 성공 직후 연결 슬롯 획득(IP/키/전역). 실패면 거부.
    const acquired = connGuard.tryAcquire(ip, keyRecord.id, socket);
    if (!acquired.ok) return next(new Error(acquired.reason));
    // 획득 이후 모든 예외 경로는 release 로 누수 방지. release 는 멱등.
    try {
      socket.data.mode = 'apiKey';
      socket.data.keyId = keyRecord.id;
      socket.data.account = keyRecord.accountId;
      socket.data.agentRecord = null;
      socket.data.agentSeq = 0;
      socket.data.connGuardIp = ip;
      socket.data.connGuardKey = keyRecord.id;
      return next();
    } catch (err) {
      connGuard.release(ip, keyRecord.id, socket);
      return next(err instanceof Error ? err : new Error('agent setup failed'));
    }
  }
  // 토큰 모드: 기존 경로 보존 + IP/전역 가드(키 없음).
  const token = auth.token;
  if (typeof token !== 'string' || token.length < 32) return next(new Error('invalid agent token'));
  const record = agentTokens.get(token);
  const validation = validateAgentRecord(record);
  if (!validation.ok) return next(new Error(validation.error));
  // F5: 토큰 검증 성공 직후 연결 슬롯 획득(keyId 없음 → IP/전역만).
  const acquired = connGuard.tryAcquire(ip, null, socket);
  if (!acquired.ok) return next(new Error(acquired.reason));
  try {
    socket.data.mode = 'token';
    socket.data.agentRecord = record;
    socket.data.agentSeq = 0;
    socket.data.connGuardIp = ip;
    socket.data.connGuardKey = null;
    next();
  } catch (err) {
    connGuard.release(ip, null, socket);
    next(err instanceof Error ? err : new Error('agent setup failed'));
  }
});

agentIo.on('connection', (socket) => {
  // F5: 어떤 종료 경로(정상 disconnect, 검증실패 disconnect(true), 예외)에서도
  // 연결 슬롯을 멱등 release 한다 → 카운터 누수 0. 가장 먼저 등록해 모든 종료를 포착.
  socket.on('disconnect', () => {
    connGuard.release(socket.data.connGuardIp, socket.data.connGuardKey, socket);
  });
  // apiKey 모드: 인증만 완료된 소켓 — S4 에서는 방 미배치. 인증 정보만 알린다.
  if (socket.data.mode === 'apiKey') {
    socket.emit('agentAuthenticated', {
      mode: 'apiKey',
      keyId: socket.data.keyId,
      account: socket.data.account,
    });
    emitUnassignedAgentStatus(socket);
    // F2: 로비 이벤트(rooms/createRoom/joinRoom/leaveRoom)만 throttle. 초과 시 거부(연결 유지).
    socket.on('rooms', () => {
      if (!msgThrottle.allow(socket)) return;
      socket.emit('rooms', lobby.listRooms(lobbyCtx));
    });
    socket.on('createRoom', (payload, ack) => {
      if (!lobbyThrottleOk(socket, payload, ack)) return;
      handleAgentCreateRoom(socket, payload, ack);
    });
    socket.on('joinRoom', (payload, ack) => {
      if (!lobbyThrottleOk(socket, payload, ack)) return;
      handleAgentJoinRoom(socket, payload, ack);
    });
    socket.on('leaveRoom', (ack) => {
      if (!lobbyThrottleOk(socket, ack)) return;
      handleAgentLeaveRoom(socket, ack);
    });
    socket.on('resumeAgent', (payload, ack) => {
      if (!lobbyThrottleOk(socket, payload, ack)) return;
      handleAgentResume(socket, payload, ack);
    });
    // startGame 은 로비 throttle 비대상(F2). agentAction 은 게임 액션이라 기존 30/s 만 적용.
    socket.on('startGame', (ack) => handleAgentStartGame(socket, ack));
    socket.on('agentPolicyUpdate', (payload, ack) => handleAgentPolicyUpdate(socket, payload, ack));
    socket.on('agentAction', (action, ack) => {
      if (!socket.data.agentRecord) {
        if (typeof ack === 'function') ack({ ok: false, error: 'join a room before sending actions' });
        return;
      }
      handleAgentAction(socket, action, ack);
    });
    socket.on('disconnect', () => handleAgentDisconnect(socket));
    return;
  }
  const record = socket.data.agentRecord;
  const validation = validateAgentRecord(record);
  if (!validation.ok) {
    socket.disconnect(true);
    return;
  }
  const room = validation.room;
  const reclaim = validation.reclaim === true;
  // G002 A3(1): connect 시 토큰을 소비하지 않는다(게임중 재접속 허용).
  // 토큰 회수는 disconnect(waiting)/leave/revoke/expire(미연결) 가 담당하고,
  // 이중접속은 validateAgentRecord 의 socket.connected 체크가 차단한다.
  record.socket = socket;
  socket.data.playerId = record.playerId;
  socket.data.roomId = record.roomId;
  socket.data.ownerId = record.ownerId;
  socket.join(room.id);
  if (reclaim && room.game && room.game.players.has(record.playerId)) {
    // 재접속 회수: 봇에서 슬롯 제어를 회수하고 클라 seq 레인을 재동기한다.
    record.disconnectedAtTick = null;
    record.lastClientTick = room.game.tick;
    record.botActive = false;
    if (record.bot) record.bot.reset();
    if (record.botPacer) record.botPacer.reset();
    record.botPolicyRevision = null;
    socket.data.agentSeq = Math.max(room.game.players.get(record.playerId).lastQueuedSeq, record.lastAgentSeq || 0);
    record.resumeContext = compactResume(room, record, true);
    if (!room.players.has(record.playerId)) {
      room.players.set(record.playerId, {
        nick: record.nick,
        team: record.team,
        char: record.char,
        controller: 'agent',
        ownerId: record.ownerId,
      });
    }
  } else {
    room.players.set(record.playerId, {
      nick: record.nick,
      team: record.team,
      char: record.char,
      controller: 'agent',
      ownerId: record.ownerId,
    });
  }
  const readyPayload = {
    room: roomDetail(room),
    playerId: record.playerId,
    ownerId: record.ownerId,
    resume: record.resumeContext || compactResume(room, record, false),
  };
  socket.emit('agentReady', readyPayload);
  emitAgentStatus(socket, record, room, null);
  io.to(room.id).emit('roomUpdate', roomDetail(room));
  broadcastRooms();

  socket.on('agentAction', (action, ack) => handleAgentAction(socket, action, ack));
  socket.on('agentPolicyUpdate', (payload, ack) => handleAgentPolicyUpdate(socket, payload, ack));
  socket.on('disconnect', () => handleAgentDisconnect(socket));
});

io.on('connection', (socket) => {
  socket.data.nick = '플레이어';
  socket.join('lobby');
  socket.emit('rooms', roomList());

  socket.on('setNick', (nick) => {
    if (typeof nick === 'string' && nick.trim()) {
      socket.data.nick = nick.trim().slice(0, 12);
    }
  });

  socket.on('setChar', (char) => {
    if (!Number.isInteger(char) || char < 0 || char >= CHAR_COUNT) return;
    socket.data.char = char;
    const room = rooms.get(socket.data.roomId);
    if (room && room.state === 'waiting') {
      const p = room.players.get(socket.id);
      if (p) {
        p.char = char;
        io.to(room.id).emit('roomUpdate', roomDetail(room));
        return;
      }
      const s = room.spectators && room.spectators.get(socket.id);
      if (s) {
        s.char = char;
        io.to(room.id).emit('roomUpdate', roomDetail(room));
      }
    }
  });

  socket.on('createRoom', (name) => {
    // F1: 메인 io 방 생성 최소 throttle. 게임 입력(이동/폭탄)엔 미적용. 초과 시 기존 errorMsg 패턴으로 거부.
    if (!mainCreateThrottle.allow(socket)) return socket.emit('errorMsg', '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.');
    if (socket.data.roomId) return;
    const identity = { id: socket.id, nick: socket.data.nick, char: socket.data.char || 0, controller: 'human' };
    const { room } = lobby.doCreateRoom(lobbyCtx, identity, { name });
    socket.leave('lobby');
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('joinedRoom', roomDetail(room));
    sendChatHistory(socket, room);
    broadcastRooms();
  });

  socket.on('joinRoom', (roomId) => {
    if (socket.data.roomId) return;
    const identity = { id: socket.id, nick: socket.data.nick, char: socket.data.char || 0, controller: 'human' };
    const result = lobby.doJoinRoom(lobbyCtx, identity, roomId);
    if (result.error) {
      socket.emit('errorMsg', HUMAN_JOIN_ERROR[result.error] || '방에 입장할 수 없습니다.');
      return;
    }
    const room = result.room;
    socket.leave('lobby');
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('joinedRoom', roomDetail(room));
    sendChatHistory(socket, room);
    io.to(room.id).emit('roomUpdate', roomDetail(room));
    broadcastRooms();
    reviewRoomLifecycle(room);
  });

  socket.on('leaveRoom', () => {
    leaveRoom(socket);
    socket.join('lobby');
    socket.emit('rooms', roomList());
  });

  socket.on('setMode', (mode) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.host !== socket.id || room.state === 'playing') return;
    if (mode !== 'ffa' && mode !== 'team' && mode !== 'boss') return;
    room.mode = mode;
    if (mode === 'team') {
      // rebalance: alternate red/blue in join order
      let i = 0;
      for (const p of room.players.values()) p.team = i++ % 2 === 0 ? 'red' : 'blue';
    }
    io.to(room.id).emit('roomUpdate', roomDetail(room));
    broadcastRooms();
  });

  socket.on('setMap', (mapId) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.host !== socket.id || room.state === 'playing' || room.mode === 'boss') return;
    if (!Catalog.MAP_ORDER.includes(mapId)) return;
    room.mapId = mapId;
    io.to(room.id).emit('roomUpdate', roomDetail(room));
    broadcastRooms();
  });

  socket.on('setTeam', (team) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state === 'playing' || room.mode !== 'team') return;
    if (team !== 'red' && team !== 'blue') return;
    const p = room.players.get(socket.id);
    if (p) {
      p.team = team;
      io.to(room.id).emit('roomUpdate', roomDetail(room));
    }
  });

  socket.on('setSpectator', (payload, ack) => {
    const room = rooms.get(socket.data.roomId);
    const spectator = payload && typeof payload === 'object' ? payload.spectator === true : payload === true;
    const reply = (p) => { if (typeof ack === 'function') ack(p); };
    if (!room || room.state === 'playing') {
      reply({ ok: false, error: 'cannot change spectator state' });
      return;
    }
    const identity = { id: socket.id, nick: socket.data.nick, char: socket.data.char || 0, controller: 'human' };
    const result = lobby.doSetSpectator(lobbyCtx, identity, spectator);
    if (result.error) {
      const error = result.error === 'full' ? '방이 가득 찼습니다.' : '관전자 상태를 변경할 수 없습니다.';
      socket.emit('errorMsg', error);
      reply({ ok: false, error });
      return;
    }
    io.to(room.id).emit('roomUpdate', roomDetail(room));
    broadcastRooms();
    reviewRoomLifecycle(room);
    reply({ ok: true, room: roomDetail(room) });
  });

  socket.on('chatMessage', (payload, ack) => {
    handleChatMessage(socket, payload, ack);
  });

  socket.on('createAgentInvite', (options, ack) => {
    if (typeof options === 'function') {
      ack = options;
      options = {};
    }
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'waiting') {
      respond(socket, ack, 'agentInviteError', { ok: false, error: 'agent invites require a waiting room' });
      return;
    }
    const owner = room.players.get(socket.id) || (room.spectators && room.spectators.get(socket.id));
    if (!owner || !isHumanPlayer(owner)) {
      respond(socket, ack, 'agentInviteError', { ok: false, error: 'agent invite owner is unavailable' });
      return;
    }
    const existing = agentRecordsByOwner.get(socket.id);
    if (existing && existing.roomId === room.id) {
      if (existing.token) {
        sendAgentInvite(socket, ack, existing);
        return;
      }
      respond(socket, ack, 'agentInviteError', { ok: false, error: 'agent is already connected' });
      return;
    }
    if (existing) removeAgent(existing, { revokeInvite: true, disconnectSocket: true, emitUpdates: true });
    if (room.players.size >= MAX_PLAYERS) {
      respond(socket, ack, 'agentInviteError', { ok: false, error: 'room is full' });
      return;
    }
    const fallbackNick = `${cleanNick(owner.nick, AGENT_DEFAULT_NICK)} AI`.slice(0, 12);
    const record = {
      token: makeAgentToken(),
      roomId: room.id,
      ownerId: socket.id,
      playerId: `agent:${socket.id}:${crypto.randomBytes(8).toString('hex')}`,
      nick: cleanNick(options && options.nick, fallbackNick),
      char: cleanChar(options && options.char, owner.char || 0),
      team: cleanTeam(room, options && options.team),
      socket: null,
    };
    agentRecordsByOwner.set(socket.id, record);
    agentRecords.set(record.playerId, record);
    agentTokens.set(record.token, record);
    sendAgentInvite(socket, ack, record);
  });

  socket.on('revokeAgentInvite', (...args) => {
    const ack = args.find((arg) => typeof arg === 'function');
    const record = agentRecordsByOwner.get(socket.id);
    if (record) {
      removeAgent(record, { revokeInvite: true, disconnectSocket: true, emitUpdates: true });
    }
    respond(socket, ack, 'agentInviteRevoked', { ok: true });
  });

  socket.on('startGame', () => {
    // F1: 메인 io 게임 시작 최소 throttle(createRoom 과 독립 윈도우).
    if (!mainStartThrottle.allow(socket)) return socket.emit('errorMsg', '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.');
    const room = rooms.get(socket.data.roomId);
    if (!room || room.host !== socket.id || room.state === 'playing') return;
    if (room.mode === 'team') {
      if (room.players.size < 2) return socket.emit('errorMsg', '팀전은 최소 2명이 필요합니다.');
      const teams = new Set([...room.players.values()].map((p) => p.team));
      if (teams.size < 2) return socket.emit('errorMsg', '팀전은 양 팀에 최소 1명씩 필요합니다.');
    }
    const started = startGame(room);
    if (!started.ok) return socket.emit('errorMsg', started.error);
  });

  socket.on('cmd', (cmd) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.queueCmd(socket.id, cmd);
  });

  socket.on('placeBomb', () => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.placeBomb(socket.id);
  });

  socket.on('useNeedle', () => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.useNeedle(socket.id);
  });

  socket.on('selectItem', (type) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.selectItem(socket.id, type);
  });

  socket.on('useItem', (type) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.useActiveItem(socket.id, type);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Crazay Arkade server running: http://localhost:${PORT}`);
});
