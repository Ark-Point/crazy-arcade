'use strict';

const { test, before, after } = require('node:test');
const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  connectAgentReady,
  createRoomWithAgentInvite,
  waitForEvent,
  emitRawAck,
} = require('./helpers/agent-harness');

let url;

before(async () => {
  url = resolveUrl() || (await startServer()).url;
});

after(() => {
  closeAll();
  stopServer();
});

test('same-token reconnect resumes with trace cursor, missed events, recovery state, and action continuity', async () => {
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    roomName: 'native-reconnect',
    invite: { nick: 'ReconnectAgent', char: 2 },
  });
  const token = invite.token;
  const agentJoined = waitForEvent(
    host,
    'roomUpdate',
    (room) => room && Array.isArray(room.players) && room.players.some((player) => player.controller === 'agent'),
    'native reconnect agent joined',
    5000
  );
  const agent = await connectAgent(url, token, 'native-reconnect-agent');
  await agentJoined;

  const started = waitForEvent(host, 'gameStart', (payload) => payload && Array.isArray(payload.players), 'native reconnect gameStart', 3000);
  host.emit('startGame');
  await started;
  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (payload) => payload && payload.status && payload.status.canAct === true,
    'first active native observation',
    8000
  );
  const firstEventId = obs.trace && obs.trace.eventId;
  assert(Number.isSafeInteger(firstEventId), 'first observation trace cursor missing');

  const ack = await emitRawAck(agent, 'agentAction', { type: 'wait', seq: 1 });
  assert(ack && ack.ok === true && ack.trace, `wait ack should include trace: ${JSON.stringify(ack)}`);
  const ackEventId = ack.trace.eventId;
  const fallbackPolicy = waitForEvent(
    host,
    'agentPolicyUpdate',
    (policy) => policy && policy.source === 'fallbackBot' && policy.trace && policy.trace.eventId > ackEventId,
    'fallback bot policy while agent disconnected',
    5000
  );
  agent.disconnect();
  const disconnectedPolicy = await fallbackPolicy;

  const { agent: reconnected, ready } = await connectAgentReady(url, token, 'native-reconnect-agent-2');
  assert(ready && ready.resume && ready.resume.reconnected === true, 'agentReady resume metadata missing');
  assert(ready.resume.lastEventId >= disconnectedPolicy.trace.eventId, 'resume.lastEventId should cover disconnect-window policy event');
  assert(Array.isArray(ready.resume.missedEvents), 'resume.missedEvents missing');
  assert(ready.resume.recovery && ready.resume.recovery.mode, 'resume recovery state missing');

  const resumedObs = await waitForEvent(
    reconnected,
    'agentObservation',
    (payload) => payload && payload.resume && payload.resume.reconnected === true,
    'resumed observation metadata',
    5000
  );
  assert(resumedObs.trace.eventId >= ready.resume.lastEventId, 'resumed observation trace should advance');
  assert(
    !resumedObs.resume.missedEvents.some((event) => event.eventId === ackEventId),
    'already-acknowledged pre-disconnect action should not be replayed as missed'
  );
  assert(
    resumedObs.resume.missedEvents.some((event) => event.eventId === disconnectedPolicy.trace.eventId && event.type === 'agent.policy.selected'),
    'disconnect-window fallback policy event should be replayed'
  );

  const nextAck = await emitRawAck(reconnected, 'agentAction', { type: 'wait' });
  assert(nextAck && nextAck.ok === true, `post-reconnect action failed: ${JSON.stringify(nextAck)}`);
  assert(nextAck.seq > 1, 'server-assigned seq should continue after reconnect');
});
