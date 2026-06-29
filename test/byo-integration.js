'use strict';

// G008(S8): BYO 인증/키 발급/에이전트 게임 end-to-end 통합 테스트.
// 실 HTTP(express 라우터) + 실 소켓(/agent 네임스페이스)을 한 서버 프로세스에서 검증한다.
//
// 셋업: 임시 BYO_KEY_STORE_PATH 에 계정 1개만 미리 만들고(키는 HTTP 로 발급),
//       SESSION_SECRET 을 고정해 spawn 한다. 테스트는 같은 SESSION_SECRET 로 세션쿠키를
//       서명(signSessionCookie)해 인증 상태를 구성한다(OAuth 네트워크 불필요).
//
// 검증 항목:
//  (a) 세션 없이 keys-api 접근 → 401.
//  (b) OAuth env 미설정 provider → 404(서버는 정상 부팅, 라우트만 404).
//  (c) HTTP POST /account/keys 로 키 발급(평문 1회 노출).
//  (d) 그 apiKey 로 /agent 접속 → createRoom/joinRoom → startGame → state/observation 수신.
//  (e) HTTP DELETE /account/keys/:id 폐기 → 해당 키의 라이브 /agent 소켓이 즉시 disconnect 되고
//      (S3↔S6 실연결: connGuard.socketsForKey), 재접속이 'invalid or revoked api key' 로 거부.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  startServer,
  stopServer,
  closeAll,
  connectAgentWithKey,
  expectAgentKeyRejected,
  expectDisconnect,
  emitWithAck,
  emitRawAck,
  waitForEvent,
  signSessionCookie,
  httpJson,
  issueKeyViaHttp,
  revokeKeyViaHttp,
} = require('./helpers/agent-harness');
const { createStore } = require('../server/auth/store');

const SESSION_SECRET = 'byo-integration-secret-0123456789';

let url = null;
let tmpDir = null;
let storePath = null;
let account = null;
let sessionCookie = null;

// apiKey startGame 은 ack 콜백을 '첫 인자'로 받는다(서버 와이어링 계약). payload 없이 콜백만 보낸다.
function startGameAck(socket, ms = 1500) {
  return new Promise((resolve, reject) => {
    socket.timeout(ms).emit('startGame', (err, response) => {
      if (err) reject(new Error(`startGame ack timed out: ${err.message || err}`));
      else resolve(response);
    });
  });
}

before(async () => {
  // 임시 store 파일에 계정 1개만 만든다(키는 테스트가 HTTP 로 발급하므로 미리 만들지 않는다).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byo-int-'));
  storePath = path.join(tmpDir, 'byo-store.json');
  const store = createStore(storePath);
  account = await store.upsertAccount({ provider: 'test', subject: 'integration-user' });

  // 서버가 같은 store 파일을 메모리로 로드하고, 같은 SESSION_SECRET 으로 세션쿠키를 검증하도록 spawn.
  process.env.BYO_KEY_STORE_PATH = storePath;
  process.env.SESSION_SECRET = SESSION_SECRET;
  url = (await startServer()).url;

  // 테스트가 보유한 인증 상태: 같은 시크릿으로 서명한 세션쿠키.
  sessionCookie = signSessionCookie(
    { id: account.id, provider: account.provider, subject: account.subject },
    SESSION_SECRET
  );
});

after(async () => {
  closeAll();
  stopServer();
  delete process.env.BYO_KEY_STORE_PATH;
  delete process.env.SESSION_SECRET;
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort 정리 */
    }
  }
});

test('(a) keys-api 는 세션 없이 401 을 돌려준다', async () => {
  const res = await httpJson(url, '/account/keys', { method: 'GET' });
  assert.equal(res.status, 401, `세션 없는 GET /account/keys 는 401 이어야 함(got ${res.status})`);
  assert.equal(res.body && res.body.ok, false, '401 응답 본문은 {ok:false} 여야 함');
});

test('(b) OAuth env 미설정 시 provider 라우트는 404 다(서버 부팅엔 영향 없음)', async () => {
  const res = await httpJson(url, '/auth/google', { method: 'GET' });
  assert.equal(res.status, 404, `미설정 provider 는 404 여야 함(got ${res.status})`);
  assert.equal(res.body && res.body.ok, false, '404 응답 본문은 {ok:false} 여야 함');
});

test('(c)-(e) 발급 → 접속/게임 → 폐기 → 즉시 disconnect → 재접속 거부 end-to-end', async () => {
  // (c) HTTP 로 키 발급 — 평문 key 는 이 응답에서 단 1회 노출된다.
  const issued = await issueKeyViaHttp(url, sessionCookie, 'e2e key');
  assert.equal(issued.status, 201, `키 발급은 201 이어야 함(got ${issued.status})`);
  assert.ok(issued.body && issued.body.ok === true, '발급 응답은 {ok:true} 여야 함');
  const apiKey = issued.body.key;
  const keyId = issued.body.record && issued.body.record.id;
  assert.equal(typeof apiKey, 'string', '발급 응답에 평문 key 가 있어야 함');
  assert.ok(apiKey.length >= 16, '평문 key 는 충분히 길어야 함');
  assert.equal(typeof keyId, 'string', '발급 응답에 record.id(keyId)가 있어야 함');
  assert.equal('keyHash' in issued.body.record, false, '응답 record 에 keyHash 가 노출되면 안 됨');

  // GET 으로도 키가 목록에 보인다(세션 인증 확인).
  const listed = await httpJson(url, '/account/keys', { method: 'GET', cookie: sessionCookie });
  assert.equal(listed.status, 200, `세션 GET /account/keys 는 200 이어야 함(got ${listed.status})`);
  assert.ok(
    Array.isArray(listed.body.keys) && listed.body.keys.some((k) => k.id === keyId),
    '발급한 키가 목록에 보여야 함'
  );

  // (d) 그 apiKey 로 /agent 접속. 같은 키로 2 연결(keyCap=2) — 둘 다 같은 방에서 게임.
  const { agent: agent1, auth: auth1 } = await connectAgentWithKey(url, apiKey, 'e2e-agent1');
  assert.equal(auth1.mode, 'apiKey', 'agentAuthenticated.mode 는 apiKey 여야 함');
  assert.equal(auth1.keyId, keyId, 'agentAuthenticated.keyId 가 발급한 keyId 와 일치해야 함');

  const { agent: agent2 } = await connectAgentWithKey(url, apiKey, 'e2e-agent2');

  // rooms 조회(로비) → 동작 확인.
  agent1.emit('rooms');
  await waitForEvent(agent1, 'rooms', () => true, 'agent1 rooms list');

  // createRoom(agent1, host) → joinRoom(agent2) → 같은 방에 모인다.
  const createAck = await emitWithAck(agent1, 'createRoom', { name: 'e2e room', nick: 'A1' });
  assert.ok(createAck && createAck.ok === true, `createRoom 성공해야 함: ${JSON.stringify(createAck)}`);
  const roomId = createAck.room && createAck.room.id;
  assert.equal(typeof roomId, 'string', 'createRoom 응답에 room.id 가 있어야 함');

  const joinAck = await emitWithAck(agent2, 'joinRoom', { roomId, nick: 'A2' });
  assert.ok(joinAck && joinAck.ok === true, `joinRoom 성공해야 함: ${JSON.stringify(joinAck)}`);
  assert.equal(joinAck.room.id, roomId, 'agent2 가 같은 방에 들어가야 함');

	  // startGame(host=agent1) → 두 에이전트가 state/observation 을 수신.
	  const obs1 = waitForEvent(agent1, 'agentObservation', (o) => o && o.state, 'agent1 observation', 4000);
	  const obs2 = waitForEvent(agent2, 'agentObservation', (o) => o && o.state, 'agent2 observation', 4000);
	  const startAck = await startGameAck(agent1);
  assert.ok(startAck && startAck.ok === true, `startGame 성공해야 함: ${JSON.stringify(startAck)}`);
	  const [o1, o2] = await Promise.all([obs1, obs2]);
	  assert.ok(o1 && o1.state && Array.isArray(o1.state.players), 'agent1 이 state 를 수신해야 함');
	  assert.ok(o2 && o2.state && Array.isArray(o2.state.players), 'agent2 가 state 를 수신해야 함');
	  const agent2PlayerId = o2.playerId;
	  assert.equal(typeof agent2PlayerId, 'string', 'agent2 observation 에 playerId 가 있어야 함');
	  const preDisconnectAction = await emitRawAck(agent2, 'agentAction', { type: 'wait', seq: 10 });
	  assert.equal(preDisconnectAction && preDisconnectAction.ok, true, `재접속 전 wait seq=10 은 성공해야 함: ${JSON.stringify(preDisconnectAction)}`);

	  agent2.disconnect();
	  const { agent: agent2Reconnected } = await connectAgentWithKey(url, apiKey, 'e2e-agent2-reconnect');
	  const resumeAck = await emitWithAck(agent2Reconnected, 'resumeAgent', { playerId: agent2PlayerId });
	  assert.equal(resumeAck.ok, true, `resumeAgent 성공해야 함: ${JSON.stringify(resumeAck)}`);
	  assert.equal(resumeAck.playerId, agent2PlayerId, 'resumeAgent 는 기존 playerId 를 유지해야 함');
	  const resumedObs = await waitForEvent(
	    agent2Reconnected,
	    'agentObservation',
	    (o) => o && o.playerId === agent2PlayerId && o.state,
	    'agent2 resumed observation',
	    4000
	  );
	  assert.equal(resumedObs.playerId, agent2PlayerId, '재접속 관측은 기존 슬롯이어야 함');
	  const replayAck = await emitRawAck(agent2Reconnected, 'agentAction', { type: 'wait', seq: 10 });
	  assert.equal(replayAck && replayAck.ok, false, `재접속 후 같은 explicit seq=10 재사용은 거부되어야 함: ${JSON.stringify(replayAck)}`);
	  const continuedAck = await emitRawAck(agent2Reconnected, 'agentAction', { type: 'wait' });
	  assert.equal(continuedAck && continuedAck.ok, true, `재접속 후 서버 배정 seq 는 성공해야 함: ${JSON.stringify(continuedAck)}`);
	  assert.ok(continuedAck.seq > 10, `재접속 후 서버 배정 seq 는 10보다 커야 함(got ${continuedAck.seq})`);

	  // (e) HTTP DELETE 폐기 → 폐기 키에 묶인 라이브 소켓이 즉시 강제 종료(S3↔S6 실연결).
	  const disc1 = expectDisconnect(agent1, 'agent1 revoke disconnect');
	  const disc2 = expectDisconnect(agent2Reconnected, 'agent2 revoke disconnect');
  const del = await revokeKeyViaHttp(url, sessionCookie, keyId);
  assert.equal(del.status, 200, `폐기는 200 이어야 함(got ${del.status})`);
  assert.equal(del.body.ok, true, '폐기 응답은 {ok:true} 여야 함');
  assert.equal(del.body.revoked, true, '폐기 결과 revoked=true 여야 함');
  assert.equal(
    del.body.disconnected,
    2,
    `폐기 시 라이브 소켓 2개가 강제 종료되어야 함(got ${del.body.disconnected})`
  );

  // 두 소켓 모두 즉시 disconnect 됨(connGuard.socketsForKey → disconnect(true)).
  await Promise.all([disc1, disc2]);
  assert.equal(agent1.connected, false, 'agent1 소켓이 끊겨야 함');
  assert.equal(agent2.connected, false, 'agent2 소켓이 끊겨야 함');

  // 폐기된 키로 재접속은 거부된다('invalid or revoked api key').
  const rejectMsg = await expectAgentKeyRejected(url, apiKey, 'revoked reconnect');
  assert.equal(
    rejectMsg,
    'invalid or revoked api key',
    `폐기 키 재접속은 'invalid or revoked api key' 로 거부되어야 함(got ${rejectMsg})`
  );

  // 폐기 후 같은 keyId 재폐기는 revoked=false(이미 폐기됨, disconnected=0).
  const delAgain = await revokeKeyViaHttp(url, sessionCookie, keyId);
  assert.equal(delAgain.status, 200, '재폐기도 200(소유 키)');
  assert.equal(delAgain.body.revoked, false, '이미 폐기된 키 재폐기는 revoked=false');
});

test('(e+) 타 계정/존재하지 않는 키 폐기는 404(존재 노출 금지)', async () => {
  const res = await revokeKeyViaHttp(url, sessionCookie, 'key_doesnotexist');
  assert.equal(res.status, 404, `미소유/부재 키 폐기는 404 여야 함(got ${res.status})`);
});
