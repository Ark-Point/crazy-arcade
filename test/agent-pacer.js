'use strict';

const assert = require('assert');
const { createActionPacer } = require('../lib/agent/action-pacer');

function observation(tick, patch = {}) {
  return {
    status: {
      canAct: true,
      tick,
      reason: 'ready_for_action',
      ...(patch.status || {}),
    },
  };
}

{
  const pacer = createActionPacer({ decisionTicks: 6, trapReactionTicks: 9 });
  const up = { type: 'move', keys: { up: true } };
  const down = { type: 'move', keys: { down: true } };
  assert.deepStrictEqual(pacer.nextAction(observation(100), up), up, 'first ready observation should be actionable');
  assert.strictEqual(pacer.nextAction(observation(101), down), null, 'held movement should not emit on every tick');
  assert.deepStrictEqual(pacer.nextAction(observation(102), down), up, 'held movement should continue below cadence');
  assert.deepStrictEqual(pacer.nextAction(observation(105), down), up, 'held movement should continue below cadence');
  assert.deepStrictEqual(pacer.nextAction(observation(106), down), down, 'new movement decision should resume at cadence');
}

{
  const pacer = createActionPacer({ decisionTicks: 6, trapReactionTicks: 9 });
  const trapped = observation(300, { status: { reason: 'trapped_agent_can_use_escape_action' } });
  const needle = { type: 'useNeedle' };
  assert.strictEqual(pacer.nextAction(trapped, needle), null, 'trap recovery should wait for human reaction delay');
  assert.strictEqual(pacer.nextAction(observation(308, { status: { reason: 'trapped_agent_can_use_escape_action' } }), needle), null, 'trap recovery should not fire before trap reaction ticks');
  assert.deepStrictEqual(pacer.nextAction(observation(309, { status: { reason: 'trapped_agent_can_use_escape_action' } }), needle), needle, 'trap recovery should fire after trap reaction ticks');
  assert.strictEqual(pacer.nextAction(observation(310, { status: { reason: 'trapped_agent_can_use_escape_action' } }), needle), null, 'trap recovery should keep recovery actions on a reaction cadence');
}

{
  const pacer = createActionPacer({ decisionTicks: 6, trapReactionTicks: 9 });
  const wait = { type: 'wait' };
  assert.strictEqual(pacer.nextAction(observation(400, { status: { reason: 'trapped_agent_can_use_escape_action' } }), wait), null, 'trapped wait should not be emitted');
  assert.strictEqual(pacer.nextAction(observation(409, { status: { reason: 'trapped_agent_can_use_escape_action' } }), wait), null, 'trapped wait should stay local after reaction delay');
  assert.strictEqual(pacer.nextAction(observation(418, { status: { reason: 'trapped_agent_can_use_escape_action' } }), wait), null, 'trapped wait should not become a per-tick server action');
}

console.log('PASS agent pacer tests');
