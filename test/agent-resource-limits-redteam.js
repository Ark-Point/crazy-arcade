'use strict';

// G007(S7) 적대(red-team): 자원 상한/예약 파티셔닝을 '깨려는' 의도의 케이스 모음.
// 기존 test/agent-resource-limits.js(AC12/13/14/F1) 가 정상 경계를 검증한다면, 이 파일은
// 파티션 경계·경합·상태 비변형·집계 정확성을 적대적으로 두드린다(제품 코드 비변형).
//   (1) F1 심화 : 휴먼 플로어 포화 + 전역 maxGames 근접에서도 예약 슬롯으로 에이전트 시작 가능,
//                 단 전역 maxGames 도달 시 신규(에이전트) 게임 거부.            [F1/AC12]
//   (2) 키 경계 : 같은 키 maxGamesPerKey 도달 후 create 거부 → 게임 종료(방 삭제)로
//                 슬롯 반환되면 같은 키로 재시작 가능.                          [AC14]
//   (3) 혼합방  : 사람+에이전트 혼합방은 agentInvolved 로 집계(휴먼전용 카운트 미산입). [F1]
//   (4) 경합    : 동시 다수 startGame 에도 전역 상한 정확(초과 0).               [AC12]
//   (5) 비변형  : 거부된 startGame 은 방을 playing 으로 바꾸지 않는다.           [AC12]
//   (6) 회귀    : keyId 없는 토큰 에이전트는 키별 상한 비대상(무회귀).           [AC14]
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
  connectAgent,
  connectAgentWithKey,
  waitForEvent,
  emitWithAck,
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
  BYO_MAX_CONNS_PER_IP: '100',
  BYO_MAX_CONNS_PER_KEY: '20',
  BYO_GLOBAL_MAX_AGENT_CONNS: '200',
  BYO_MAIN_IO_CREATE_PER_SEC: '100',
};

// 임시 store + 키 발급 후, 주어진 (낮은 임계값) env 로 전용 서버를 spawn 한다(테스트간 격리).
async function spawnCapServer(extraEnv, keyCount = 12) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-res-redteam-'));
  const storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'res-redteam' });
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
function startGameAck(socket, ms = 2000) {
  return new Promise((resolve, reject) => {
    socket.timeout(ms).emit('startGame', (err, response) => {
      if (err) reject(new Error(`startGame ack timed out: ${err.message || err}`));
      else resolve(response);
    });
  });
}

// 콜백을 '첫 인자'로 받는 로비 이벤트(leaveRoom 등) ack 헬퍼.
function callbackAck(socket, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    socket.timeout(ms).emit(event, (err, response) => {
      if (err) reject(new Error(`${event} ack timed out: ${err.message || err}`));
      else resolve(response);
    });
  });
}

// apiKey 에이전트로 방만 만든다(시작 전). { agent, name } 반환.
async function createAgentRoom(url, key, name) {
  const { agent } = await connectAgentWithKey(url, key, name);
  const createAck = await emitRawAck(agent, 'createRoom', { name });
  assert(createAck && createAck.ok === true, `${name}: createRoom should succeed, got ${JSON.stringify(createAck)}`);
  return { agent, name };
}

// apiKey 에이전트로 solo 방 생성 + 게임 시작(성공 기대). agent 소켓 반환.
async function startAgentGame(url, key, name) {
  const { agent } = await createAgentRoom(url, key, name);
  const startAck = await startGameAck(agent);
  assert(startAck && startAck.ok === true, `${name}: startGame should succeed, got ${JSON.stringify(startAck)}`);
  return agent;
}

// 미인증 메인io 휴먼으로 solo 방 생성 + 게임 시작(성공 기대). human 소켓 반환.
async function startHumanGame(url, name) {
  const human = await connectHuman(url);
  human.emit('createRoom', name);
  await waitForEvent(human, 'joinedRoom', (r) => r && r.id, `${name} create`);
  human.emit('startGame');
  await waitForEvent(human, 'gameStart', () => true, `${name} start`);
  return human;
}

// 휴먼 호스트 + 토큰 에이전트(invite) 혼합방을 만들고 게임을 시작한다(성공 기대).
// 토큰 에이전트는 keyId 가 없다(키별 상한 비대상). { human, agent } 반환.
async function startTokenAgentGame(url, name) {
  const human = await connectHuman(url);
  human.emit('setNick', name);
  human.emit('createRoom', name);
  await waitForEvent(human, 'joinedRoom', (r) => r && r.id, `${name} create`);
  const invite = await emitWithAck(human, 'createAgentInvite', { nick: `${name}ai`.slice(0, 12), char: 1 });
  assert(invite && typeof invite.token === 'string' && invite.token.length >= 16, `${name}: invite token missing`);
  // 에이전트 player 가 방에 합류(roomUpdate 반영)할 때까지 대기 — 리스너를 connect 이전에 건다.
  const agentJoined = waitForEvent(
    human,
    'roomUpdate',
    (r) => r && Array.isArray(r.players) && r.players.some((p) => p.controller === 'agent'),
    `${name} agent join`
  );
  const agent = await connectAgent(url, invite.token, `${name}-agent`);
  await agentJoined;
  human.emit('startGame');
  await waitForEvent(human, 'gameStart', () => true, `${name} start`);
  return { human, agent };
}

// apiKey 소켓으로 현재 로비 방 목록을 한 번 조회한다(state 비변형 검증용).
function requestRooms(socket, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('rooms', handler); reject(new Error('rooms list timed out')); }, ms);
    const handler = (list) => { clearTimeout(timer); socket.off('rooms', handler); resolve(list); };
    socket.on('rooms', handler);
    socket.emit('rooms');
  });
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

// (1) F1 심화: 휴먼 플로어 포화 + 전역 maxGames 근접에서도 예약 슬롯으로 에이전트 시작 가능,
//     단 전역 maxGames 도달 시 신규 에이전트 게임 거부('서버 동시 게임 수가 가득 찼습니다.').
test('RT1: agents claim reserved slots under a full human floor, then are refused once global cap is hit', async () => {
  const MAX_GAMES = 4;
  const RESERVED = 2;
  const HUMAN_CAP = MAX_GAMES - RESERVED; // = 2
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: String(MAX_GAMES),
    BYO_AGENT_RESERVED_GAMES: String(RESERVED),
    BYO_MAX_GAMES_PER_KEY: '4', // 키별 상한이 전역 경계 전에 걸리지 않게.
  });

  const sockets = [];
  // 휴먼 전용 게임을 휴먼 플로어(2)까지 포화.
  for (let i = 0; i < HUMAN_CAP; i++) {
    sockets.push(await startHumanGame(url, `rt1-human-${i}`));
  }

  // 예약 슬롯(2)을 에이전트가 사용: 휴먼 플로어가 가득 차도 전역 maxGames 까지 시작 가능.
  for (let i = 0; i < RESERVED; i++) {
    sockets.push(await startAgentGame(url, keys[i], `rt1-agent-${i}`));
  }
  // 이 시점 전역 playing == MAX_GAMES(4). 예약분이 휴먼에 잠식되지 않았음을 입증.

  // 전역 상한 도달: 신규 에이전트 게임은 거부(예약/공유 무관, 전역 포화).
  const { agent: overflow } = await createAgentRoom(url, keys[RESERVED], 'rt1-agent-overflow');
  sockets.push(overflow);
  const startAck = await startGameAck(overflow);
  assert(startAck && startAck.ok === false, `RT1: overflow agent start must be rejected, got ${JSON.stringify(startAck)}`);
  assert(
    startAck.error === GAME_CAPACITY_ERROR,
    `RT1: expected "${GAME_CAPACITY_ERROR}", got "${startAck.error}"`
  );

  for (const s of sockets) s.close();
  await delay(150);
});

// (2) 키 경계 + 슬롯 반환: 같은 키가 maxGamesPerKey 도달 후 create 거부 →
//     한 게임 종료(leaveRoom 으로 방 삭제)로 슬롯 반환되면 같은 키로 재시작 가능.
test('RT2: per-key cap rejects at the boundary, then readmits after a game ends and returns the slot', async () => {
  const PER_KEY = 2;
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: '20', // 전역이 키 경계 전에 걸리지 않게.
    BYO_AGENT_RESERVED_GAMES: '0',
    BYO_MAX_GAMES_PER_KEY: String(PER_KEY),
  });

  const key = keys[0];
  const running = [];
  // 같은 키로 PER_KEY 개 게임 시작(키별 동시 게임 = PER_KEY).
  for (let i = 0; i < PER_KEY; i++) {
    running.push(await startAgentGame(url, key, `rt2-ok-${i}`));
  }

  // (PER_KEY+1) 번째 동일 키 create → 선제 키 게이트에서 거부.
  const { agent: blocked } = await connectAgentWithKey(url, key, 'rt2-blocked');
  const blockedCreate = await emitRawAck(blocked, 'createRoom', { name: 'rt2-blocked' });
  assert(blockedCreate && blockedCreate.ok === false, `RT2: same-key createRoom must be rejected, got ${JSON.stringify(blockedCreate)}`);
  assert(
    blockedCreate.error === KEY_GAMES_ERROR,
    `RT2: expected "${KEY_GAMES_ERROR}", got "${blockedCreate.error}"`
  );
  blocked.close();

  // 한 게임 종료: leaveRoom 으로 solo 에이전트 방을 삭제 → 키 슬롯 1개 반환.
  const leaveAck = await callbackAck(running[0], 'leaveRoom');
  assert(leaveAck && leaveAck.ok === true, `RT2: leaveRoom should succeed, got ${JSON.stringify(leaveAck)}`);
  running[0].close();
  await delay(250); // 서버의 방 정리/브로드캐스트 반영 대기.

  // 슬롯 반환 후 같은 키로 재시작 가능(키별 동시 게임 = PER_KEY-1 < cap).
  const restart = await startAgentGame(url, key, 'rt2-restart');
  running.push(restart);

  for (const s of running) { try { s.close(); } catch { /* ignore */ } }
  await delay(150);
});

// (3) 혼합방 집계: 사람+에이전트 혼합방은 agentInvolved 로 집계되어 휴먼전용 카운트에 들어가지 않는다.
//     혼합방이 휴먼전용으로 오집계되면 아래 두 번째 휴먼 게임이 거부될 것이다(미발생을 단언).
test('RT3: a mixed human+agent room counts as agent-involved, not against the human-only floor', async () => {
  const MAX_GAMES = 4;
  const RESERVED = 2;
  const HUMAN_CAP = MAX_GAMES - RESERVED; // = 2
  const { url } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: String(MAX_GAMES),
    BYO_AGENT_RESERVED_GAMES: String(RESERVED),
    BYO_MAX_GAMES_PER_KEY: '4',
  });

  const sockets = [];
  // 혼합방 1개(휴먼 호스트 + 토큰 에이전트) 시작 → agentInvolved 로 집계되어야 함.
  const mixed = await startTokenAgentGame(url, 'rt3-mixed');
  sockets.push(mixed.human, mixed.agent);

  // 휴먼 전용 게임을 휴먼 플로어(2)까지 채운다. 혼합방이 휴먼전용에 산입됐다면 2번째가 거부됨.
  for (let i = 0; i < HUMAN_CAP; i++) {
    sockets.push(await startHumanGame(url, `rt3-human-${i}`));
  }

  // 휴먼 플로어 초과(3번째 휴먼 전용) → 거부. 이는 혼합방이 휴먼전용에 산입되지 '않았기에'
  // 정확히 HUMAN_CAP 개의 휴먼전용만 통과했음을 입증한다.
  const human3 = await connectHuman(url);
  sockets.push(human3);
  human3.emit('createRoom', 'rt3-human-of');
  await waitForEvent(human3, 'joinedRoom', (r) => r && r.id, 'rt3 human overflow create');
  human3.emit('startGame');
  const rejectMsg = await waitForEvent(human3, 'errorMsg', () => true, 'rt3 human overflow reject');
  assert(
    rejectMsg === GAME_CAPACITY_ERROR,
    `RT3: 3rd human-only start must be rejected at the floor, expected "${GAME_CAPACITY_ERROR}", got "${rejectMsg}"`
  );

  for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
  await delay(150);
});

// (4) 경합: 전역 상한 초과 개수만큼의 startGame 을 '동시에' 쏴도 통과 수는 정확히 cap.
//     게이트(읽기→playing 표시)가 단일 이벤트루프에서 원자적이라 초과가 발생하지 않음을 입증.
test('RT4: concurrent startGame storm never exceeds the global cap (exact admission)', async () => {
  const MAX_GAMES = 3;
  const ATTEMPTS = 6; // cap 의 2배를 동시에 시도.
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: String(MAX_GAMES),
    BYO_AGENT_RESERVED_GAMES: '0',
    BYO_MAX_GAMES_PER_KEY: String(ATTEMPTS), // 키별 상한이 전역 경계 전에 걸리지 않게.
  }, ATTEMPTS + 2);

  // 먼저 distinct 키로 ATTEMPTS 개 방을 만들어 둔다(아직 시작 전).
  const rooms = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    rooms.push(await createAgentRoom(url, keys[i], `rt4-${i}`));
  }

  // 모든 방에서 동시에 startGame 을 쏜다.
  const results = await Promise.all(rooms.map((r) => startGameAck(r.agent)));
  const ok = results.filter((r) => r && r.ok === true).length;
  const rejected = results.filter((r) => r && r.ok === false);

  assert(ok === MAX_GAMES, `RT4: exactly ${MAX_GAMES} starts must succeed under contention, got ${ok}`);
  assert(
    rejected.length === ATTEMPTS - MAX_GAMES,
    `RT4: remaining ${ATTEMPTS - MAX_GAMES} must be rejected, got ${rejected.length}`
  );
  assert(
    rejected.every((r) => r.error === GAME_CAPACITY_ERROR),
    `RT4: all rejections must be capacity errors, got ${JSON.stringify(rejected.map((r) => r.error))}`
  );

  for (const r of rooms) r.agent.close();
  await delay(150);
});

// (5) 비변형: 전역 상한으로 거부된 startGame 은 그 방을 playing 으로 바꾸지 않는다.
//     거부 후 로비 목록을 조회해 해당 방이 여전히 waiting(playing=false)임을 단언.
test('RT5: a rejected startGame leaves the room state unchanged (still waiting)', async () => {
  const { url, keys } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: '1', // 전역 1 → 두 번째 게임은 무조건 거부.
    BYO_AGENT_RESERVED_GAMES: '0',
    BYO_MAX_GAMES_PER_KEY: '4',
  });

  // 1개 게임을 점유해 전역을 포화.
  const runner = await startAgentGame(url, keys[0], 'rt5-run');

  // 두 번째 방 생성 후 startGame → 전역 상한으로 거부.
  const { agent: overflow } = await createAgentRoom(url, keys[1], 'rt5-over');
  const startAck = await startGameAck(overflow);
  assert(startAck && startAck.ok === false, `RT5: overflow start must be rejected, got ${JSON.stringify(startAck)}`);
  assert(startAck.error === GAME_CAPACITY_ERROR, `RT5: expected "${GAME_CAPACITY_ERROR}", got "${startAck.error}"`);

  // 거부 후 로비 목록: 거부된 방은 playing 으로 변형되지 않아야 한다(state 비변형).
  const list = await requestRooms(overflow);
  const over = list.find((r) => r.name === 'rt5-over');
  const run = list.find((r) => r.name === 'rt5-run');
  assert(over, `RT5: overflow room must still exist in the lobby list, got ${JSON.stringify(list)}`);
  assert(over.playing === false, `RT5: rejected room must remain waiting (playing=false), got ${JSON.stringify(over)}`);
  assert(run && run.playing === true, `RT5: the admitted room must be playing, got ${JSON.stringify(run)}`);

  runner.close();
  overflow.close();
  await delay(150);
});

// (6) 회귀: keyId 없는 토큰 에이전트는 키별 상한 비대상.
//     maxGamesPerKey=1 이어도 토큰 에이전트 혼합방은 여러 개 시작 가능(키 게이트 미적용).
test('RT6: token agents (no keyId) are not subject to the per-key cap', async () => {
  const { url } = await spawnCapServer({
    BYO_GLOBAL_MAX_GAMES: '20',
    BYO_AGENT_RESERVED_GAMES: '0',
    BYO_MAX_GAMES_PER_KEY: '1', // apiKey 라면 1개로 제한되겠지만, 토큰 에이전트엔 키가 없다.
  });

  const sockets = [];
  // 토큰 에이전트 혼합방을 PER_KEY 상한(1)을 초과하는 개수만큼 시작 → 모두 성공해야 함.
  for (let i = 0; i < 3; i++) {
    const { human, agent } = await startTokenAgentGame(url, `rt6-tok-${i}`);
    sockets.push(human, agent);
  }
  // 위 루프가 예외 없이 끝났다면 토큰 에이전트가 키별 상한에 걸리지 않았다는 뜻(무회귀).

  for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
  await delay(150);
});
