'use strict';

// G006(S6): 연결남용/DoS 가드 + 로비 메시지 throttle 검증.
// 흐름: 임시 BYO_KEY_STORE_PATH store 에 distinct 키 여러 개를 직접 발급하고,
//       낮은 연결 상한(env)으로 서버를 spawn 해서 경계/누수를 확인한다.
//  AC9 : IP 동시연결 상한 경계 — 상한까지 통과, 상한 초과 거부('too many connections from ip').
//  AC10: 로비 메시지 throttle 경계 + '게임중 agentAction 은 로비 throttle 비대상(30/s 게임캡만)'.
//  AC11: 키별 동시연결 상한 경계('too many connections for key').
//  누수: acquire 후 거부 경로에서도 카운터 누수 0 — 거부가 슬롯을 잠식하지 않고,
//        disconnect release 로 슬롯이 정확히 복구되어 재연결이 성공한다.
//
// server/auth/* 와 server/index.js 의 게임 30/s 불변식(AGENT_ACTIONS_PER_SEC_CAP)은 건드리지 않는다.

const { test, before, after } = require('node:test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

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
} = require('./helpers/agent-harness');
const { getFreePort, waitForServer } = require('./helpers/agent-harness');
const { createStore } = require('../server/auth/store');

// 경계 검증용 낮은 상한.
const IP_CAP = 3;
const KEY_CAP = 2;
const LOBBY_CAP = 30; // BYO_LOBBY_MSG_PER_SEC_CAP 최소값(30 미만 금지)이라 30 으로 검증.

let url = null;
let tmpDir = null;
let storePath = null;
let child = null;
const keys = []; // distinct apiKey 평문 목록

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 연결한 소켓이 서버 측에서 release 될 시간을 준다(다음 테스트의 카운터를 깨끗하게).
const settle = () => delay(250);

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-conn-abuse-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'conn-abuse' });
  // distinct 키 8개(IP 경계는 키캡과 무관해야 하므로 각기 다른 키 사용).
  for (let i = 0; i < 8; i++) {
    const issued = await store.issueKey(account.id, `key-${i}`);
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

// AC9: IP 동시연결 상한 경계.
test('AC9: per-IP connection cap admits up to the cap and rejects beyond it', async () => {
  const agents = [];
  // distinct 키로 IP_CAP 개 연결 → 모두 성공(키캡은 키마다 1 이라 미발동, IP 카운트만 증가).
  for (let i = 0; i < IP_CAP; i++) {
    const { agent } = await connectAgentWithKey(url, keys[i], `ac9-ok-${i}`);
    assert(agent.connected, `AC9: connection ${i} (within cap) should succeed`);
    agents.push(agent);
  }
  // 상한 초과(IP_CAP+1 번째) → distinct 키여도 IP 상한에 걸려 거부.
  const reason = await expectAgentKeyRejected(url, keys[IP_CAP], 'ac9-overflow');
  assert(
    reason === 'too many connections from ip',
    `AC9: overflow must be rejected for IP, got "${reason}"`
  );

  for (const a of agents) a.close();
  await settle();
});

// AC11: 키별 동시연결 상한 경계.
test('AC11: per-key connection cap admits up to the cap and rejects beyond it', async () => {
  const key = keys[0];
  const agents = [];
  for (let i = 0; i < KEY_CAP; i++) {
    const { agent } = await connectAgentWithKey(url, key, `ac11-ok-${i}`);
    assert(agent.connected, `AC11: same-key connection ${i} (within cap) should succeed`);
    agents.push(agent);
  }
  // KEY_CAP < IP_CAP 이므로 같은 키의 (KEY_CAP+1) 번째는 IP 가 아닌 키 상한에 먼저 걸린다.
  const reason = await expectAgentKeyRejected(url, key, 'ac11-overflow');
  assert(
    reason === 'too many connections for key',
    `AC11: same-key overflow must be rejected for key, got "${reason}"`
  );

  for (const a of agents) a.close();
  await settle();
});

// AC10: 로비 throttle 경계 + agentAction 로비 throttle 비대상.
test('AC10: lobby events are throttled while in-game agentAction bypasses the lobby throttle', async () => {
  // 사람 호스트 방 + apiKey 에이전트 입장 → startGame(2인 FFA).
  const host = await connectHuman(url);
  host.emit('setNick', 'AbuseHost');
  host.emit('createRoom', 'conn-abuse room');
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'AC10 room creation');

  const { agent } = await connectAgentWithKey(url, keys[0], 'ac10-agent');
  const joined = await emitWithAck(agent, 'joinRoom', room.id);
  assert(joined && joined.room && joined.room.id === room.id, 'AC10: agent should join the host room');

  host.emit('startGame');
  await waitForEvent(host, 'gameStart', (g) => g && Array.isArray(g.players), 'AC10 game start');
  // 로비 윈도우가 입장 이벤트로 오염되지 않도록 1초 이상 비운다.
  await delay(1100);

  // --- (a) 로비 throttle 경계: createRoom 을 cap 초과로 버스트 → 정확히 (sent-cap) 개가 'rate limited'.
  const SENT = LOBBY_CAP + 6;
  const acks = await Promise.all(
    Array.from({ length: SENT }, () => emitRawAck(agent, 'createRoom', { name: 'spam' }))
  );
  const rateLimited = acks.filter((a) => a && a.error === 'rate limited').length;
  const notRateLimited = acks.filter((a) => !(a && a.error === 'rate limited')).length;
  assert(
    notRateLimited === LOBBY_CAP,
    `AC10(a): exactly ${LOBBY_CAP} lobby events should pass the throttle, got ${notRateLimited}`
  );
  assert(
    rateLimited === SENT - LOBBY_CAP,
    `AC10(a): exactly ${SENT - LOBBY_CAP} lobby events should be rate limited, got ${rateLimited}`
  );

  // --- (b) 비대상 증명: 로비 윈도우가 포화된 같은 1초 안에서 agentAction 은 그대로 수락된다.
  //     (게임 액션은 별도 30/s 게임캡만 적용 — 로비 throttle 슬롯을 소비/공유하지 않는다.)
  const actionAck = await emitRawAck(agent, 'agentAction', { type: 'move', seq: 1, keys: { left: true } });
  assert(
    actionAck && actionAck.ok === true,
    `AC10(b): in-game agentAction must bypass the saturated lobby throttle, got ${JSON.stringify(actionAck)}`
  );

  // --- (c) 게임 30/s 캡 불변식: 깨끗한 윈도우에서 연속 agentAction 이 캡(30)까지 수락된다.
  await delay(1100); // 게임 레이트 윈도우(1초)와 로비 윈도우 모두 비운다.
  const moves = [];
  for (let i = 0; i < 30; i++) {
    moves.push(emitRawAck(agent, 'agentAction', { type: 'move', seq: i + 2, keys: { right: true } }));
  }
  const moveAcks = await Promise.all(moves);
  const moveRateLimited = moveAcks.filter((a) => a && a.error === 'rate limited').length;
  assert(
    moveRateLimited === 0,
    `AC10(c): 30 agentActions/sec must not be rate limited (game cap is 30/s), got ${moveRateLimited} limited`
  );

  agent.close();
  host.close();
  await settle();
});

// 누수: 거부 경로가 슬롯을 잠식하지 않고, disconnect release 로 슬롯이 정확히 복구된다.
test('no-leak: rejected connections do not consume slots and disconnect restores capacity', async () => {
  const agents = [];
  for (let i = 0; i < IP_CAP; i++) {
    const { agent } = await connectAgentWithKey(url, keys[i], `leak-ok-${i}`);
    agents.push(agent);
  }
  // 두 번 연속 거부 — 거부가 슬롯을 잠식했다면 두 번째 거부의 사유/동작이 달라지거나
  // 이후 복구가 안 된다. 여기서는 거부가 멱등(카운터 불변)임을 사유 동일성으로 확인.
  const r1 = await expectAgentKeyRejected(url, keys[IP_CAP], 'leak-overflow-1');
  const r2 = await expectAgentKeyRejected(url, keys[IP_CAP + 1], 'leak-overflow-2');
  assert(r1 === 'too many connections from ip', `no-leak: first overflow reason "${r1}"`);
  assert(r2 === 'too many connections from ip', `no-leak: second overflow reason "${r2}"`);

  // 연결 하나를 닫아 release 유발 → 슬롯 1 복구 → 새 연결 성공해야 한다.
  agents[0].close();
  await settle();
  const { agent: revived } = await connectAgentWithKey(url, keys[IP_CAP], 'leak-revived');
  assert(revived.connected, 'no-leak: a freed slot must admit a new connection (counter fully restored)');

  revived.close();
  for (let i = 1; i < agents.length; i++) agents[i].close();
  await settle();
});
