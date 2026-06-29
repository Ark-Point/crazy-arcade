'use strict';

// G005(S5) 적대 테스트 — /agent 로비 핸들러·방 수명·혼합방을 깨려는 입력으로
// 거부 경로/방 수명/공존 경합의 견고성을 확인한다(크래시·슬롯손상 없음).
// 제품 코드는 수정하지 않고, 기존 공유 로비함수(server/lobby.js)와 apiKey 로비
// 핸들러(server/index.js)를 임시 BYO store + spawn 서버 위에서 적대적으로 두드린다.
//  RT1: createRoom/joinRoom 오용 — 미존재 roomId/비문자열/객체/null/playing 방 → 적절 거부, 무크래시.
//  RT2: 가득 찬(8명) 전원-에이전트 방의 apiKey 입장 → 'room is full'.
//  RT3: 이미 입장한 에이전트의 중복 createRoom/joinRoom → 'already in a room'; leave 후 재입장 성공.
//  RT4: 전원-에이전트 방 수명 — 마지막 에이전트 leave 즉시 정리; 사람 입장 시 TTL 타이머 해제 후 미삭제.
//  RT5: 혼합방 — 사람 이탈 후 에이전트만 남으면 방 유지(즉시삭제 아님), 전원 나가면 정리.
//  RT6: token 초대 + apiKey 로비가 같은 방에서 동시 공존(슬롯 경합) — 셋 다 일관 유지.

const { test, before, after } = require('node:test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  connectAgentWithKey,
  createRoomWithAgentInvite,
  waitForEvent,
  waitForServer,
  getFreePort,
  emitWithAck,
  emitRawAck,
  agentPlayers,
} = require('./helpers/agent-harness');
const { createStore } = require('../server/auth/store');

const MAX_PLAYERS = 8;
const TTL_MS = 500;

let url = null;
let tmpDir = null;
let storePath = null;
let validKey = null;

const extraChildren = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 명시적 BYO_EMPTY_ROOM_TTL_MS 로 별도 서버를 spawn(메인과 격리). TTL 타이머 검증용.
async function spawnServerWithTtl(ttlMs) {
  const port = await getFreePort();
  const targetUrl = `http://localhost:${port}`;
  const child = spawn('node', ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      BYO_KEY_STORE_PATH: storePath,
      BYO_EMPTY_ROOM_TTL_MS: String(ttlMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  extraChildren.push(child);
  await waitForServer(targetUrl);
  return targetUrl;
}

// apiKey 소켓은 lobby 브로드캐스트 미수신 → 명시적으로 rooms 를 조회한다.
function requestRooms(agent, ms = 3000) {
  const pending = waitForEvent(agent, 'rooms', () => true, 'rooms list', ms);
  agent.emit('rooms');
  return pending;
}

// 휴먼이 기존 방에 입장한다(joinedRoom 수신까지 대기).
async function humanJoin(host, roomId) {
  host.emit('joinRoom', roomId);
  return waitForEvent(host, 'joinedRoom', (r) => r && r.id === roomId, 'human join room', 5000);
}

// apiKey 에이전트의 leaveRoom 은 ack 콜백을 유일 인자로 받는다(payload 없음).
function agentLeave(socket, ms = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('leaveRoom ack timed out')), ms);
    socket.emit('leaveRoom', (resp) => { clearTimeout(timer); resolve(resp); });
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-redteam-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'redteam' });
  const issued = await store.issueKey(account.id, 'valid key');
  validKey = issued.key;

  // 메인 서버는 TTL 을 크게 두어 즉시정리/혼합방 테스트가 TTL 에 흔들리지 않게 한다.
  process.env.BYO_KEY_STORE_PATH = storePath;
  process.env.BYO_EMPTY_ROOM_TTL_MS = '30000';
  // S6 연결 가드: RT2 는 한 키·한 IP 로 9 에이전트를 붙인다. 프로덕션 기본값(IP=4/KEY=2)은
  // 유지하고, 이 적대 시나리오를 위해 spawn 서버에만 상한을 넉넉히 올린다.
  process.env.BYO_MAX_CONNS_PER_IP = '64';
  process.env.BYO_MAX_CONNS_PER_KEY = '64';
  process.env.BYO_GLOBAL_MAX_AGENT_CONNS = '256';
  url = (await startServer()).url;
});

after(async () => {
  closeAll();
  stopServer();
  for (const child of extraChildren) {
    try { child.kill(); } catch { /* 무시 */ }
  }
  delete process.env.BYO_KEY_STORE_PATH;
  delete process.env.BYO_EMPTY_ROOM_TTL_MS;
  delete process.env.BYO_MAX_CONNS_PER_IP;
  delete process.env.BYO_MAX_CONNS_PER_KEY;
  delete process.env.BYO_GLOBAL_MAX_AGENT_CONNS;
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
});

// RT1: 기형/오용 joinRoom 입력은 모두 명확히 거부되고 소켓·서버는 생존한다.
test('RT1: malformed/abusive createRoom & joinRoom inputs are rejected without crashing', async () => {
  const { agent } = await connectAgentWithKey(url, validKey, 'rt1-agent');

  // (a) 미존재 문자열 roomId → 'room not found'.
  const missing = await emitRawAck(agent, 'joinRoom', 'does-not-exist');
  assert(missing && missing.ok === false, `missing room join should fail: ${JSON.stringify(missing)}`);
  assert(missing.error === 'room not found', `expected "room not found", got "${missing.error}"`);

  // (b) 비문자열(숫자) payload → roomId 미정의 → 'room not found'.
  const numeric = await emitRawAck(agent, 'joinRoom', 12345);
  assert(numeric && numeric.ok === false && numeric.error === 'room not found',
    `numeric join should be rejected: ${JSON.stringify(numeric)}`);

  // (c) roomId 없는 객체 payload → 'room not found'.
  const objNoId = await emitRawAck(agent, 'joinRoom', { foo: 'bar', name: 'x' });
  assert(objNoId && objNoId.ok === false && objNoId.error === 'room not found',
    `object-without-roomId join should be rejected: ${JSON.stringify(objNoId)}`);

  // (d) null payload → 'room not found'.
  const nullPayload = await emitRawAck(agent, 'joinRoom', null);
  assert(nullPayload && nullPayload.ok === false && nullPayload.error === 'room not found',
    `null join should be rejected: ${JSON.stringify(nullPayload)}`);

  // (e) 객체 roomId(중첩 객체) → 미존재로 거부.
  const objId = await emitRawAck(agent, 'joinRoom', { roomId: { nested: true } });
  assert(objId && objId.ok === false && objId.error === 'room not found',
    `object roomId join should be rejected: ${JSON.stringify(objId)}`);

  // (f) 이미 playing 중인 방에 입장 시도 → 'game already in progress'.
  const host = await connectHuman(url);
  host.emit('setNick', 'RT1Host');
  host.emit('createRoom', 'rt1 playing room');
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'rt1 host room');
  const { agent: filler } = await connectAgentWithKey(url, validKey, 'rt1-filler');
  await emitWithAck(filler, 'joinRoom', room.id); // 2명 → 시작 후 즉시 종료 방지.
  host.emit('startGame');
  await delay(150);
  const playingAck = await emitRawAck(agent, 'joinRoom', room.id);
  assert(playingAck && playingAck.ok === false, `playing join should fail: ${JSON.stringify(playingAck)}`);
  assert(playingAck.error === 'game already in progress',
    `expected "game already in progress", got "${playingAck.error}"`);

  // 모든 거부 후에도 소켓 생존 + 서버가 정상 응답(rooms 조회 성공).
  assert(agent.connected, 'agent socket should survive every rejection');
  const list = await requestRooms(agent);
  assert(Array.isArray(list), 'server should still answer rooms query after abuse');

  agent.close();
  filler.close();
  host.close();
});

// RT2: 전원-에이전트 방을 8명으로 채운 뒤 9번째 apiKey 입장 → 'room is full'.
test('RT2: a full all-agent room rejects the 9th apiKey join with "room is full"', async () => {
  const { agent: creator } = await connectAgentWithKey(url, validKey, 'rt2-creator');
  const created = await emitWithAck(creator, 'createRoom', { name: 'rt2 full room' });
  const roomId = created.room.id;

  const joiners = [];
  for (let i = 0; i < MAX_PLAYERS - 1; i++) {
    const { agent } = await connectAgentWithKey(url, validKey, `rt2-fill-${i}`);
    const ack = await emitWithAck(agent, 'joinRoom', roomId);
    assert(ack.ok === true, `fill agent ${i} should join`);
    joiners.push(agent);
  }

  const { agent: overflow } = await connectAgentWithKey(url, validKey, 'rt2-overflow');
  const ack = await emitRawAck(overflow, 'joinRoom', roomId);
  assert(ack && ack.ok === false, `overflow join should be rejected: ${JSON.stringify(ack)}`);
  assert(ack.error === 'room is full', `expected "room is full", got "${ack.error}"`);
  assert(overflow.connected, 'overflow agent socket should survive the rejection');

  // 방은 여전히 정확히 8명(오버플로로 9명 되지 않음).
  const list = await requestRooms(overflow);
  const entry = list.find((r) => r.id === roomId);
  assert(entry && entry.count === MAX_PLAYERS, `room should stay at ${MAX_PLAYERS}, got ${entry && entry.count}`);

  overflow.close();
  for (const a of joiners) a.close();
  creator.close();
});

// RT3: 이미 입장한 에이전트의 중복 입장은 거부되고, leave 후 재입장은 성공한다.
test('RT3: double-join is rejected; leave then re-join succeeds', async () => {
  // A 가 방을 만들고 B 가 입장(2명) — A 가 떠나도 방이 유지되도록 B 를 둔다.
  const { agent: a } = await connectAgentWithKey(url, validKey, 'rt3-a');
  const created = await emitWithAck(a, 'createRoom', { name: 'rt3 room' });
  const roomId = created.room.id;
  const { agent: b } = await connectAgentWithKey(url, validKey, 'rt3-b');
  await emitWithAck(b, 'joinRoom', roomId);

  // A 가 또 createRoom → 'already in a room'.
  const dupCreate = await emitRawAck(a, 'createRoom', { name: 'second' });
  assert(dupCreate && dupCreate.ok === false && dupCreate.error === 'already in a room',
    `duplicate createRoom should be rejected: ${JSON.stringify(dupCreate)}`);

  // A 가 다른(혹은 같은) 방에 joinRoom → 'already in a room'.
  const dupJoin = await emitRawAck(a, 'joinRoom', roomId);
  assert(dupJoin && dupJoin.ok === false && dupJoin.error === 'already in a room',
    `duplicate joinRoom should be rejected: ${JSON.stringify(dupJoin)}`);

  // 방은 여전히 2명(중복 시도로 증식하지 않음).
  let list = await requestRooms(b);
  let entry = list.find((r) => r.id === roomId);
  assert(entry && entry.count === 2, `room should still hold 2 after dup attempts, got ${entry && entry.count}`);

  // A 가 leave → ok. 그 후 같은 방에 재입장 가능.
  const leaveAck = await agentLeave(a);
  assert(leaveAck && leaveAck.ok === true, `leave should ack ok: ${JSON.stringify(leaveAck)}`);
  await delay(150);
  list = await requestRooms(b);
  entry = list.find((r) => r.id === roomId);
  assert(entry && entry.count === 1, `room should drop to 1 after A leaves, got ${entry && entry.count}`);

  const rejoin = await emitWithAck(a, 'joinRoom', roomId);
  assert(rejoin.ok === true && rejoin.room && rejoin.room.id === roomId, 'A should re-join the room');
  assert(agentPlayers(rejoin.room).length === 2, 'room should hold two agents after re-join');

  a.close();
  b.close();
});

// RT4: 전원-에이전트 방 수명 — 마지막 leave 즉시 정리; 사람 입장 시 TTL 타이머 해제(미삭제).
test('RT4: all-agent room reclaimed on last leave; human join cancels the TTL timer', async () => {
  // (a) 즉시정리: 단독 에이전트가 명시적 leave → 방 즉시 사라짐.
  const { agent: solo } = await connectAgentWithKey(url, validKey, 'rt4-solo');
  const created = await emitWithAck(solo, 'createRoom', { name: 'rt4 ephemeral' });
  const soloRoomId = created.room.id;
  const { agent: probe } = await connectAgentWithKey(url, validKey, 'rt4-probe');
  let before = await requestRooms(probe);
  assert(before.some((r) => r.id === soloRoomId), 'ephemeral room should exist while agent is in it');
  await agentLeave(solo);
  await delay(250);
  let afterList = await requestRooms(probe);
  assert(!afterList.some((r) => r.id === soloRoomId), 'room should be reclaimed immediately after last agent leaves');
  solo.close();
  probe.close();

  // (b) 사람 입장 시 TTL 해제: 짧은 TTL 서버에서 전원-에이전트 방에 사람이 들어오면
  //     TTL 경과 후에도 방이 살아 있어야 한다(타이머가 해제됐다는 증거).
  const ttlUrl = await spawnServerWithTtl(TTL_MS);
  const { agent: keyAgent } = await connectAgentWithKey(ttlUrl, validKey, 'rt4-ttl-agent');
  const ttlRoom = await emitWithAck(keyAgent, 'createRoom', { name: 'rt4 ttl room' });
  const ttlRoomId = ttlRoom.room.id;

  // 사람이 TTL 경과 전에 입장 → reviewRoomLifecycle 이 타이머를 해제한다.
  const human = await connectHuman(ttlUrl);
  human.emit('setNick', 'RT4Human');
  await humanJoin(human, ttlRoomId);

  // TTL 을 충분히 넘겨 기다려도 방이 살아 있어야 한다.
  await delay(TTL_MS + 600);
  const { agent: ttlProbe } = await connectAgentWithKey(ttlUrl, validKey, 'rt4-ttl-probe');
  const survived = await requestRooms(ttlProbe);
  const stillThere = survived.find((r) => r.id === ttlRoomId);
  assert(stillThere, 'mixed room must survive past the TTL once a human is present');
  assert(stillThere.count === 2, `mixed room should hold human+agent, got ${stillThere && stillThere.count}`);

  ttlProbe.close();
  human.close();
  keyAgent.close();
});

// RT5: 혼합방 — 사람이 떠나도 에이전트가 남으면 방 유지(즉시삭제 아님); 전원 나가면 정리.
test('RT5: mixed room survives while an agent remains, then is reclaimed when all leave', async () => {
  const human = await connectHuman(url);
  human.emit('setNick', 'RT5Host');
  human.emit('createRoom', 'rt5 mixed room');
  const room = await waitForEvent(human, 'joinedRoom', (r) => r && r.id, 'rt5 mixed room');
  const roomId = room.id;

  const { agent } = await connectAgentWithKey(url, validKey, 'rt5-agent');
  const joined = await emitWithAck(agent, 'joinRoom', roomId);
  assert(joined.ok === true && agentPlayers(joined.room).length === 1, 'agent should join the human room');

  const { agent: probe } = await connectAgentWithKey(url, validKey, 'rt5-probe');
  let list = await requestRooms(probe);
  let entry = list.find((r) => r.id === roomId);
  assert(entry && entry.count === 2, `mixed room should hold 2, got ${entry && entry.count}`);

  // 사람이 떠난다 → 에이전트만 남음 → 즉시 삭제되면 안 된다(메인 TTL=30s 이므로 유지).
  human.emit('leaveRoom');
  await delay(400);
  list = await requestRooms(probe);
  entry = list.find((r) => r.id === roomId);
  assert(entry, 'room must persist while an agent remains (not deleted immediately when the human leaves)');
  assert(entry.count === 1, `room should drop to the lone agent, got ${entry && entry.count}`);

  // 이제 에이전트도 떠난다 → 전원 이탈 → 정리.
  await agentLeave(agent);
  await delay(250);
  list = await requestRooms(probe);
  assert(!list.some((r) => r.id === roomId), 'room should be reclaimed once every player leaves');

  probe.close();
  agent.close();
  human.close();
});

// RT6: 같은 방에서 token 초대 에이전트와 apiKey 로비 에이전트가 동시에 공존(슬롯 경합).
test('RT6: token-invite and apiKey agents coexist inside one contested room', async () => {
  // 사람 호스트 방 + 토큰 초대 발급(아직 토큰 에이전트는 미입장).
  let latestRoom = null;
  const host = await connectHuman(url, (r) => { latestRoom = r; });
  const { room, invite } = await createRoomWithAgentInvite(host, { roomName: 'rt6 contested' });
  const roomId = room.id;

  // 경합: apiKey 에이전트가 먼저 같은 방에 입장(혼합: 사람+apiKey).
  const { agent: keyAgent } = await connectAgentWithKey(url, validKey, 'rt6-key-agent');
  const keyJoin = await emitWithAck(keyAgent, 'joinRoom', roomId);
  assert(keyJoin.ok === true && keyJoin.room.id === roomId, 'apiKey agent should join the host room');

  // 방에 사람1 + 에이전트2(토큰·apiKey)가 모두 존재해야 한다(슬롯 손상 없음).
  // 토큰 에이전트 입장으로 발생하는 roomUpdate 를 놓치지 않도록 연결 전에 먼저 구독한다.
  const mixedPromise = waitForEvent(
    host,
    'roomUpdate',
    (r) => r && r.id === roomId && agentPlayers(r).length === 2,
    'room holds both token and apiKey agents',
    5000
  );

  // 그 다음 token 에이전트가 초대 토큰으로 연결 → 예약 슬롯 차지.
  const tokenAgent = await connectAgent(url, invite.token, 'rt6-token-agent');
  assert(tokenAgent.connected, 'token agent should connect via invite');

  const mixed = await mixedPromise;
  const humans = mixed.players.filter((p) => (p.controller || 'human') === 'human');
  assert(humans.length === 1, `contested room should keep exactly one human, got ${humans.length}`);
  assert(agentPlayers(mixed).length === 2, 'contested room should hold both agents');
  const ids = new Set(mixed.players.map((p) => p.id));
  assert(ids.has(invite.playerId), 'token agent reserved slot must be present');
  assert(ids.size === 3, `room should have 3 distinct players, got ${ids.size}`);
  assert(latestRoom && latestRoom.id === roomId, 'host should still track its contested room');

  // 로비 목록에서도 단일 방으로 count=3 이 일관되게 보인다.
  const list = await requestRooms(keyAgent);
  const entry = list.find((r) => r.id === roomId);
  assert(entry && entry.count === 3, `lobby listing should show 3 players, got ${entry && entry.count}`);

  tokenAgent.close();
  keyAgent.close();
  host.close();
});
