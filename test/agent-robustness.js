'use strict';

// G002 Crazay Arkade BYO-agent 견고성 검증 스위트 (node:test).
// 공유 하네스만 사용하고 server/·public/ 을 건드리지 않는다.
// 실행: node --test test/agent-robustness.js

const { test, before, after } = require('node:test');

const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  expectAgentRejected,
  waitForEvent,
  emitWithAck,
  emitRawAck,
  agentPlayers,
  assertNoRoomGrowth,
  createRoomWithAgentInvite,
  floodActions,
} = require('./helpers/agent-harness');

let url = null;

before(async () => {
  url = resolveUrl() || (await startServer()).url;
});

after(() => {
  stopServer();
  closeAll();
});

// B5: 게임 활성 상태에서 기형/oversized/고빈도 액션 폭주 후에도 서버가
// 살아있음을 후속 정상 move(ok===true) + state 수신으로 증명한다.
test('B5: flood of malformed/oversized/high-rate actions does not crash an active game', async () => {
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    nick: 'CrashHost',
    roomName: 'crash safety',
    invite: { nick: 'CrashAI', char: 1 },
  });
  const agent = await connectAgent(url, invite.token, 'crash safety agent');

  host.emit('startGame');
  await waitForEvent(host, 'gameStart', () => true, 'crash safety game start');
  // 게임 활성 직후 첫 state 까지 대기(게임 루프 가동 확인).
  await waitForEvent(agent, 'state', (s) => s && Array.isArray(s.players), 'crash safety initial state');

  // 기형/oversized/고빈도 액션 폭주 — 전부 ack 를 받아야 하고 서버는 죽지 않아야 한다.
  const floodAcks = await floodActions(agent, 30);
  assert(floodAcks.length === 30, `flood produced ${floodAcks.length} acks, expected 30`);

  // 증명 1: 폭주 이후 후속 정상 move 가 ok===true 로 처리된다(서버 생존).
  // G001 레이트캡(초당 30) 도입으로 flood 30건이 1초 윈도우를 채우므로, 윈도우가
  // 비워질 때까지 대기한 뒤 정상 move 를 보내 크래시세이프티 의도를 보존한다.
  await new Promise((r) => setTimeout(r, 1100));
  const moveAck = await emitRawAck(agent, 'agentAction', { type: 'move', keys: { right: true } });
  assert(moveAck && moveAck.ok === true, `post-flood move was not ok: ${JSON.stringify(moveAck)}`);

  // 증명 2: 게임 루프가 계속 돌며 state 를 정상 송신한다(크래시 없음).
  const liveState = await waitForEvent(agent, 'state', (s) => s && Array.isArray(s.players), 'crash safety post-flood state');
  assert(liveState.players.length >= 1, 'post-flood state has no players');
});

// B6: 방 정원(MAX_PLAYERS=8) — 호스트 + 인간 7명으로 채운 뒤 두 경로를 분리 단언한다.
test('B6: a full room rejects both a 9th human join and an agent invite', async () => {
  const host = await connectHuman(url);
  host.emit('setNick', 'FullHost');
  host.emit('createRoom', 'capacity room');
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'capacity room creation');

  // 호스트(1) + 인간 7명 = MAX_PLAYERS(8) 까지 채운다.
  for (let i = 0; i < 7; i++) {
    const joiner = await connectHuman(url);
    joiner.emit('setNick', `Filler${i}`);
    joiner.emit('joinRoom', room.id);
    await waitForEvent(joiner, 'joinedRoom', (r) => r && r.id === room.id, `filler ${i} join`);
  }

  // (a) 9번째 인간 joinRoom → 'errorMsg' '방이 가득 찼습니다.'
  const ninth = await connectHuman(url);
  ninth.emit('setNick', 'Ninth');
  const errorMsgP = waitForEvent(
    ninth,
    'errorMsg',
    (msg) => msg === '방이 가득 찼습니다.',
    'ninth human room-full errorMsg'
  );
  ninth.emit('joinRoom', room.id);
  const errorMsg = await errorMsgP;
  assert(errorMsg === '방이 가득 찼습니다.', `unexpected errorMsg: ${errorMsg}`);

  // (b) 가득 찬 방의 호스트가 createAgentInvite → ack {ok:false,error:'room is full'}
  const inviteAck = await emitRawAck(host, 'createAgentInvite', { nick: 'LateAI', char: 1 });
  assert(inviteAck && inviteAck.ok === false, `full-room invite should be rejected: ${JSON.stringify(inviteAck)}`);
  assert(inviteAck.error === 'room is full', `unexpected invite error: ${inviteAck.error}`);
});

// B8: disconnect 정리(GREEN 범위) — 대기 방에서 접속한 에이전트를 socket.close() 했을 때
// (1) 슬롯 제거, (2) 동일 토큰 거부, (3) 방 미증식. keepInvite 보존·재접속 회수는 단언하지 않는다.
test('B8: closing a waiting-room agent socket removes the slot and consumes the token', async () => {
  let latestRoom = null;
  const getLatestRoom = () => latestRoom;
  const host = await connectHuman(url, (r) => { latestRoom = r; });

  host.emit('setNick', 'CleanupHost');
  host.emit('createRoom', 'disconnect cleanup');
  latestRoom = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'cleanup room creation');

  const invite = await emitWithAck(host, 'createAgentInvite', { nick: 'CleanupAI', char: 2 });
  assert(invite && typeof invite.token === 'string' && invite.token.length >= 16, 'invite did not include a usable token');

  const agent = await connectAgent(url, invite.token, 'cleanup agent');
  // 에이전트 슬롯이 방에 반영될 때까지 대기.
  if (!latestRoom.players.some((p) => p.controller === 'agent' && p.ownerId === host.id)) {
    await waitForEvent(
      host,
      'roomUpdate',
      (r) => r.players.some((p) => p.controller === 'agent' && p.ownerId === host.id),
      'cleanup agent slot present'
    );
  }

  // socket.close() → 서버가 슬롯 제거 + roomUpdate 송신.
  const removal = waitForEvent(
    host,
    'roomUpdate',
    (r) => !r.players.some((p) => p.controller === 'agent'),
    'cleanup agent slot removal'
  );
  agent.close();
  const afterRemoval = await removal;

  // (1) 슬롯 제거 확인.
  assert(agentPlayers(afterRemoval).length === 0, 'agent slot was not removed after socket close');

  // (2) 동일 토큰 재사용 거부(consumed/revoke).
  const rejectedMsg = await expectAgentRejected(url, invite.token, 'cleanup consumed token');
  assert(typeof rejectedMsg === 'string' && rejectedMsg.length > 0, 'consumed token rejection lacked a reason');

  // (3) 방 미증식(휴먼 전용 상태 유지).
  await assertNoRoomGrowth(getLatestRoom, 'after agent socket close');
});

// ---------------------------------------------------------------------------
// A-레인(advisory todo): 아직 서버에 미구현인 미래 동작의 명세.
// { todo:true } 라 실패해도 'not ok ... # TODO' 로 표기되어 스위트 실패를 막고 exit 0 유지.
// 구현 착지 시 'ok ... # TODO' 로 표면화 → advisory-scan 이 blocking 레인 승격을 촉구.

// A4: 초당 메시지 rate-cap 강제.
// 1초 안에 허용치(N건)를 초과해 들어오는 agentAction 은 거부(ok===false)되거나 지연되어야 한다.
// 고유 seq 를 쓰므로 seq-dedup 가 아니라 순수 per-second rate-cap 만 분리 검증한다.
// 오늘은 rate-cap 이 없어 1초 내 대량 액션이 전부 ok===true 로 수락됨 → rejected===0 → 실패(not ok # TODO).
// 구현 착지 시 ok # TODO 로 표면화 → advisory 승격.
test('A4: per-second message rate-cap rejects or defers an over-quota burst', async () => {
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    nick: 'A4Host',
    roomName: 'a4 per-second ratecap',
    invite: { nick: 'A4Agent', char: 1 },
  });
  const agent = await connectAgent(url, invite.token, 'A4 agent');
  host.emit('startGame');
  await waitForEvent(host, 'gameStart', () => true, 'A4 game start');
  await waitForEvent(agent, 'state', (s) => s && Array.isArray(s.players), 'A4 active state');

  // 고유 seq 60건을 동시 발사 — 합리적인 초당 한도를 크게 초과.
  const N = 60;
  const acks = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      emitRawAck(agent, 'agentAction', { type: 'move', seq: i + 1, keys: { left: true } })
    )
  );
  const rejected = acks.filter((a) => a && a.ok === false).length;
  // 순수 rate-cap 효과만 본다: 한도 초과 액션이 거부(ok===false)되어야 한다.
  // (wall-clock elapsed 는 부하/스케줄링에 흔들려 deferral 프록시로 부정확하므로 쓰지 않는다.)
  assert(
    rejected > 0,
    `per-second rate-cap unimplemented: ${N} actions were all accepted (expected some rejected with ok===false)`
  );
});
