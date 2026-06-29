'use strict';

// G004(S4): /agent apiKey 인증 분기 검증.
// 흐름: 임시 BYO_KEY_STORE_PATH 에 계정/키를 직접 발급한 store 파일을 만들고,
//       그 파일을 가리키는 서버를 spawn 해서 핸드셰이크 동작을 확인한다.
//  (a) 유효 apiKey → /agent 핸드셰이크 연결 성공 + keyId 바인딩(agentAuthenticated)
//  (b) 잘못된/폐기 apiKey → 연결 거부('invalid or revoked api key')
//  (c) apiKey 없이 token 경로 → 기존 createAgentInvite 흐름 그대로 동작
//  (d) 토큰 경로 관측 패리티(human 'state' 와 agentObservation.state deep-equal) 유지

const { test, before, after } = require('node:test');
const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  connectAgentWithKey,
  expectAgentKeyRejected,
  createRoomWithAgentInvite,
  waitForEvent,
  statePlayer,
  assertObservationParity,
  agentPlayers,
} = require('./helpers/agent-harness');
const { createStore } = require('../server/auth/store');

let url = null;
let tmpDir = null;
let storePath = null;
let validKey = null;
let revokedKey = null;
let keyId = null;

before(async () => {
  // 임시 store 파일에 계정 1개 + 유효키 1개 + 폐기키 1개를 직접 발급한다.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-auth-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'agent-auth' });
  const issued = await store.issueKey(account.id, 'valid key');
  validKey = issued.key;
  keyId = issued.record.id;
  const revokedIssued = await store.issueKey(account.id, 'revoked key');
  revokedKey = revokedIssued.key;
  const revoked = await store.revokeKey(revokedIssued.record.id);
  assert(revoked === true, 'setup: revokeKey should report success');

  // 서버는 이 store 파일을 가리키도록 spawn(startServer 가 process.env 를 자식에 상속).
  process.env.BYO_KEY_STORE_PATH = storePath;
  url = (await startServer()).url;
});

after(async () => {
  closeAll();
  stopServer();
  delete process.env.BYO_KEY_STORE_PATH;
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 정리 실패는 무시(테스트 결과에 영향 없음).
    }
  }
});

// (a) 유효 apiKey 로 핸드셰이크 성공 + keyId 바인딩.
test('S4(a): a valid apiKey authenticates and binds its keyId', async () => {
  const { agent, auth } = await connectAgentWithKey(url, validKey, 'valid-key-agent');
  assert(agent.connected, 'valid apiKey socket should be connected');
  assert(auth && auth.mode === 'apiKey', 'agentAuthenticated should report apiKey mode');
  assert(auth.keyId === keyId, `agentAuthenticated keyId mismatch: ${auth.keyId} !== ${keyId}`);
  assert(typeof auth.account === 'string' && auth.account.length > 0, 'account should be bound');
  agent.close();
});

// (b) 잘못된 apiKey 거부.
test('S4(b1): an unknown apiKey is rejected', async () => {
  const reason = await expectAgentKeyRejected(url, 'totally-invalid-key', 'bad-key-agent');
  assert(reason === 'invalid or revoked api key', `unexpected rejection reason: ${reason}`);
});

// (b) 폐기된 apiKey 거부.
test('S4(b2): a revoked apiKey is rejected', async () => {
  const reason = await expectAgentKeyRejected(url, revokedKey, 'revoked-key-agent');
  assert(reason === 'invalid or revoked api key', `unexpected rejection reason: ${reason}`);
});

// (c) apiKey 없이 token 경로가 기존대로 동작.
test('S4(c): the token path still works without an apiKey', async () => {
  let latestRoom = null;
  const host = await connectHuman(url, (room) => { latestRoom = room; });
  const { invite } = await createRoomWithAgentInvite(host);
  assert(invite && typeof invite.token === 'string' && invite.token.length >= 32, 'token invite missing');
  const roomWithAgentPromise = latestRoom && agentPlayers(latestRoom).length === 1
    ? Promise.resolve(latestRoom)
    : waitForEvent(
      host,
      'roomUpdate',
      (r) => r && r.id === invite.roomId && agentPlayers(r).length === 1,
      'room update with one agent controller player',
      5000
    );
  const agent = await connectAgent(url, invite.token, 'token-agent');
  const roomWithAgent = await roomWithAgentPromise;
  const agentPlayer = agentPlayers(roomWithAgent)[0];
  assert(agent.connected, 'token agent should connect');
  assert(agentPlayer.id === invite.playerId, 'agent player id should match the invite');
  agent.close();
  host.close();
});

// (d) 토큰 경로 관측 패리티 유지.
test('S4(d): token-path observation parity is preserved', async () => {
  const host = await connectHuman(url);
  const hostStateByTick = new Map();
  host.on('state', (s) => {
    if (s && typeof s.t === 'number') hostStateByTick.set(s.t, s);
  });
  const { invite } = await createRoomWithAgentInvite(host);
  const agent = await connectAgent(url, invite.token, 'parity-agent');
  host.emit('startGame');

  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (o) => o && o.state && o.state.countdown === 0 && hostStateByTick.has(o.state.t),
    'agentObservation at a tick the human host also received',
    8000
  );
  const humanState = hostStateByTick.get(obs.state.t);
  assert(humanState, `no human host state captured for tick ${obs.state.t}`);
  assertObservationParity(obs, humanState);

  const selfFromObs = statePlayer(obs.state, obs.playerId);
  assert(selfFromObs, `self id ${obs.playerId} not present in observation.state.players`);

  const obsKeys = Object.keys(obs).sort();
  const expectedKeys = [
    'invalid_reasons',
    'ownerId',
    'playerId',
    'policyContext',
    'resume',
    'roomId',
    'schema',
    'self',
    'state',
    'status',
    'trace',
    'valid_actions',
  ];
  assert(
    obsKeys.length === expectedKeys.length && obsKeys.every((k, i) => k === expectedKeys[i]),
    `observation top-level keys changed: ${obsKeys.join(',')}`
  );

  agent.close();
  host.close();
});
