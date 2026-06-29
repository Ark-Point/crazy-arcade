'use strict';

// G006(S6) RED-TEAM: 연결 가드(conn-guard) + 메시지 throttle(msg-throttle) 를
// 의도적으로 깨려는 적대 테스트. 제품 코드는 건드리지 않고, 임시 BYO_KEY_STORE_PATH
// store + 낮은 상한(env)으로 서버를 spawn 해 경계/누수/멱등/분리를 공격적으로 검증한다.
//
//  RT1 거부 폭주 후 카운터 누수 0 — 상한 도달→거부 N회→close→슬롯 정확히 회복 재연결 성공.
//  RT2 키·IP 혼합 경계 — 다른 키 같은 IP(IP 상한), 같은 키 다른 연결(키 상한)이 각자 정확히 발동.
//  RT3 로비 throttle 경계 — 정확히 cap 통과, cap+1 거부, 1초 후 윈도우 회복.
//  RT4 분리 — 로비 throttle 포화 중에도 게임중 agentAction 비거부, 게임 액션 30/s 자체 가드는 동작.
//  RT5 멱등 — 중복 disconnect·반복 acquire/release 에도 카운터 음수/오차 0(정확히 1 슬롯만 회복).
//  RT6 메인io create/start throttle — 초과 거부, 1초 뒤 회복, 게임입력엔 미적용.
//
// 게임 30/s 불변식(AGENT_ACTIONS_PER_SEC_CAP)과 server/auth/* 는 건드리지 않는다.

const { test, before, after } = require('node:test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgentWithKey,
  expectAgentKeyRejected,
  waitForEvent,
  emitWithAck,
  emitRawAck,
  getFreePort,
  waitForServer,
} = require('./helpers/agent-harness');
const { createStore } = require('../server/auth/store');

// 경계 분리를 위해 KEY_CAP < IP_CAP. 메인io throttle 은 최소값 강제가 없어 낮게 둘 수 있다.
const IP_CAP = 4;
const KEY_CAP = 2;
const LOBBY_CAP = 30; // BYO_LOBBY_MSG_PER_SEC_CAP 최소 30 강제 → 30 으로 검증.
const MAIN_CREATE_CAP = 2; // BYO_MAIN_IO_CREATE_PER_SEC.

let url = null;
let tmpDir = null;
let storePath = null;
let child = null;
const keys = []; // distinct apiKey 평문 목록

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 서버 측 release 가 반영될 시간을 준다(다음 테스트 카운터 청소).
const settle = () => delay(300);

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-conn-abuse-rt-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'conn-abuse-rt' });
  // distinct 키 넉넉히(IP 경계는 키캡과 무관해야 하므로 각기 다른 키 사용).
  for (let i = 0; i < 12; i++) {
    const issued = await store.issueKey(account.id, `rt-key-${i}`);
    keys.push(issued.key);
  }

  const port = await getFreePort();
  url = `http://localhost:${port}`;
  child = spawn('node', ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      BYO_KEY_STORE_PATH: storePath,
      BYO_MAX_CONNS_PER_IP: String(IP_CAP),
      BYO_MAX_CONNS_PER_KEY: String(KEY_CAP),
      BYO_GLOBAL_MAX_AGENT_CONNS: '50',
      BYO_LOBBY_MSG_PER_SEC_CAP: String(LOBBY_CAP),
      BYO_MAIN_IO_CREATE_PER_SEC: String(MAIN_CREATE_CAP),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(url);
});

after(async () => {
  closeAll();
  stopServer();
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
  }
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// RT1: 거부 폭주가 슬롯을 잠식하지 않고, 한 연결 close 로 슬롯이 정확히 1 회복된다.
test('RT1: a flood of rejections leaks no slots; closing one connection restores exactly one slot', async () => {
  const agents = [];
  // distinct 키로 IP 상한까지 채운다(키캡 미발동 — 키마다 count=1, IP count 만 증가).
  for (let i = 0; i < IP_CAP; i++) {
    const { agent } = await connectAgentWithKey(url, keys[i], `rt1-fill-${i}`);
    assert(agent.connected, `RT1: fill connection ${i} should succeed`);
    agents.push(agent);
  }
  // 거부 폭주: 같은 distinct 키(미획득)로 N회 거부. 거부는 슬롯을 acquire 하지 않으므로 누수 0 이어야.
  const N = 12;
  for (let i = 0; i < N; i++) {
    const reason = await expectAgentKeyRejected(url, keys[IP_CAP], `rt1-flood-${i}`);
    assert(
      reason === 'too many connections from ip',
      `RT1: flood reject ${i} must cite IP cap, got "${reason}"`
    );
  }
  // 폭주가 슬롯을 잠식했다면 아래 재연결이 실패하거나, 여러 슬롯이 새서 과다 수락된다.
  agents[0].close();
  await settle();
  const { agent: revived } = await connectAgentWithKey(url, keys[IP_CAP], 'rt1-revived');
  assert(revived.connected, 'RT1: a single freed slot must admit exactly one new connection');
  // 정확히 1 슬롯만 회복: 다시 가득 → 추가 연결은 거부되어야(과다 회복 아님).
  const reason = await expectAgentKeyRejected(url, keys[IP_CAP + 1], 'rt1-still-full');
  assert(
    reason === 'too many connections from ip',
    `RT1: capacity must be exactly at cap after revival, got "${reason}"`
  );

  revived.close();
  for (let i = 1; i < agents.length; i++) agents[i].close();
  await settle();
});

// RT2: 다른 키 같은 IP → IP 상한, 같은 키 다른 연결 → 키 상한. 두 경계가 서로 섞이지 않는다.
test('RT2: mixed key/IP boundary — distinct keys hit the IP cap, same key hits the key cap', async () => {
  // (a) 다른 키 같은 IP: IP 상한까지 distinct 키로 채우고 한 개 더 → IP 상한 거부.
  const agents = [];
  for (let i = 0; i < IP_CAP; i++) {
    const { agent } = await connectAgentWithKey(url, keys[i], `rt2-ip-${i}`);
    agents.push(agent);
  }
  const ipReason = await expectAgentKeyRejected(url, keys[IP_CAP], 'rt2-ip-overflow');
  assert(
    ipReason === 'too many connections from ip',
    `RT2(a): distinct-key overflow must be IP-bound, got "${ipReason}"`
  );
  for (const a of agents) a.close();
  await settle();

  // (b) 같은 키 다른 연결: KEY_CAP(<IP_CAP) 까지 같은 키 → 한 개 더 → 키 상한 거부.
  const key = keys[0];
  const sameKey = [];
  for (let i = 0; i < KEY_CAP; i++) {
    const { agent } = await connectAgentWithKey(url, key, `rt2-key-${i}`);
    assert(agent.connected, `RT2(b): same-key connection ${i} within cap should succeed`);
    sameKey.push(agent);
  }
  // 이 시점 IP count=KEY_CAP(2) < IP_CAP(4) 이므로 IP 가 아닌 키 상한이 먼저 걸려야 한다.
  const keyReason = await expectAgentKeyRejected(url, key, 'rt2-key-overflow');
  assert(
    keyReason === 'too many connections for key',
    `RT2(b): same-key overflow must be key-bound (not IP), got "${keyReason}"`
  );
  for (const a of sameKey) a.close();
  await settle();
});

// RT3: 로비 throttle 정확히 cap 경계 + 1초 후 윈도우 회복.
test('RT3: lobby throttle admits exactly cap, rejects cap+1, recovers after the 1s window', async () => {
  const { agent } = await connectAgentWithKey(url, keys[0], 'rt3-lobby');
  // 입장 이벤트로 윈도우가 오염되지 않게 비운다.
  await delay(1100);

  const SENT = LOBBY_CAP + 5;
  const acks = await Promise.all(
    Array.from({ length: SENT }, () => emitRawAck(agent, 'createRoom', { name: 'rt3-spam' }))
  );
  const rateLimited = acks.filter((a) => a && a.error === 'rate limited').length;
  const passed = acks.filter((a) => !(a && a.error === 'rate limited')).length;
  assert(
    passed === LOBBY_CAP,
    `RT3: exactly ${LOBBY_CAP} lobby events must pass, got ${passed}`
  );
  assert(
    rateLimited === SENT - LOBBY_CAP,
    `RT3: exactly ${SENT - LOBBY_CAP} lobby events must be rate limited, got ${rateLimited}`
  );

  // 1초 후 윈도우 회복 → 다음 로비 이벤트는 throttle 에 걸리지 않아야 한다.
  await delay(1100);
  const after = await emitRawAck(agent, 'createRoom', { name: 'rt3-after' });
  assert(
    !(after && after.error === 'rate limited'),
    `RT3: lobby throttle must recover after 1s, got ${JSON.stringify(after)}`
  );

  agent.close();
  await settle();
});

// RT4: 로비 throttle 포화 중에도 게임중 agentAction 은 비거부(분리), 게임 액션 30/s 가드는 정확히 동작.
test('RT4: saturated lobby throttle does not block in-game agentAction; the 30/s game cap still bites', async () => {
  const host = await connectHuman(url);
  host.emit('setNick', 'RT4Host');
  host.emit('createRoom', 'rt4 room');
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'RT4 room creation');

  const { agent } = await connectAgentWithKey(url, keys[0], 'rt4-agent');
  const joined = await emitWithAck(agent, 'joinRoom', room.id);
  assert(joined && joined.room && joined.room.id === room.id, 'RT4: agent should join host room');

  host.emit('startGame');
  await waitForEvent(host, 'gameStart', (g) => g && Array.isArray(g.players), 'RT4 game start');
  await delay(1100); // 로비 윈도우를 입장 이벤트로부터 비운다.

  // 로비 윈도우를 완전히 포화시킨다.
  const acks = await Promise.all(
    Array.from({ length: LOBBY_CAP + 5 }, () => emitRawAck(agent, 'createRoom', { name: 'rt4-spam' }))
  );
  const rateLimited = acks.filter((a) => a && a.error === 'rate limited').length;
  assert(rateLimited > 0, 'RT4: lobby throttle must actually be saturated for this test to mean anything');

  // 분리 증명: 같은 1초 안에서도 게임중 agentAction 은 로비 throttle 슬롯을 공유하지 않아 수락된다.
  const actionAck = await emitRawAck(agent, 'agentAction', { type: 'move', seq: 1, keys: { left: true } });
  assert(
    actionAck && actionAck.ok === true,
    `RT4: in-game agentAction must bypass the saturated lobby throttle, got ${JSON.stringify(actionAck)}`
  );

  // 게임 30/s 자체 가드: 깨끗한 윈도우에서 cap+1(31) 을 보내면 정확히 1 건이 거부된다.
  await delay(1100);
  const moves = [];
  for (let i = 0; i < 31; i++) {
    moves.push(emitRawAck(agent, 'agentAction', { type: 'move', seq: i + 2, keys: { right: true } }));
  }
  const moveAcks = await Promise.all(moves);
  const moveLimited = moveAcks.filter((a) => a && a.error === 'rate limited').length;
  const moveOk = moveAcks.filter((a) => a && a.ok === true).length;
  assert(
    moveOk === 30,
    `RT4: game cap must admit exactly 30 actions/sec, got ${moveOk} ok`
  );
  assert(
    moveLimited === 1,
    `RT4: the 31st action/sec must be rate limited by the game cap, got ${moveLimited} limited`
  );

  agent.close();
  host.close();
  await settle();
});

// RT5: 멱등 — 중복 disconnect 가 카운터를 음수로 만들거나 슬롯을 과다 회복하지 않고,
//       반복 acquire/release 사이클에도 누수/오차가 0(매 사이클 정확히 cap 수용, cap+1 거부).
test('RT5: idempotent release — duplicate disconnect and repeated acquire/release never drift the counter', async () => {
  // (a) 중복 disconnect: 한 소켓을 두 번 close() 해도 슬롯은 정확히 1 만 회복된다.
  const agents = [];
  for (let i = 0; i < IP_CAP; i++) {
    const { agent } = await connectAgentWithKey(url, keys[i], `rt5-fill-${i}`);
    agents.push(agent);
  }
  // 가득 → 거부 확인.
  let reason = await expectAgentKeyRejected(url, keys[IP_CAP], 'rt5-full');
  assert(reason === 'too many connections from ip', `RT5(a): must be full, got "${reason}"`);

  // 같은 소켓 중복 close (멱등 release 공격).
  agents[0].close();
  agents[0].close();
  await settle();

  // 정확히 1 슬롯 회복: 첫 재연결 성공.
  const { agent: revived } = await connectAgentWithKey(url, keys[IP_CAP], 'rt5-revived');
  assert(revived.connected, 'RT5(a): exactly one slot must be freed by duplicate disconnect');
  // 음수/과다 회복이 아님: 다시 가득 → 추가 연결 거부.
  reason = await expectAgentKeyRejected(url, keys[IP_CAP + 1], 'rt5-still-full');
  assert(
    reason === 'too many connections from ip',
    `RT5(a): duplicate disconnect must not over-release (counter not negative), got "${reason}"`
  );
  revived.close();
  for (let i = 1; i < agents.length; i++) agents[i].close();
  await settle();

  // (b) 반복 acquire/release 사이클 — 5 회 반복 모두 정확히 cap 수용 + cap+1 거부(누수/오차 0).
  for (let cycle = 0; cycle < 5; cycle++) {
    const cycleAgents = [];
    for (let i = 0; i < IP_CAP; i++) {
      const { agent } = await connectAgentWithKey(url, keys[i], `rt5-cycle${cycle}-${i}`);
      assert(agent.connected, `RT5(b): cycle ${cycle} fill ${i} must succeed (no leak from prior cycle)`);
      cycleAgents.push(agent);
    }
    const r = await expectAgentKeyRejected(url, keys[IP_CAP], `rt5-cycle${cycle}-overflow`);
    assert(
      r === 'too many connections from ip',
      `RT5(b): cycle ${cycle} cap+1 must be rejected (no negative drift), got "${r}"`
    );
    for (const a of cycleAgents) a.close();
    await settle();
  }
});

// RT6: 메인 io create/start throttle 초과 거부 → 1초 뒤 회복, 게임입력엔 미적용.
test('RT6: main-io create/start throttle rejects bursts, recovers after 1s, and never throttles game input', async () => {
  // --- (a) createRoom throttle 경계: cap 통과(errorMsg 없음), 초과분만 errorMsg 거부.
  const human = await connectHuman(url);
  const createErrors = [];
  human.on('errorMsg', (m) => createErrors.push(m));
  human.emit('setNick', 'RT6Create');

  const CREATE_SENT = MAIN_CREATE_CAP + 4;
  for (let i = 0; i < CREATE_SENT; i++) human.emit('createRoom', `rt6-create-${i}`);
  await delay(400);
  assert(
    createErrors.length === CREATE_SENT - MAIN_CREATE_CAP,
    `RT6(a): create throttle must reject exactly ${CREATE_SENT - MAIN_CREATE_CAP} over cap, got ${createErrors.length}`
  );

  // 1초 뒤 회복: 추가 createRoom 은 throttle errorMsg 를 더 내지 않는다(이미 방 보유 → 조용히 반환).
  await delay(1100);
  const before = createErrors.length;
  human.emit('createRoom', 'rt6-create-after');
  await delay(300);
  assert(
    createErrors.length === before,
    `RT6(a): create throttle must recover after 1s (no new errorMsg), got ${createErrors.length - before} new`
  );

  // --- (b) 게임입력 미적용: 게임 입력 이벤트(cmd/placeBomb)를 폭주시켜도 throttle errorMsg 가 없다.
  const gameErrBefore = createErrors.length;
  for (let i = 0; i < 60; i++) {
    human.emit('cmd', { type: 'move', dir: i % 2 ? 'left' : 'right' });
    human.emit('placeBomb');
  }
  await delay(400);
  assert(
    createErrors.length === gameErrBefore,
    `RT6(b): game input must NOT be throttled (no errorMsg), got ${createErrors.length - gameErrBefore} new`
  );
  human.close();
  await settle();

  // --- (c) startGame throttle 은 createRoom 과 독립 윈도우: 초과 거부 후 1초 뒤 회복.
  const starter = await connectHuman(url);
  const startErrors = [];
  starter.on('errorMsg', (m) => startErrors.push(m));
  // 방 없이 startGame 을 폭주 → throttle 이 먼저 평가되어 초과분만 errorMsg.
  const START_SENT = MAIN_CREATE_CAP + 3;
  for (let i = 0; i < START_SENT; i++) starter.emit('startGame');
  await delay(400);
  assert(
    startErrors.length === START_SENT - MAIN_CREATE_CAP,
    `RT6(c): start throttle must reject exactly ${START_SENT - MAIN_CREATE_CAP} over cap, got ${startErrors.length}`
  );
  // 1초 뒤 회복.
  await delay(1100);
  const startBefore = startErrors.length;
  starter.emit('startGame');
  await delay(300);
  assert(
    startErrors.length === startBefore,
    `RT6(c): start throttle must recover after 1s (no new errorMsg), got ${startErrors.length - startBefore} new`
  );
  starter.close();
  await settle();
});
