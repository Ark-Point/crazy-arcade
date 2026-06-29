'use strict';

// G005(S5): /agent apiKey 로비 매치메이킹 검증.
// 흐름: 임시 BYO_KEY_STORE_PATH store 에 유효키를 발급하고, 그 store 를 가리키는
//       서버를 spawn 해서 apiKey 로비 핸들러(rooms/createRoom/joinRoom/leaveRoom)와
//       공유 로비함수(server/lobby.js) 위에서 동작하는 매치메이킹을 확인한다.
//  AC5: token 초대 경로와 apiKey 로비가 공존(둘 다 동작).
//  AC6: apiKey 에이전트가 rooms 조회 + createRoom/joinRoom 으로 같은 방에 모인다.
//  AC7: 사람+AI 혼합 방이 startGame 으로 진행되고 에이전트가 state/observation 을 받는다.
//  AC8: 가득 찬 방은 apiKey 입장도 'room is full' 로 거부한다.
//  수명: 전원-에이전트 방은 연결 0 시 즉시 정리되고, 유휴 대기방은 TTL 경과 후 정리된다.

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
  statePlayer,
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

// 별도 서버 인스턴스를 명시적 BYO_EMPTY_ROOM_TTL_MS 로 spawn 한다(메인과 격리).
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

// apiKey 에이전트가 명시적으로 rooms 를 조회한다(apiKey 소켓은 lobby 브로드캐스트 미수신).
function requestRooms(agent, ms = 3000) {
  const pending = waitForEvent(agent, 'rooms', () => true, 'rooms list', ms);
  agent.emit('rooms');
  return pending;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-matchmaking-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'matchmaking' });
  const issued = await store.issueKey(account.id, 'valid key');
  validKey = issued.key;

  // 메인 서버는 TTL 을 크게 두어 AC5~8/즉시정리 테스트가 TTL 에 흔들리지 않게 한다.
  process.env.BYO_KEY_STORE_PATH = storePath;
  process.env.BYO_EMPTY_ROOM_TTL_MS = '30000';
  // S6 연결 가드: 이 테스트는 하나의 운영자 키로 한 IP 에서 다수(최대 8) 에이전트를 붙인다
  // (현실 배포에선 운영자 N명 = 키 N개). 보수적 프로덕션 기본값(IP=4/KEY=2)은 그대로 두고,
  // 이 매치메이킹 시나리오를 위해 spawn 서버에만 상한을 넉넉히 올린다.
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

// AC5: token 초대 경로와 apiKey 로비가 같은 서버에서 동시에 동작한다.
test('AC5: token-invite and apiKey-lobby agents coexist', async () => {
  // token 경로: 사람 호스트 방 + 초대 + 토큰 에이전트 입장.
  let tokenRoom = null;
  const host = await connectHuman(url, (room) => { tokenRoom = room; });
  const { invite } = await createRoomWithAgentInvite(host, { roomName: 'token room' });
  const roomWithTokenPromise = tokenRoom && agentPlayers(tokenRoom).length === 1
    ? Promise.resolve(tokenRoom)
    : waitForEvent(
      host,
      'roomUpdate',
      (r) => r && r.id === invite.roomId && agentPlayers(r).length === 1,
      'token agent joined host room',
      5000
    );
  const tokenAgent = await connectAgent(url, invite.token, 'coexist-token-agent');
  const roomWithToken = await roomWithTokenPromise;
  assert(tokenAgent.connected, 'token agent should be connected');
  assert(agentPlayers(roomWithToken)[0].id === invite.playerId, 'token agent player id mismatch');

  // apiKey 경로: 별도 로비 에이전트가 자기 방을 만든다.
  const { agent: keyAgent } = await connectAgentWithKey(url, validKey, 'coexist-key-agent');
  const created = await emitWithAck(keyAgent, 'createRoom', { name: 'apikey room' });
  assert(created && created.ok === true, `apiKey createRoom should succeed: ${JSON.stringify(created)}`);
  assert(created.room && created.room.id, 'apiKey createRoom should return a room');
  assert(agentPlayers(created.room).length === 1, 'apiKey room should contain its agent');

  // 두 방이 모두 로비 목록에 동시에 존재한다.
  const list = await requestRooms(keyAgent);
  const ids = new Set(list.map((r) => r.id));
  assert(ids.has(invite.roomId), 'token room should be listed');
  assert(ids.has(created.room.id), 'apiKey room should be listed');
  assert(tokenRoom && tokenRoom.id === invite.roomId, 'host should still see its token room');

  tokenAgent.close();
  keyAgent.close();
  host.close();
});

// AC6: apiKey 에이전트가 rooms 조회 후 createRoom/joinRoom 으로 같은 방에 모인다.
test('AC6: apiKey agents discover, create, and join a shared room', async () => {
  const { agent: a } = await connectAgentWithKey(url, validKey, 'ac6-agent-a');
  const { agent: b } = await connectAgentWithKey(url, validKey, 'ac6-agent-b');

  const created = await emitWithAck(a, 'createRoom', { name: 'ac6 room', nick: 'Alpha' });
  assert(created.ok === true && created.room && created.room.id, 'A should create a room');
  const roomId = created.room.id;
  assert(typeof created.playerId === 'string' && created.playerId.length > 0, 'A should get a playerId');

  // B 가 로비를 조회해 A 의 방을 발견한다.
  const list = await requestRooms(b);
  const entry = list.find((r) => r.id === roomId);
  assert(entry, 'B should discover A\'s room via rooms query');
  assert(entry.count === 1 && entry.max === MAX_PLAYERS && entry.playing === false, 'room list entry shape');

  // B 가 그 방에 입장 → 방에 에이전트 2명.
  const joined = await emitWithAck(b, 'joinRoom', roomId);
  assert(joined.ok === true && joined.room && joined.room.id === roomId, 'B should join A\'s room');
  assert(agentPlayers(joined.room).length === 2, 'shared room should hold two agents');
  assert(joined.playerId !== created.playerId, 'agents should have distinct player ids');

  a.close();
  b.close();
});

// AC7: 사람+AI 혼합 방이 startGame 으로 진행되고 에이전트가 state/observation 을 받는다.
test('AC7: a mixed human+agent room starts and streams state to the agent', async () => {
  let latestRoom = null;
  const host = await connectHuman(url, (room) => { latestRoom = room; });
  host.emit('setNick', 'MixHost');
  host.emit('createRoom', 'mixed room');
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'mixed room creation');

  const { agent } = await connectAgentWithKey(url, validKey, 'ac7-agent');
  const joined = await emitWithAck(agent, 'joinRoom', room.id);
  assert(joined.ok === true, 'agent should join the human room');

  const mixed = await waitForEvent(
    host,
    'roomUpdate',
    (r) => r && r.id === room.id && agentPlayers(r).length === 1,
    'mixed room update',
    5000
  );
  const humans = mixed.players.filter((p) => (p.controller || 'human') === 'human');
  assert(humans.length === 1, 'mixed room should keep one human');
  assert(agentPlayers(mixed).length === 1, 'mixed room should hold one agent');
  assert(latestRoom && latestRoom.id === room.id, 'host should track the mixed room');

  host.emit('startGame');
  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (o) => o && o.state && o.state.countdown === 0,
    'agent observation after start',
    8000
  );
  const self = statePlayer(obs.state, obs.playerId);
  assert(self, `agent self ${obs.playerId} should appear in the state`);
  assert(obs.roomId === room.id, 'observation roomId should match');

  agent.close();
  host.close();
});

// AC8: 가득 찬 방은 apiKey 입장도 기존 메시지로 거부한다.
test('AC8: a full room rejects an apiKey join with "room is full"', async () => {
  const host = await connectHuman(url);
  host.emit('setNick', 'FullHost');
  host.emit('createRoom', 'full room');
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'full room creation');

  // 사람 호스트(1명) + apiKey 에이전트 7명 = MAX_PLAYERS.
  const joiners = [];
  for (let i = 0; i < MAX_PLAYERS - 1; i++) {
    const { agent } = await connectAgentWithKey(url, validKey, `fill-agent-${i}`);
    const ack = await emitWithAck(agent, 'joinRoom', room.id);
    assert(ack.ok === true, `fill agent ${i} should join`);
    joiners.push(agent);
  }

  // 9번째 입장 시도 → 거부.
  const { agent: overflow } = await connectAgentWithKey(url, validKey, 'overflow-agent');
  const ack = await emitRawAck(overflow, 'joinRoom', room.id);
  assert(ack && ack.ok === false, `overflow join should be rejected: ${JSON.stringify(ack)}`);
  assert(ack.error === 'room is full', `expected "room is full", got "${ack.error}"`);
  assert(overflow.connected, 'overflow agent socket should survive the rejection');

  overflow.close();
  for (const a of joiners) a.close();
  host.close();
});

// 수명(즉시 정리): 전원-에이전트 대기방에서 마지막 연결이 끊기면 방이 즉시 사라진다.
test('lifecycle: an all-agent room is reclaimed immediately when its last agent leaves', async () => {
  const { agent: a } = await connectAgentWithKey(url, validKey, 'life-immediate-a');
  const created = await emitWithAck(a, 'createRoom', { name: 'ephemeral room' });
  const roomId = created.room.id;

  const { agent: probe } = await connectAgentWithKey(url, validKey, 'life-immediate-probe');
  const before = await requestRooms(probe);
  assert(before.some((r) => r.id === roomId), 'room should exist while the agent is connected');

  a.close();
  await delay(400);
  const afterList = await requestRooms(probe);
  assert(!afterList.some((r) => r.id === roomId), 'room should be reclaimed immediately after disconnect');

  probe.close();
});

// 수명(TTL): 사람 없는 유휴 대기방은 BYO_EMPTY_ROOM_TTL_MS 경과 후 정리된다.
test('lifecycle: an idle all-agent room is reclaimed after the TTL elapses', async () => {
  const ttlUrl = await spawnServerWithTtl(TTL_MS);
  const { agent: a } = await connectAgentWithKey(ttlUrl, validKey, 'life-ttl-a');
  const created = await emitWithAck(a, 'createRoom', { name: 'idle room' });
  const roomId = created.room.id;

  const { agent: probe } = await connectAgentWithKey(ttlUrl, validKey, 'life-ttl-probe');
  const before = await requestRooms(probe);
  assert(before.some((r) => r.id === roomId), 'idle room should exist before the TTL elapses');

  await delay(TTL_MS + 600);
  const afterList = await requestRooms(probe);
  assert(!afterList.some((r) => r.id === roomId), 'idle room should be reclaimed after the TTL');

  probe.close();
  a.close();
});
