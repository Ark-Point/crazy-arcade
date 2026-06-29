'use strict';

// G004(S4) executor QA/red-team: /agent apiKey 인증 분기를 깨려는 적대 테스트.
// server/index.js 의 agentIo.use 미들웨어(apiKey 분기 → hashKey → store.findByKeyHash,
// validate ownerId 가드, store=null 폴백)와 connection 핸들러(apiKey 모드 방 미배치 가드)를
// 정상 경로가 아닌 위조/오용/경계/혼동 경로로 두드린다.
//
// 제품 코드는 건드리지 않는다. 임시 BYO_KEY_STORE_PATH store 파일에 키를 직접 발급하고,
// 하네스 startServer(메인) + 직접 spawn(별도 인스턴스)로 서버를 띄워 핸드셰이크를 검증한다.
//
// 케이스:
//  (1) apiKey 위조/오용 — 빈문자열/공백/제어·유니코드 문자/객체·숫자 타입/존재키 prefix만/해시 자체 → 전부 거부
//  (2) 폐기된 키 거부
//  (3) apiKey + token 동시 제시 시 모드 우선순위 결정적·혼동 없음
//  (4) apiKey 모드 소켓이 방 미배치 상태에서 agentAction 송신 → 거부(크래시 없음)
//  (5) store 파일 부재/손상 시 서버 부팅·토큰 경로 영향 없음(별도 서버 인스턴스)
//  (6) 연속 잘못된 apiKey 연결 시도가 서버 크래시/토큰 세션 오염을 유발하지 않음

const { test, before, after } = require('node:test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

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
  waitForServer,
  getFreePort,
  emitRawAck,
  agentPlayers,
} = require('./helpers/agent-harness');
const { createStore, hashKey } = require('../server/auth/store');

const REJECT_KEY = 'invalid or revoked api key';
const REJECT_TOKEN = 'invalid agent token';

let url = null;
let tmpDir = null;
let storePath = null;
let validKey = null;
let revokedKey = null;
let keyId = null;

// 직접 spawn 한(하네스 외부) 자식/소켓은 자체 추적해 after 에서 정리한다.
const extraChildren = [];
const extraSockets = [];

// 임의 auth 페이로드(apiKey/token 혼합 포함)로 /agent 연결을 시도하고 결과를 분류한다.
// 반환: { outcome:'connected', auth? , socket } | { outcome:'rejected', message }
function connectWithAuth(targetUrl, auth, label, { expectAuthenticated = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(`${targetUrl}/agent`, {
      auth,
      reconnection: false,
      timeout: 1500,
      forceNew: true,
    });
    extraSockets.push(socket);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label} timed out`));
    }, 3000);
    socket.once('connect', () => {
      if (expectAuthenticated) {
        socket.once('agentAuthenticated', (a) => {
          clearTimeout(timer);
          resolve({ outcome: 'connected', auth: a, socket });
        });
      } else {
        clearTimeout(timer);
        resolve({ outcome: 'connected', socket });
      }
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      resolve({ outcome: 'rejected', message: err && err.message });
    });
  });
}

// 별도 서버 인스턴스를 명시적 BYO_KEY_STORE_PATH 로 spawn 한다(메인과 격리).
async function spawnServerWithStore(storePathOverride) {
  const port = await getFreePort();
  const targetUrl = `http://localhost:${port}`;
  let out = '';
  const child = spawn('node', ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), BYO_KEY_STORE_PATH: storePathOverride },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });
  extraChildren.push(child);
  await waitForServer(targetUrl);
  return { url: targetUrl, child, log: () => out };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-redteam-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  const account = await store.upsertAccount({ provider: 'test', subject: 'redteam' });
  const issued = await store.issueKey(account.id, 'valid key');
  validKey = issued.key;
  keyId = issued.record.id;
  const revokedIssued = await store.issueKey(account.id, 'revoked key');
  revokedKey = revokedIssued.key;
  const revoked = await store.revokeKey(revokedIssued.record.id);
  assert(revoked === true, 'setup: revokeKey should report success');

  process.env.BYO_KEY_STORE_PATH = storePath;
  url = (await startServer()).url;
});

after(async () => {
  for (const s of extraSockets) {
    try { s.close(); } catch { /* 무시 */ }
  }
  closeAll();
  stopServer();
  for (const child of extraChildren) {
    try { child.kill(); } catch { /* 무시 */ }
  }
  delete process.env.BYO_KEY_STORE_PATH;
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
});

// (1) apiKey 위조/오용 — 모든 변종이 거부된다.
test('redteam(1): forged/misused apiKey variants are all rejected', async () => {
  // 문자열 변종 → apiKey 분기 진입 후 해시 미스 → REJECT_KEY.
  const stringForgeries = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['tab/newline', '\t\n'],
    ['control + unicode + html', '\u0000日本語🔥<script>alert(1)</script>'],
    ['sql-ish junk', "' OR 1=1 --"],
    ['existing key prefix only', validKey.slice(0, 8)],
    ['hash presented as key', hashKey(validKey)],
    ['valid key with trailing space', `${validKey} `],
    ['valid key with leading space', ` ${validKey}`],
    ['valid key uppercased', validKey.toUpperCase()],
  ];
  for (const [label, key] of stringForgeries) {
    const reason = await expectAgentKeyRejected(url, key, `forge-${label}`);
    assert(reason === REJECT_KEY, `[${label}] expected "${REJECT_KEY}", got "${reason}"`);
  }

  // 비문자열 타입 → apiKey 분기 미진입(typeof !== 'string') → 토큰 경로 → REJECT_TOKEN.
  const typeForgeries = [
    ['object type', { malicious: true }],
    ['number type', 1234567890],
    ['boolean type', true],
    ['array type', ['k', 'e', 'y']],
  ];
  for (const [label, key] of typeForgeries) {
    const reason = await expectAgentKeyRejected(url, key, `type-${label}`);
    assert(reason === REJECT_TOKEN, `[${label}] expected "${REJECT_TOKEN}", got "${reason}"`);
  }
});

// (2) 폐기된 키 거부.
test('redteam(2): a revoked apiKey is rejected', async () => {
  const reason = await expectAgentKeyRejected(url, revokedKey, 'revoked-key');
  assert(reason === REJECT_KEY, `expected "${REJECT_KEY}", got "${reason}"`);
  // 폐기키를 두 번 더 던져도 동일하게 결정적으로 거부(상태 오염 없음).
  const again = await expectAgentKeyRejected(url, revokedKey, 'revoked-key-again');
  assert(again === REJECT_KEY, `re-attempt expected "${REJECT_KEY}", got "${again}"`);
});

// (3) apiKey + token 동시 제시 — 모드 우선순위가 결정적이고 혼동이 없다.
test('redteam(3): apiKey+token precedence is deterministic', async () => {
  // 3a: 유효 apiKey + (형식상 유효한) 임의 token → apiKey 분기가 선점, apiKey 모드로 인증.
  const bogusToken = 'z'.repeat(48);
  const withBoth = await connectWithAuth(
    url,
    { apiKey: validKey, token: bogusToken },
    'valid-key-and-token',
    { expectAuthenticated: true }
  );
  assert(withBoth.outcome === 'connected', `3a expected connect, got ${withBoth.outcome}/${withBoth.message}`);
  assert(withBoth.auth && withBoth.auth.mode === 'apiKey', `3a expected apiKey mode, got ${withBoth.auth && withBoth.auth.mode}`);
  assert(withBoth.auth.keyId === keyId, `3a keyId mismatch: ${withBoth.auth.keyId} !== ${keyId}`);
  withBoth.socket.close();

  // 유효 token 1개를 실제로 발급해 둔다(3b/3c 공용).
  let latestRoom = null;
  const host = await connectHuman(url, (room) => { latestRoom = room; });
  const { invite } = await createRoomWithAgentInvite(host);
  assert(invite && typeof invite.token === 'string' && invite.token.length >= 32, 'real token invite missing');

  // 3b: 잘못된 apiKey 문자열 + 유효 token → apiKey 분기에서 즉시 거부(유효 token 으로 구제되지 않음).
  const rescued = await connectWithAuth(
    url,
    { apiKey: 'totally-bogus-key', token: invite.token },
    'bad-key-good-token'
  );
  assert(rescued.outcome === 'rejected', `3b expected rejection, got ${rescued.outcome}`);
  assert(rescued.message === REJECT_KEY, `3b expected "${REJECT_KEY}", got "${rescued.message}"`);

  // 3c: 비문자열 apiKey + 유효 token → apiKey 분기 미진입 → 토큰 경로로 정상 연결(결정적, 혼동 없음).
  const roomWithAgentPromise = latestRoom && agentPlayers(latestRoom).length === 1
    ? Promise.resolve(latestRoom)
    : waitForEvent(
      host,
      'roomUpdate',
      (r) => r && r.id === invite.roomId && agentPlayers(r).length === 1,
      'room update with one agent controller player',
      5000
    );
  const tokenViaObjectKey = await connectWithAuth(
    url,
    { apiKey: { not: 'a string' }, token: invite.token },
    'objkey-good-token'
  );
  assert(tokenViaObjectKey.outcome === 'connected', `3c expected token-path connect, got ${tokenViaObjectKey.outcome}/${tokenViaObjectKey.message}`);
  const roomWithAgent = await roomWithAgentPromise;
  assert(agentPlayers(roomWithAgent).length === 1, '3c token agent should have joined the room');
  tokenViaObjectKey.socket.close();
  host.close();
});

// (4) apiKey 모드 소켓이 방 미배치에서 agentAction 송신 → 거부, 서버 크래시 없음.
test('redteam(4): apiKey-mode action without a room is rejected, no crash', async () => {
  const { agent } = await connectAgentWithKey(url, validKey, 'apikey-action-agent');
  assert(agent.connected, 'apiKey socket should be connected');

  // 정상 형태 액션.
  const ack1 = await emitRawAck(agent, 'agentAction', { type: 'move', seq: 1, keys: { left: true } });
  assert(ack1 && ack1.ok === false, `expected ok:false, got ${JSON.stringify(ack1)}`);
  assert(ack1.error === 'join a room before sending actions', `unexpected error: ${ack1.error}`);

  // 적대적 페이로드(비객체/거대/널)도 동일하게 거부되고 소켓이 죽지 않아야 한다.
  const ack2 = await emitRawAck(agent, 'agentAction', 'not-an-object');
  assert(ack2 && ack2.ok === false, `non-object payload should be rejected, got ${JSON.stringify(ack2)}`);
  const ack3 = await emitRawAck(agent, 'agentAction', { type: 'move', junk: 'x'.repeat(5000) });
  assert(ack3 && ack3.ok === false, `oversized payload should be rejected, got ${JSON.stringify(ack3)}`);
  assert(agent.connected, 'apiKey socket should survive adversarial actions');
  agent.close();

  // 서버가 여전히 살아 있고 새 apiKey 인증을 받는지 확인(크래시 가드).
  const { agent: probe } = await connectAgentWithKey(url, validKey, 'post-action-probe');
  assert(probe.connected, 'server should still accept apiKey auth after rejected actions');
  probe.close();
});

// (5) store 파일 부재/손상 — 서버 부팅 OK, 토큰 경로 무영향, apiKey 만 비활성.
test('redteam(5a): absent store boots; token path works; apiKey rejected', async () => {
  const absentPath = path.join(tmpDir, 'does-not-exist', 'absent-store.json');
  assert(!fs.existsSync(absentPath), 'precondition: absent store must not exist');
  const srv = await spawnServerWithStore(absentPath);

  // apiKey 인증은 빈 store 라 거부(유효 키였더라도 이 인스턴스엔 없음).
  const reason = await expectAgentKeyRejected(srv.url, validKey, 'absent-store-apikey');
  assert(reason === REJECT_KEY, `absent store apiKey expected "${REJECT_KEY}", got "${reason}"`);

  // 토큰 경로는 정상 동작.
  let latestRoom = null;
  const host = await connectHuman(srv.url, (room) => { latestRoom = room; });
  const { invite } = await createRoomWithAgentInvite(host);
  const roomWithAgentPromise = latestRoom && agentPlayers(latestRoom).length === 1
    ? Promise.resolve(latestRoom)
    : waitForEvent(host, 'roomUpdate', (r) => r && r.id === invite.roomId && agentPlayers(r).length === 1, 'absent-store room update', 5000);
  const agent = await connectAgent(srv.url, invite.token, 'absent-store-token-agent');
  const roomWithAgent = await roomWithAgentPromise;
  assert(agent.connected, 'token agent should connect on absent-store server');
  assert(agentPlayers(roomWithAgent).length === 1, 'token agent should join the room');
  agent.close();
  host.close();
  srv.child.kill();
});

test('redteam(5b): corrupt store boots; token path works; apiKey rejected', async () => {
  const corruptPath = path.join(tmpDir, 'corrupt-store.json');
  fs.writeFileSync(corruptPath, '{ this is : not valid json ]]]', 'utf8');
  const srv = await spawnServerWithStore(corruptPath);

  // 손상 store → store=null → apiKey 인증 비활성(거부).
  const reason = await expectAgentKeyRejected(srv.url, validKey, 'corrupt-store-apikey');
  assert(reason === REJECT_KEY, `corrupt store apiKey expected "${REJECT_KEY}", got "${reason}"`);

  // 토큰 경로는 손상과 무관하게 동작.
  let latestRoom = null;
  const host = await connectHuman(srv.url, (room) => { latestRoom = room; });
  const { invite } = await createRoomWithAgentInvite(host);
  const roomWithAgentPromise = latestRoom && agentPlayers(latestRoom).length === 1
    ? Promise.resolve(latestRoom)
    : waitForEvent(host, 'roomUpdate', (r) => r && r.id === invite.roomId && agentPlayers(r).length === 1, 'corrupt-store room update', 5000);
  const agent = await connectAgent(srv.url, invite.token, 'corrupt-store-token-agent');
  const roomWithAgent = await roomWithAgentPromise;
  assert(agent.connected, 'token agent should connect on corrupt-store server');
  assert(agentPlayers(roomWithAgent).length === 1, 'token agent should join the room');
  agent.close();
  host.close();
  srv.child.kill();
});

// (6) 연속 잘못된 apiKey 연결 폭주 → 서버 크래시 없음, 토큰 세션 오염 없음.
test('redteam(6): a flood of bad apiKey connects neither crashes nor poisons token sessions', async () => {
  const variants = [
    '',
    '   ',
    'totally-invalid-key',
    validKey.slice(0, 8),
    hashKey(validKey),
    revokedKey,
    '\u0000bad',
    `${validKey}x`,
  ];
  // 32회 연속 거부 시도.
  for (let i = 0; i < 32; i++) {
    const key = variants[i % variants.length];
    const reason = await expectAgentKeyRejected(url, key, `flood-${i}`);
    assert(reason === REJECT_KEY, `flood[${i}] expected "${REJECT_KEY}", got "${reason}"`);
  }

  // 폭주 직후에도 유효 apiKey 인증이 정상이어야 한다(크래시/store 오염 가드).
  const { agent: keyAgent, auth } = await connectAgentWithKey(url, validKey, 'post-flood-key');
  assert(keyAgent.connected, 'valid apiKey must still authenticate after the flood');
  assert(auth && auth.mode === 'apiKey' && auth.keyId === keyId, 'apiKey binding must be intact after the flood');
  keyAgent.close();

  // 토큰 세션도 폭주에 오염되지 않고 정상 생성/접속되어야 한다.
  let latestRoom = null;
  const host = await connectHuman(url, (room) => { latestRoom = room; });
  const { invite } = await createRoomWithAgentInvite(host);
  const roomWithAgentPromise = latestRoom && agentPlayers(latestRoom).length === 1
    ? Promise.resolve(latestRoom)
    : waitForEvent(host, 'roomUpdate', (r) => r && r.id === invite.roomId && agentPlayers(r).length === 1, 'post-flood room update', 5000);
  const tokenAgent = await connectAgent(url, invite.token, 'post-flood-token');
  const roomWithAgent = await roomWithAgentPromise;
  assert(tokenAgent.connected, 'token agent must connect after the flood');
  assert(agentPlayers(roomWithAgent).length === 1, 'token agent must join cleanly after the flood');
  assert(agentPlayers(roomWithAgent)[0].id === invite.playerId, 'token session must bind its own invite, uncontaminated');
  tokenAgent.close();
  host.close();
});
