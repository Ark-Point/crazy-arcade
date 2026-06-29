const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectSocket,
  waitForEvent,
  emitWithAck,
  emitRawAck,
  agentPlayers,
  statePlayer,
} = require('./helpers/agent-harness');

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
  setTimeout(() => fail('test timed out'), 20000).unref();

  try {
    // URL 미지정 시 self-spawn, 지정 시 외부 서버 사용.
    const URL = resolveUrl() || (await startServer()).url;

    const host = await connectSocket(URL, 'host');
    let latestRoom = null;
    host.on('roomUpdate', (updatedRoom) => {
      latestRoom = updatedRoom;
    });
    host.emit('setNick', 'AgentHost');
    host.emit('createRoom', 'agent happy path');
    const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'human room creation');
    latestRoom = room;
    console.log('created room', room.id);

    const invite = await emitWithAck(host, 'createAgentInvite', { nick: 'AgentAlpha', char: 1 });
    assert(invite && typeof invite.token === 'string' && invite.token.length >= 16, 'invite did not include a usable token');

    const roomWithAgentPromise = latestRoom && agentPlayers(latestRoom).length === 1
      ? Promise.resolve(latestRoom)
      : waitForEvent(
        host,
        'roomUpdate',
        (r) => r && r.id === room.id && agentPlayers(r).length === 1,
        'room update with one agent controller player'
      );
    const agent = await connectSocket(`${URL}/agent`, 'agent', { auth: { token: invite.token } });
    const roomWithAgent = await roomWithAgentPromise;
    const agentPlayer = agentPlayers(roomWithAgent)[0];
    assert(agentPlayer.nick === 'AgentAlpha', `agent nick was not preserved: ${agentPlayer.nick}`);

    host.emit('startGame');
    const observation = await waitForEvent(
      agent,
      'agentObservation',
      (payload) => payload && typeof payload === 'object',
      'agent observation',
      5000
    );
    assert(observation, 'agentObservation payload was empty');

    const firstState = await waitForEvent(
      agent,
      'state',
      (s) => s && s.countdown === 0 && statePlayer(s, agentPlayer.id),
      'agent state after countdown',
      7000
    );
    const start = statePlayer(firstState, agentPlayer.id);
    assert(typeof start.x === 'number', 'agent player had no numeric x position');

    let seq = 0;
    for (let i = 0; i < 12; i++) {
      seq++;
      const ack = await emitWithAck(agent, 'agentAction', { type: 'move', seq, keys: { left: true } });
      assert(ack && ack.ok === true && ack.seq === seq, `movement ack did not echo seq ${seq}`);
    }

    const movedState = await waitForEvent(
      agent,
      'state',
      (s) => {
        const p = statePlayer(s, agentPlayer.id);
        return p && p.seq >= seq && p.x < start.x;
      },
      'agent movement delta',
      4000
    );
    const moved = statePlayer(movedState, agentPlayer.id);
    console.log(`agent moved x ${start.x} -> ${moved.x}; seq ${seq}`);

    const staleAck = await emitRawAck(agent, 'agentAction', { type: 'move', seq, keys: { left: true } });
    assert(staleAck && staleAck.ok === false, 'stale agent action was not rejected');
    const oversizedAck = await emitRawAck(agent, 'agentAction', {
      type: 'move',
      seq: seq + 1,
      keys: { left: true },
      junk: 'x'.repeat(3000),
    });
    assert(oversizedAck && oversizedAck.ok === false, 'oversized agent action was not rejected');

    seq++;
    const bombAck = await emitWithAck(agent, 'agentAction', { type: 'placeBomb', seq });
    assert(bombAck && bombAck.ok === true && bombAck.seq === seq, `bomb ack did not echo seq ${seq}`);
    const bombState = await waitForEvent(
      agent,
      'state',
      (s) => s && Array.isArray(s.bombs) && s.bombs.length > 0,
      'agent bomb placement',
      4000
    );
    console.log(`agent state bombs: ${bombState.bombs.length}`);
    console.log('PASS');
    cleanup();
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
})();
