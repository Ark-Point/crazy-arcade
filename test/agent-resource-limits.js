'use strict';

// G007(S7): 자원/동시성 상한 + 에이전트 예약 파티셔닝 검증.
// 흐름: 테스트마다 임시 BYO_KEY_STORE_PATH store 에 distinct 키를 발급하고,
//       낮은 임계값(env)으로 전용 서버를 spawn 해서 경계/예약을 확인한다(테스트간 격리).
//  AC12: 전역 동시 게임 상한 — 한도까지 시작 통과, 초과 거부('서버 동시 게임 수가 가득 찼습니다.').
//  AC13: 전역 에이전트 연결 상한(G006 conn-guard 재사용) — 한도까지 통과, 초과 거부.
//  AC14: 키별 동시 게임 상한 — 같은 키가 maxGamesPerKey 개 진행중이면 추가 create/join 거부.
//  F1  : 미인증 메인io 가 휴먼 전용 게임을 휴먼 칩(maxGames-reserved)까지 채워도,
//        인증 에이전트는 예약 슬롯으로 여전히 startGame 가능(예약분 비잠식).
//
// server/auth/* 와 게임 30/s 불변식(AGENT_ACTIONS_PER_SEC_CAP)은 건드리지 않는다.

const { test, after } = require('node:test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  closeAll,
  assert,
  connectHuman,
  connectAgentWithKey,
  expectAgentKeyRejected,
  waitForEvent,
  emitRawAck,
  getFreePort,
  waitForServer,
} = require('./helpers/agent-harness');
const { createStore } = require('../server/auth/store');
const { GAME_CAPACITY_ERROR, KEY_GAMES_ERROR } = require('../server/limits/resource-caps');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// spawn 한 자식/임시 디렉터리 추적 — after()에서 일괄 정리.
const spawned = [];

// 공통(넉넉한) 연결/throttle 상한 — 게임 상한 경계만 보이도록 다른 가드는 비간섭으로 둔다.
const BASE_ENV = {
  BYO_MAX_CONNS_PER_IP: '50',
  BYO_MAX_CONNS_PER_KEY: '10',
  BYO_GLOBAL_MAX_AGENT_CONNS: '100',
  BYO_MAIN_IO_CREATE_PER_SEC: '50',
};

// 임시 store + 키 발급 후, 주어진 env 로 전용 서버를 spawn 한다.
async function spawnCapServer(extraEnv, keyCount = 12) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-res-caps-'));
  const storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'res-caps' });
  const keys = [];
  for (let i = 0; i < keyCount; i++) {
    const issued = await store.issueKey(account.id, `key-${i}`);
    keys.push(issued.key);
  }
  const port = await getFreePort();
  const url = `http://localhost:${port}`;
  const child = spawn('node', ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), BYO_KEY_STORE_PATH: storePath, ...BASE_ENV, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push({ child, tmpDir });
  await waitForServer(url);
  return { url, keys, child };
}

// apiKey 에이전트 startGame 은 ack 콜백을 '첫 인자'로 받는다(서버 와이어링 계약).
// 따라서 payload 없이 콜백만 실어 보낸다(emitWithAck 처럼 payload 를 끼우면 ack 가 어긋난다).
function startGameAck(socket, ms = 1500) {
  return new Promise((resolve, reject) => {
    socket.timeout(ms).emit('startGame', (err, response) => {
      if (err) reject(new Error(`startGame ack timed out: ${err.message || err}`));
      else resolve(response);
    });
  });
}

// 인증 에이전트로 solo ffa 방을 만들고 게임을 시작한다(성공 기대). 시작된 소켓 반환.
async function startAgentGame(url, key, label) {
  const { agent } = await connectAgentWithKey(url, key, label);
  const createAck = await emitRawAck(agent, 'createRoom', { name: label });
  assert(createAck && createAck.ok === true, `${label}: createRoom should succeed, got ${JSON.stringify(createAck)}`);
  const startAck = await startGameAck(agent);
  assert(startAck && startAck.ok === true, `${label}: startGame should succeed, got ${JSON.stringify(startAck)}`);
  return agent;
}

// 미인증 메인io 휴먼으로 solo ffa 방을 만들고 게임을 시작한다(성공 기대). 휴먼 소켓 반환.
async function startHumanGame(url, name) {
  const human = await connectHuman(url);
  human.emit('createRoom', name);
  await waitForEvent(human, 'joinedRoom', (r) => r && r.id, `${name} create`);
  human.emit('startGame');
  await waitForEvent(human, 'gameStart', () => true, `${name} start`);
  return human;
}

after(async () => {
  closeAll();
  for (const { child, tmpDir } of spawned) {
    try { child.kill(); } catch { /* ignore */ }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

// AC12: 전역 동시 게임 상한 — 한도까지 시작 통과, 초과 거부.
test('AC12: global concurrent game cap admits up to the cap and rejects beyond it', async () => {
  const MAX_GAMES = 4;
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: String(MAX_GAMES),
    BYO_AGENT_RESERVED_GAMES: '2', // 예약은 휴먼만 제한 — 에이전트는 전역 4까지 사용 가능.
    BYO_MAX_GAMES_PER_KEY: String(MAX_GAMES), // 키별 상한이 전역 상한 전에 걸리지 않게.
  });

  const agents = [];
  // distinct 키로 MAX_GAMES 개 게임 시작 → 모두 통과(에이전트는 예약분까지 포함해 전역 4까지).
  for (let i = 0; i < MAX_GAMES; i++) {
    agents.push(await startAgentGame(url, keys[i], `ac12-ok-${i}`));
  }

  // 상한 초과(5번째) → 방 생성은 되지만 startGame 이 전역 상한에 걸려 거부.
  const { agent: overflow } = await connectAgentWithKey(url, keys[MAX_GAMES], 'ac12-overflow');
  agents.push(overflow);
  const createAck = await emitRawAck(overflow, 'createRoom', { name: 'ac12-overflow' });
  assert(createAck && createAck.ok === true, `AC12: overflow createRoom should succeed, got ${JSON.stringify(createAck)}`);
  const startAck = await startGameAck(overflow);
  assert(startAck && startAck.ok === false, `AC12: overflow start must be rejected, got ${JSON.stringify(startAck)}`);
  assert(
    startAck.error === GAME_CAPACITY_ERROR,
    `AC12: expected "${GAME_CAPACITY_ERROR}", got "${startAck.error}"`
  );

  for (const a of agents) a.close();
  await delay(150);
});

// AC13: 전역 에이전트 연결 상한(G006 conn-guard 재사용) — 한도까지 통과, 초과 거부.
test('AC13: global agent connection cap (conn-guard) admits up to the cap and rejects beyond it', async () => {
  const GLOBAL_CONNS = 4;
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_AGENT_CONNS: String(GLOBAL_CONNS),
  });

  const agents = [];
  // distinct 키로 GLOBAL_CONNS 개 연결 → 모두 성공(IP/키 상한은 넉넉, 전역만 카운트).
  for (let i = 0; i < GLOBAL_CONNS; i++) {
    const { agent } = await connectAgentWithKey(url, keys[i], `ac13-ok-${i}`);
    assert(agent.connected, `AC13: connection ${i} (within cap) should succeed`);
    agents.push(agent);
  }
  // 전역 상한 초과 → distinct 키여도 전역 에이전트 연결 상한에 걸려 거부.
  const reason = await expectAgentKeyRejected(url, keys[GLOBAL_CONNS], 'ac13-overflow');
  assert(
    reason === 'server connection capacity reached',
    `AC13: overflow must be rejected for global cap, got "${reason}"`
  );

  for (const a of agents) a.close();
  await delay(150);
});

// AC14: 키별 동시 게임 상한 — 같은 키가 maxGamesPerKey 개 진행중이면 추가 create 거부.
test('AC14: per-key concurrent game cap rejects further rooms once the key is at the cap', async () => {
  const PER_KEY = 2;
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: '20', // 전역 상한이 키 상한 전에 걸리지 않게.
    BYO_AGENT_RESERVED_GAMES: '0',
    BYO_MAX_GAMES_PER_KEY: String(PER_KEY),
  });

  const key = keys[0];
  const agents = [];
  // 같은 키로 PER_KEY 개 게임 시작 → 통과(키별 동시 게임 = PER_KEY).
  for (let i = 0; i < PER_KEY; i++) {
    agents.push(await startAgentGame(url, key, `ac14-ok-${i}`));
  }

  // 같은 키의 (PER_KEY+1) 번째는 create 진입부 키 게이트에서 거부(이미 PER_KEY 개 진행중).
  const { agent: overflow } = await connectAgentWithKey(url, key, 'ac14-overflow');
  agents.push(overflow);
  const createAck = await emitRawAck(overflow, 'createRoom', { name: 'ac14-overflow' });
  assert(createAck && createAck.ok === false, `AC14: same-key createRoom must be rejected, got ${JSON.stringify(createAck)}`);
  assert(
    createAck.error === KEY_GAMES_ERROR,
    `AC14: expected "${KEY_GAMES_ERROR}", got "${createAck.error}"`
  );

  for (const a of agents) a.close();
  await delay(150);
});

// F1: 미인증 메인io 가 휴먼 전용 게임을 휴먼 칩(maxGames-reserved)까지 채워도,
//     인증 에이전트는 예약 슬롯으로 여전히 startGame 가능(예약분 비잠식).
test('F1: humans filling the human floor never starve the agent reserved slots', async () => {
  const MAX_GAMES = 4;
  const RESERVED = 2;
  const HUMAN_CAP = MAX_GAMES - RESERVED; // = 2
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: String(MAX_GAMES),
    BYO_AGENT_RESERVED_GAMES: String(RESERVED),
    BYO_MAX_GAMES_PER_KEY: '2',
  });

  const humans = [];
  // 미인증 메인io 로 휴먼 전용 게임을 휴먼 칩(2)까지 채운다.
  for (let i = 0; i < HUMAN_CAP; i++) {
    humans.push(await startHumanGame(url, `f1-human-${i}`));
  }

  // 휴먼 칩 초과: 3번째 휴먼 게임은 거부(errorMsg) — 예약분을 잠식하지 못한다.
  const human3 = await connectHuman(url);
  humans.push(human3);
  human3.emit('createRoom', 'f1-human-overflow');
  await waitForEvent(human3, 'joinedRoom', (r) => r && r.id, 'f1 human overflow create');
  human3.emit('startGame');
  const rejectMsg = await waitForEvent(human3, 'errorMsg', () => true, 'f1 human overflow reject');
  assert(
    rejectMsg === GAME_CAPACITY_ERROR,
    `F1: human over-floor start must be rejected, expected "${GAME_CAPACITY_ERROR}", got "${rejectMsg}"`
  );

  // 핵심 단언: 휴먼 칩이 가득 차도, 인증 에이전트는 예약 슬롯으로 게임을 시작할 수 있다.
  const { agent } = await connectAgentWithKey(url, keys[0], 'f1-agent');
  humans.push(agent);
  const createAck = await emitRawAck(agent, 'createRoom', { name: 'f1-agent-room' });
  assert(createAck && createAck.ok === true, `F1: agent createRoom should succeed, got ${JSON.stringify(createAck)}`);
  const startAck = await startGameAck(agent);
  assert(
    startAck && startAck.ok === true,
    `F1: agent must start via reserved slot even when human floor is full, got ${JSON.stringify(startAck)}`
  );

  for (const h of humans) h.close();
  await delay(150);
});
