const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  expectAgentRejected,
  expectDisconnect,
  waitForEvent,
  emitWithAck,
  assertHumanOnlyRoom,
  assertNoRoomGrowth,
} = require('./helpers/agent-harness');

let latestRoom = null;
const getLatestRoom = () => latestRoom;
const trackRoom = (room) => {
  latestRoom = room;
};

const cleanup = () => {
  closeAll();
  stopServer();
};

const fail = (msg) => {
  console.error('FAIL:', msg);
  cleanup();
  process.exit(1);
};

(async () => {
  setTimeout(() => fail('test timed out'), 32000).unref();

  try {
    // URL 미지정 시 self-spawn, 지정 시 외부 서버 사용.
    const URL = resolveUrl() || (await startServer()).url;

    const host = await connectHuman(URL, trackRoom);
    host.emit('setNick', 'SecurityHost');
    host.emit('createRoom', 'agent security');
    latestRoom = await waitForEvent(host, 'joinedRoom', (room) => room && room.id, 'room creation');
    assertHumanOnlyRoom(latestRoom, 'after room creation');

    const bogusMessage = await expectAgentRejected(URL, 'bogus-agent-token', 'bogus token');
    console.log('bogus token rejected:', bogusMessage);
    await assertNoRoomGrowth(getLatestRoom, 'after bogus token rejection');

    const invite = await emitWithAck(host, 'createAgentInvite', { nick: 'RevokedAgent', char: 2 });
    assert(invite && typeof invite.token === 'string' && invite.token.length >= 16, 'real invite did not include a usable token');

    const revokeAck = await emitWithAck(host, 'revokeAgentInvite', { id: invite.id, token: invite.token });
    assert(revokeAck && revokeAck.ok === true, 'revokeAgentInvite did not ack ok');
    await assertNoRoomGrowth(getLatestRoom, 'after invite revoke');

    const revokedMessage = await expectAgentRejected(URL, invite.token, 'revoked token');
    console.log('revoked token rejected:', revokedMessage);
    await assertNoRoomGrowth(getLatestRoom, 'after revoked token rejection');

    const replayInvite = await emitWithAck(host, 'createAgentInvite', { nick: 'ReplayAgent', char: 1 });
    const replayAgent = await connectAgent(URL, replayInvite.token, 'replay agent');
    if (!latestRoom.players.some((p) => p.controller === 'agent' && p.ownerId === host.id)) {
      await waitForEvent(
        host,
        'roomUpdate',
        (room) => room.players.some((p) => p.controller === 'agent' && p.ownerId === host.id),
        'replay agent room update'
      );
    }
    const replayDisconnect = waitForEvent(
      host,
      'roomUpdate',
      (room) => !room.players.some((p) => p.controller === 'agent'),
      'replay agent removal'
    );
    replayAgent.close();
    await replayDisconnect;
    const replayMessage = await expectAgentRejected(URL, replayInvite.token, 'consumed token replay');
    console.log('consumed token rejected:', replayMessage);
    await assertNoRoomGrowth(getLatestRoom, 'after consumed token replay rejection');
    const freshInvite = await emitWithAck(host, 'createAgentInvite', { nick: 'FreshAgent', char: 1 });
    assert(freshInvite.token !== replayInvite.token, 'fresh invite reused consumed token');
    await emitWithAck(host, 'revokeAgentInvite', {});
    await assertNoRoomGrowth(getLatestRoom, 'after fresh invite cleanup');

    const connectedInvite = await emitWithAck(host, 'createAgentInvite', { nick: 'ConnectedAI', char: 3 });
    const connectedAgent = await connectAgent(URL, connectedInvite.token, 'connected agent');
    if (!latestRoom.players.some((p) => p.controller === 'agent' && p.ownerId === host.id)) {
      await waitForEvent(
        host,
        'roomUpdate',
        (room) => room.players.some((p) => p.controller === 'agent' && p.ownerId === host.id),
        'connected agent room update'
      );
    }
    const connectedRevokeAck = await emitWithAck(host, 'revokeAgentInvite', {});
    assert(connectedRevokeAck && connectedRevokeAck.ok === true, 'connected agent revoke did not ack ok');
    await expectDisconnect(connectedAgent, 'connected agent revoke');
    await assertNoRoomGrowth(getLatestRoom, 'after connected agent revoke');

    const deleteOwner = await connectHuman(URL, trackRoom);
    deleteOwner.emit('setNick', 'DeleteOwner');
    deleteOwner.emit('createRoom', 'delete token room');
    await waitForEvent(deleteOwner, 'joinedRoom', (room) => room && room.id, 'delete room creation');
    const deleteInvite = await emitWithAck(deleteOwner, 'createAgentInvite', { nick: 'DeleteAI', char: 0 });
    deleteOwner.emit('leaveRoom');
    const deletedMessage = await expectAgentRejected(URL, deleteInvite.token, 'deleted room token');
    console.log('deleted room token rejected:', deletedMessage);

    const leaveOwner = await connectHuman(URL, trackRoom);
    leaveOwner.emit('setNick', 'LeaveOwner');
    leaveOwner.emit('createRoom', 'owner leave room');
    await waitForEvent(leaveOwner, 'joinedRoom', (room) => room && room.id, 'owner leave room creation');
    const leaveInvite = await emitWithAck(leaveOwner, 'createAgentInvite', { nick: 'LeaveAI', char: 0 });
    const leaveAgent = await connectAgent(URL, leaveInvite.token, 'owner leave agent');
    if (!latestRoom.players.some((p) => p.controller === 'agent' && p.ownerId === leaveOwner.id)) {
      await waitForEvent(
        leaveOwner,
        'roomUpdate',
        (room) => room.players.some((p) => p.controller === 'agent' && p.ownerId === leaveOwner.id),
        'owner leave agent room update'
      );
    }
    const ownerLeaveDisconnect = expectDisconnect(leaveAgent, 'owner leave agent');
    leaveOwner.emit('leaveRoom');
    await ownerLeaveDisconnect;
    const ownerLeaveMessage = await expectAgentRejected(URL, leaveInvite.token, 'owner leave consumed token');
    console.log('owner leave consumed token rejected:', ownerLeaveMessage);

    const startOwner = await connectHuman(URL, trackRoom);
    startOwner.emit('setNick', 'StartOwner');
    startOwner.emit('createRoom', 'start token room');
    await waitForEvent(startOwner, 'joinedRoom', (room) => room && room.id, 'start room creation');
    const startInvite = await emitWithAck(startOwner, 'createAgentInvite', { nick: 'StartAI', char: 0 });
    startOwner.emit('startGame');
    await waitForEvent(startOwner, 'gameStart', () => true, 'start room game start');
    const startMessage = await expectAgentRejected(URL, startInvite.token, 'game-start token');
    console.log('game-start token rejected:', startMessage);

    console.log('PASS');
    cleanup();
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
})();
