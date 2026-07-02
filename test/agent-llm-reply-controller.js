'use strict';

const assert = require('assert');
const { createLlmReplyController } = require('../lib/agent/llm-reply-controller');

function observation(tick) {
  return {
    status: { canAct: true, tick, reason: 'ready_for_action' },
    state: {
      t: tick,
      grid: Array.from({ length: 13 }, () => Array(15).fill(0)),
      players: [
        {
          id: 'agent-1',
          x: 60,
          y: 60,
          alive: true,
          trapped: false,
          maxBombs: 1,
          power: 2,
          needles: 1,
          inventory: { shield: 0, oxygen: 0, glove: 0, trap: 0 },
        },
      ],
      bombs: [],
      streams: [],
      items: [],
      hazards: [],
      telegraphs: [],
    },
    playerId: 'agent-1',
    self: {
      id: 'agent-1',
      x: 60,
      y: 60,
      alive: true,
      trapped: false,
      maxBombs: 1,
      power: 2,
      needles: 1,
      inventory: { shield: 0, oxygen: 0, glove: 0, trap: 0 },
    },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  const resolvers = [];
  const decisions = [];
  const controller = createLlmReplyController({
    replyProvider: {
      request(seed) {
        return new Promise((resolve) => {
          resolvers.push({ seed, resolve });
        });
      },
    },
    pacerOptions: { decisionTicks: 1, trapReactionTicks: 1 },
    onDecision(decision) {
      decisions.push(decision);
    },
  });

  controller.observe(observation(100));
  assert.strictEqual(decisions.length, 0, 'observe should not emit an action before an LLM reply');
  assert.strictEqual(resolvers.length, 1, 'first playable observation should start one LLM request');
  controller.observe(observation(104));
  resolvers[0].resolve({
    id: 'reply-unit-1',
    heuristicId: 'fallback-move',
    action: { type: 'placeBomb' },
    overview: 'unit reply selected fallback heuristic',
  });
  await flush();

  assert.strictEqual(decisions.length, 1, 'LLM reply should emit exactly one decision');
  assert.notStrictEqual(decisions[0].action.type, 'placeBomb', 'reply action should be ignored; only heuristicId is executable');
  assert.strictEqual(decisions[0].action.seq, 1, 'reply action should receive an agent sequence');
  assert.strictEqual(decisions[0].policy.decisionSource, 'llm-reply', 'policy should mark LLM reply source');
  assert.strictEqual(decisions[0].policy.llmReplyId, 'reply-unit-1', 'policy should preserve reply id');
  assert.strictEqual(decisions[0].policy.selectedHeuristicId, 'fallback-move', 'policy should preserve selected heuristic');
  assert.strictEqual(decisions[0].policy.decisionTick, 104, 'decision tick should use freshest observation at reply time');
  assert(decisions[0].policy.lastAction, 'policy should expose the executable action for live AI feedback');
  assert.strictEqual(decisions[0].policy.lastAction.seq, decisions[0].action.seq, 'policy action snapshot should match emitted action seq');
  assert.strictEqual(decisions[0].policy.lastAction.type, decisions[0].action.type, 'policy action snapshot should match emitted action type');
  assert(resolvers.length >= 2, 'controller should request the next reply after resolving one');
  controller.close();

  const inactiveResolvers = [];
  const inactiveDecisions = [];
  const inactiveController = createLlmReplyController({
    replyProvider: {
      request(seed) {
        return new Promise((resolve) => {
          inactiveResolvers.push({ seed, resolve });
        });
      },
    },
    onDecision(decision) {
      inactiveDecisions.push(decision);
    },
  });
  inactiveController.observe(observation(200));
  assert.strictEqual(inactiveResolvers.length, 1, 'playable observation should start one late-reply request');
  inactiveController.observeStatus({ canAct: false, phase: 'waiting', reason: 'game_is_not_active' });
  inactiveResolvers[0].resolve({ id: 'late-reply', heuristicId: 'fallback-move' });
  await flush();
  assert.strictEqual(inactiveDecisions.length, 0, 'late reply must not emit an action after inactive status');
  assert.strictEqual(inactiveResolvers.length, 1, 'inactive status must not start another LLM request');
  inactiveController.close();

  const sequenceResolvers = [];
  const sequenceDecisions = [];
  const sequenceController = createLlmReplyController({
    replyProvider: {
      request(seed) {
        return new Promise((resolve) => {
          sequenceResolvers.push({ seed, resolve });
        });
      },
    },
    onDecision(decision) {
      sequenceDecisions.push(decision);
    },
  });
  sequenceController.observe(observation(300));
  sequenceResolvers[0].resolve({ id: 'sequence-reply', heuristicId: 'fallback-move' });
  await flush();
  assert.strictEqual(sequenceDecisions.length, 1, 'first LLM reply should emit the first sequence action');
  assert(sequenceResolvers.length >= 2, 'controller should start the next LLM request after first reply');
  sequenceController.observe(observation(304));
  assert(sequenceDecisions.length >= 2, 'active movement sequence should emit between LLM replies');
  assert.strictEqual(sequenceDecisions[1].policy.llmReplyId, 'sequence-reply', 'between-reply sequence action should use the active reply');
  assert(sequenceDecisions[1].policy.sequencePlan, 'between-reply sequence action should expose the active sequence plan');
  assert.strictEqual(sequenceDecisions[1].policy.sequencePlan.kind, 'safe-fallback', 'fallback sequence should publish baseline plan kind');
  assert(sequenceDecisions[1].policy.lastAction, 'between-reply sequence policy should expose the executable action');
  sequenceController.close();

  console.log('PASS agent LLM reply controller tests');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
