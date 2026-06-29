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
  waitForEvent,
  emitWithAck,
  statePlayer,
} = require('./helpers/agent-harness');

let url;

before(async () => {
  url = resolveUrl() || (await startServer()).url;
});

after(() => {
  stopServer();
  closeAll();
});

test('spectator host can start an AI-only room and receive game state without being a player', async () => {
  const host = await connectHuman(url);
  host.emit('setNick', 'SpectatorHost');

  const joinedPromise = waitForEvent(
    host,
    'joinedRoom',
    (room) => room && room.host === host.id && room.players.length === 1,
    'normal room creation'
  );
  host.emit('createRoom', 'ai only arena');
  const room = await joinedPromise;
  assert(!room.spectators || room.spectators.length === 0, 'room creation should not make the host a spectator');

  const spectating = await emitWithAck(host, 'setSpectator', { spectator: true });
  assert(spectating && spectating.ok === true, `setSpectator should succeed: ${JSON.stringify(spectating)}`);
  assert(spectating.room.players.length === 0, 'host should leave playable slots after switching to spectator');
  assert(spectating.room.spectators.length === 1, 'host should occupy the spectator slot');
  assert(spectating.room.spectators[0].id === host.id, 'spectator slot should belong to the host');
  assert(spectating.room.host === host.id, 'host should keep room ownership while spectating');

  const invite = await emitWithAck(host, 'createAgentInvite', { nick: 'SoloAI', char: 1 });
  assert(invite && invite.token, 'spectator host should be able to create an agent invite');

  const agentJoined = waitForEvent(
    host,
    'roomUpdate',
    (updated) => updated && updated.players.some((p) => p.controller === 'agent') && updated.spectators.length === 1,
    'agent joined spectator-hosted room'
  );
  const agent = await connectAgent(url, invite.token, 'spectator-room-agent');
  const withAgent = await agentJoined;
  assert(withAgent.players.length === 1, 'room should contain exactly one playable AI slot');
  assert(withAgent.spectators.length === 1 && withAgent.spectators[0].id === host.id, 'host should remain a spectator');
  assert(!withAgent.players.some((p) => p.id === host.id), 'spectator host must not be listed as a playable slot');

  host.emit('startGame');
  const start = await waitForEvent(host, 'gameStart', (payload) => payload && Array.isArray(payload.players), 'AI-only gameStart');
  assert(start.players.length === 1, 'game roster should contain only the AI player');
  assert(start.players[0].controller === 'agent', 'only game player should be the agent');
  assert(!start.players.some((p) => p.id === host.id), 'spectator host must not be in gameStart roster');

  const state = await waitForEvent(host, 'state', (s) => s && s.countdown === 0, 'spectator host state stream', 8000);
  assert(!statePlayer(state, host.id), 'spectator host must not appear in authoritative state.players');
  assert(state.players.length === 1 && state.players[0].controller === 'agent', 'state should contain only the AI player');

  agent.close();
  host.close();
});
