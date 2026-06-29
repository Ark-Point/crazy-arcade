'use strict';

const { test, before, after } = require('node:test');
const assert = require('assert');
const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  connectHuman,
  connectAgent,
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

test('agent observation exposes v2 policy contract, action mask, trace ids, and policy update v2 fields', async () => {
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    roomName: 'native-contract',
    invite: { nick: 'NativeAgent', char: 1 },
  });
  const agentJoined = waitForEvent(
    host,
    'roomUpdate',
    (room) => room && Array.isArray(room.players) && room.players.some((player) => player.controller === 'agent'),
    'native contract agent joined',
    5000
  );
  const agent = await connectAgent(url, invite.token, 'native-contract-agent');
  await agentJoined;

  const started = waitForEvent(host, 'gameStart', (payload) => payload && Array.isArray(payload.players), 'native contract gameStart', 3000);
  host.emit('startGame');
  await started;
  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (payload) => payload && payload.status && payload.status.canAct === true,
    'native v2 observation',
    8000
  );

  assert.strictEqual(obs.schema, 'crazay-arkade-agent-observation.v2');
  assert(obs.trace && Number.isSafeInteger(obs.trace.eventId), 'observation trace.eventId missing');
  assert.strictEqual(obs.policyContext && obs.policyContext.contractVersion, 2);
  assert(obs.valid_actions && Array.isArray(obs.valid_actions.move), 'valid_actions.move mask missing');
  assert('placeBomb' in obs.valid_actions, 'valid_actions.placeBomb missing');
  assert(obs.invalid_reasons && typeof obs.invalid_reasons === 'object', 'invalid_reasons missing');
  assert.deepStrictEqual(obs.status.validActions, obs.valid_actions, 'status should carry the same valid action mask values');

  const ack = await emitRawAck(agent, 'agentAction', { type: 'placeBomb', seq: 1 });
  assert(ack && ack.ok === true, `placeBomb should be accepted: ${JSON.stringify(ack)}`);
  assert(ack.trace && Number.isSafeInteger(ack.trace.eventId), 'accepted action ack trace missing');

  const originCell = { x: Math.floor(obs.self.x / 40), y: Math.floor(obs.self.y / 40) };
  const leaveDir = originCell.x > 0 ? 'left' : 'right';
  const returnDir = leaveDir === 'left' ? 'right' : 'left';
  const keys = { left: leaveDir === 'left', right: leaveDir === 'right', up: false, down: false };
  for (let i = 0; i < 8; i++) {
    const moveAck = await emitRawAck(agent, 'agentAction', { type: 'move', seq: 2 + i, keys });
    assert(moveAck && moveAck.ok === true, `move away from own bomb should be accepted: ${JSON.stringify(moveAck)}`);
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  const bombMaskObs = await waitForEvent(
    agent,
    'agentObservation',
    (payload) => {
      if (!payload || !payload.self || !payload.invalid_reasons) return false;
      const selfCell = { x: Math.floor(payload.self.x / 40), y: Math.floor(payload.self.y / 40) };
      return payload.state
        && Array.isArray(payload.state.bombs)
        && payload.state.bombs.some((bomb) => bomb.x === originCell.x && bomb.y === originCell.y)
        && (selfCell.x !== originCell.x || selfCell.y !== originCell.y);
    },
    'observation after leaving own bomb',
    3000
  );
  assert.strictEqual(
    bombMaskObs.invalid_reasons[`move:${returnDir}`],
    'blocked_by_bomb',
    `returning into own bomb should be masked as blocked_by_bomb: ${JSON.stringify(bombMaskObs.invalid_reasons)}`
  );
  assert(!bombMaskObs.valid_actions.move.includes(returnDir), `valid_actions should not include return direction ${returnDir}`);

  const seenPolicy = waitForEvent(
    host,
    'agentPolicyUpdate',
    (policy) => policy && policy.schema === 'crazay-arkade-agent-runtime-policy.v2',
    'runtime policy v2 relay',
    3000
  );
  const policyAck = await emitRawAck(agent, 'agentPolicyUpdate', {
    schema: 'crazay-arkade-agent-runtime-policy.v2',
    revision: 7,
    decisionSource: 'llm-reply',
    llmReplyId: 'reply-native-contract',
    decisionTick: obs.status.tick,
    generatedAtTick: obs.status.tick,
    phase: 'survive',
    intent: 'escape_immediate_blast',
    selectedHeuristicId: 'survival-veto',
    fallbackHeuristicId: 'fallback-move',
    risk: 'high',
    confidence: null,
    expectedHorizonTicks: 30,
    constraints: ['human_paced'],
    reason: 'contract test',
    sequencePlan: {
      heuristicId: 'survival-veto',
      kind: 'survival-escape',
      objective: 'reach_safe_cell',
      target: { type: 'safe-cell', x: 2, y: 3 },
      interrupts: ['danger_threshold', 'path_blocked'],
      remainingMoves: 4,
    },
    overview: 'v2 policy contract test',
    cards: [
      {
        id: 'native-contract-card',
        kind: 'enforce',
        priority: 1,
        title: '계약 테스트',
        summary: 'v2 정책 필드가 브라우저로 전달됩니다.',
        signals: ['phase:survive'],
        actions: ['execute:survival-veto'],
      },
    ],
  });
  assert(policyAck && policyAck.ok === true, `v2 policy should be accepted: ${JSON.stringify(policyAck)}`);
  const policy = await seenPolicy;
  assert.strictEqual(policy.phase, 'survive');
  assert.strictEqual(policy.intent, 'escape_immediate_blast');
  assert.strictEqual(policy.fallbackHeuristicId, 'fallback-move');
  assert(policy.sequencePlan && policy.sequencePlan.kind === 'survival-escape', 'sequence plan should be relayed');
  assert(policy.sequencePlan.target && policy.sequencePlan.target.type === 'safe-cell', 'sequence plan target should be sanitized and relayed');
  assert.strictEqual(policy.risk, 'high');
  assert.strictEqual(policy.confidence, null, 'missing confidence should remain null instead of becoming 0');
  assert(policy.trace && Number.isSafeInteger(policy.trace.eventId), 'policy trace missing');

  const oversizedPolicyAck = await emitRawAck(agent, 'agentPolicyUpdate', {
    schema: 'crazay-arkade-agent-runtime-policy.v2',
    revision: 8,
    decisionSource: 'llm-reply',
    llmReplyId: 'reply-oversized',
    selectedHeuristicId: 'fallback-move',
    overview: 'x'.repeat(5000),
    cards: [
      {
        id: 'oversized-card',
        kind: 'create',
        priority: 1,
        title: 'oversized',
        summary: 'x'.repeat(5000),
        signals: ['oversized'],
        actions: ['wait'],
      },
    ],
  });
  assert(oversizedPolicyAck && oversizedPolicyAck.ok === false, 'oversized policy update should be rejected');

  const burstAcks = [];
  for (let i = 0; i < 12; i++) {
    burstAcks.push(await emitRawAck(agent, 'agentPolicyUpdate', {
      schema: 'crazay-arkade-agent-runtime-policy.v2',
      revision: 20 + i,
      decisionSource: 'heuristic',
      selectedHeuristicId: 'fallback-move',
      phase: 'recover',
      intent: 'burst_rate_limit_probe',
      cards: [
        {
          id: `burst-${i}`,
          kind: 'create',
          priority: 1,
          title: 'burst',
          summary: 'burst policy update',
          signals: ['burst'],
          actions: ['wait'],
        },
      ],
    }));
  }
  assert(burstAcks.some((item) => item && item.ok === false && item.error === 'policy update rate limited'), 'policy update burst should be rate limited');
});
