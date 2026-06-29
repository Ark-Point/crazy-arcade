'use strict';

// B3: 게임 활성 상태에서 agentAction 페이로드 상한(2048B) 강제 검증.
// startGame 후 state.countdown===0 인 활성 상태에서:
//  - 2048바이트 초과 페이로드 → ack ok===false (서버가 oversized 로 거부)
//  - 2048바이트 이하 정상 move → ack ok===true
const { test, before, after } = require('node:test');
const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  createRoomWithAgentInvite,
  waitForEvent,
  emitRawAck,
  statePlayer,
} = require('./helpers/agent-harness');

let url = null;
let host = null;
let agent = null;
let agentPlayerId = null;

before(async () => {
  url = resolveUrl() || (await startServer()).url;
  host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host);
  assert(invite && typeof invite.token === 'string', 'invite token missing');
  agent = await connectAgent(url, invite.token, 'agent');

  // agentObservation 은 게임 시작 이후에만 송신된다. 먼저 startGame 후 관측으로 playerId 확보.
  host.emit('startGame');
  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (o) => o && typeof o.playerId === 'string',
    'initial agentObservation',
    5000
  );
  agentPlayerId = obs.playerId;

  // 카운트다운 종료(활성) 까지 대기.
  await waitForEvent(
    agent,
    'state',
    (s) => s && s.countdown === 0 && statePlayer(s, agentPlayerId),
    'state after countdown (active game)',
    7000
  );
});

after(async () => {
  closeAll();
  stopServer();
});

test('oversized agentAction payload (>2048B) is rejected with ok===false', async () => {
  const oversized = {
    type: 'move',
    seq: 1,
    keys: { left: true },
    junk: 'x'.repeat(3000),
  };
  const byteLength = Buffer.byteLength(JSON.stringify(oversized), 'utf8');
  assert(byteLength > 2048, `fixture must exceed 2048B, got ${byteLength}`);

  const ack = await emitRawAck(agent, 'agentAction', oversized);
  assert(ack && ack.ok === false, `oversized payload was not rejected: ${JSON.stringify(ack)}`);
});

test('valid move payload (<=2048B) is accepted with ok===true', async () => {
  const action = { type: 'move', seq: 1, keys: { left: true } };
  const byteLength = Buffer.byteLength(JSON.stringify(action), 'utf8');
  assert(byteLength <= 2048, `fixture must be within 2048B, got ${byteLength}`);

  const ack = await emitRawAck(agent, 'agentAction', action);
  assert(ack && ack.ok === true, `valid move was not accepted: ${JSON.stringify(ack)}`);
});
