'use strict';

const assert = require('assert');
const {
  constants,
  createHeuristicAgent,
  chooseAction,
  buildDangerMap,
  buildReachabilityMap,
  canSafelyPlaceBomb,
  HEURISTIC_POLICY_CARDS,
  HEURISTIC_POLICY_OVERVIEW,
  AGENT_ACTION_BUDGET_NOTE,
  createMovementSequencer,
  planMovementSequence,
} = require('../lib/agent/heuristics');

function emptyGrid() {
  return Array.from({ length: constants.ROWS }, () => Array(constants.COLS).fill(constants.TILE_EMPTY));
}

function selfAt(x, y, extras = {}) {
  return {
    id: 'agent-1',
    x: x * constants.TILE + constants.TILE / 2,
    y: y * constants.TILE + constants.TILE / 2,
    alive: true,
    trapped: false,
    power: 2,
    maxBombs: 1,
    needles: 1,
    inventory: { shield: 0, oxygen: 0, glove: 0, trap: 0 },
    ...extras,
  };
}

function observationAt(x, y, patch = {}) {
  const self = selfAt(x, y, patch.self || {});
  const state = {
    tick: 120,
    grid: emptyGrid(),
    players: [self],
    bombs: [],
    streams: [],
    items: [],
    hazards: [],
    telegraphs: [],
    ...patch.state,
  };
  return { roomId: 'room', playerId: self.id, self, state };
}

function addWalls(grid, cells) {
  for (const [x, y] of cells) grid[y][x] = constants.TILE_HARD;
  return grid;
}

function addSoft(grid, cells) {
  for (const [x, y] of cells) grid[y][x] = constants.TILE_SOFT;
  return grid;
}

function isMove(action, dir) {
  return action && action.type === 'move' && action.keys && action.keys[dir] === true;
}

assert.deepStrictEqual(chooseAction(null), { type: 'wait' }, 'malformed observation should wait');
assert.deepStrictEqual(chooseAction({ state: {} }), { type: 'wait' }, 'missing self should wait');

{
  const ids = new Set(HEURISTIC_POLICY_CARDS.map((card) => card.id));
  assert(ids.has('survival-veto'), 'policy cards should expose survival veto');
  assert(ids.has('safe-bomb-farm'), 'policy cards should expose safe bomb farming');
  assert(ids.has('action-envelope'), 'policy cards should expose server action envelope');
  assert(HEURISTIC_POLICY_OVERVIEW.includes('agentObservation'), 'policy overview should name observation source');
  assert(AGENT_ACTION_BUDGET_NOTE.includes('--max-actions'), 'budget note should document --max-actions');
  assert(AGENT_ACTION_BUDGET_NOTE.includes('서버'), 'budget note should clarify server semantics');
}

{
  const obs = observationAt(3, 3, {
    state: {
      bombs: [{ id: 1, x: 3, y: 3, t: 8, power: 2, pass: ['agent-1'] }],
    },
  });
  const danger = buildDangerMap(obs);
  assert.strictEqual(danger.dangerAt.get('3,3'), 8, 'bomb origin should be dangerous at fuse');
  assert.strictEqual(danger.dangerAt.get('5,3'), 8, 'blast ray should include power cells');
  const reachability = buildReachabilityMap(obs, danger);
  assert(reachability.nearestSafeExit, 'reachability should find an escape from a passable bomb');
}

{
  const obs = observationAt(3, 3, {
    state: {
      bombs: [{ id: 1, x: 3, y: 3, t: 12, power: 3, pass: ['agent-1'] }],
    },
  });
  const action = chooseAction(obs, {});
  assert(action.type === 'move', `imminent blast should choose move, got ${JSON.stringify(action)}`);
}

{
  const grid = addWalls(emptyGrid(), [[2, 3], [4, 3], [3, 2], [3, 4]]);
  const obs = observationAt(3, 3, { state: { grid } });
  const details = canSafelyPlaceBomb(obs, { details: true });
  assert.strictEqual(details.ok, false, 'surrounded self-bomb should be rejected');
  assert.strictEqual(details.reason, 'no-safe-exit', 'surrounded self-bomb should fail by no-safe-exit');
}

{
  const grid = addSoft(emptyGrid(), [[5, 3]]);
  const obs = observationAt(3, 3, { state: { grid } });
  assert.strictEqual(canSafelyPlaceBomb(obs), true, 'open area self-bomb should have escape');
  const action = chooseAction(obs, {});
  assert.strictEqual(action.type, 'placeBomb', `safe soft-block farm should place bomb, got ${JSON.stringify(action)}`);
}

{
  const grid = addSoft(emptyGrid(), [[5, 3]]);
  const obs = observationAt(3, 3, {
    state: {
      grid,
      bombs: [{ id: 99, x: 10, y: 10, t: 60, power: 1, pass: [] }],
    },
  });
  const details = canSafelyPlaceBomb(obs, { details: true });
  assert.strictEqual(details.ok, false, 'maxBombs=1 should conservatively reject bombing while a bomb is active');
  assert.strictEqual(details.reason, 'capacity', 'active bomb rejection should explain capacity');
  const action = chooseAction(obs, {});
  assert.notStrictEqual(action.type, 'placeBomb', 'agent should not place a second bomb while at conservative capacity');
}

{
  const obs = observationAt(1, 1, {
    state: {
      items: [{ x: 2, y: 1, type: 'needle' }],
    },
  });
  const action = chooseAction(obs, {});
  assert(isMove(action, 'right'), `safe adjacent item should move right, got ${JSON.stringify(action)}`);
}

{
  const obs = observationAt(1, 1, { self: { trapped: true, needles: 1 } });
  assert.strictEqual(chooseAction(obs, {}).type, 'useNeedle', 'trapped agent with needle should useNeedle');
}

{
  const grid = addSoft(emptyGrid(), [[1, 3]]);
  const bot = createHeuristicAgent();
  const action = bot.chooseActionForHeuristic(observationAt(1, 1, { state: { grid } }), 'fallback-move');
  assert(isMove(action, 'down'), `fallback should route toward nearby farming opportunity, got ${JSON.stringify(action)}`);
}

{
  const sequencer = createMovementSequencer();
  const obs = observationAt(1, 1, {
    state: {
      items: [{ x: 1, y: 3, type: 'needle' }],
    },
  });
  const desired = { type: 'move', keys: { up: false, down: true, left: false, right: false } };
  const first = sequencer.nextAction(obs, desired, 'item-value');
  const second = sequencer.nextAction(obs, desired, 'item-value');
  assert(isMove(first, 'down'), `sequence should start toward item target, got ${JSON.stringify(first)}`);
  assert(isMove(second, 'down'), `sequence should keep moving while still inside the same cell, got ${JSON.stringify(second)}`);
}

{
  const sequencer = createMovementSequencer();
  const itemObs = observationAt(1, 1, {
    state: {
      items: [{ x: 1, y: 4, type: 'needle' }],
    },
  });
  const pressureObs = observationAt(1, 1, {
    state: {
      players: [
        selfAt(1, 1),
        selfAt(3, 1, { id: 'opponent-1', needles: 0 }),
      ],
    },
  });
  const down = { type: 'move', keys: { up: false, down: true, left: false, right: false } };
  const right = { type: 'move', keys: { up: false, down: false, left: false, right: true } };
  const first = sequencer.nextAction(itemObs, down, 'item-value');
  const second = sequencer.nextAction(pressureObs, right, 'pressure-trap');
  assert(isMove(first, 'down'), `item sequence should start downward, got ${JSON.stringify(first)}`);
  assert(isMove(second, 'right'), `changed heuristic should replace stale sequence, got ${JSON.stringify(second)}`);
  assert.strictEqual(sequencer.currentPlan().heuristicId, 'pressure-trap', 'current plan should match the latest heuristic');
}

{
  const obs = observationAt(1, 1, {
    state: {
      items: [{ x: 1, y: 4, type: 'needle' }],
    },
  });
  const plan = planMovementSequence(obs, 'item-value');
  assert(plan, 'item-value should expose a sequence plan');
  assert.strictEqual(plan.kind, 'item-route', 'item route should publish its baseline plan kind');
  assert.strictEqual(plan.objective, 'collect_item', 'item route should publish the sequence objective');
  assert(plan.interrupts.includes('danger_threshold'), 'sequence plan should publish danger interrupt rules');
  assert(plan.target && plan.target.type === 'item', 'sequence target should include item metadata');
}

{
  const obs = observationAt(1, 1, {
    state: {
      items: [{ x: 1, y: 7, type: 'needle' }],
    },
  });
  const plan = planMovementSequence(obs, 'item-value');
  assert(plan, 'item-value should create a scored 6-12 tick sequence plan');
  assert(plan.horizonTicks >= 6 && plan.horizonTicks <= 12, `sequence horizon should be 6-12 ticks, got ${plan.horizonTicks}`);
  assert(plan.scoreBreakdown, 'sequence plan should expose scoring breakdown');
  assert(plan.scoreBreakdown.survival > 0, 'sequence scoring should include survival');
  assert(plan.scoreBreakdown.farm > 0, 'item route should score farm/item value');
  assert.strictEqual(plan.target.itemType, 'needle', 'sequence scoring should preserve chosen item target');
}

{
  const obs = observationAt(1, 1, {
    state: {
      bombs: [{ id: 'danger-item-bomb', x: 2, y: 1, t: 4, power: 2, pass: [] }],
      items: [{ x: 3, y: 1, type: 'angel' }],
    },
  });
  const plan = planMovementSequence(obs, 'item-value');
  assert(plan, 'unsafe item route should fall back to a safe scored sequence');
  const pathKeys = new Set(plan.path.map((cell) => `${cell.x},${cell.y}`));
  assert(!pathKeys.has('3,1'), 'sequence planner should reject a high-value item inside imminent blast');
  assert(plan.scoreBreakdown.survival > plan.scoreBreakdown.farm, 'survival should dominate unsafe farm value');
}

{
  const grid = addSoft(emptyGrid(), [[1, 5], [2, 5], [3, 5]]);
  const obs = observationAt(1, 1, { state: { grid } });
  const plan = planMovementSequence(obs, 'fallback-move');
  assert(plan, 'fallback should create a scored exploration sequence');
  assert.strictEqual(plan.kind, 'safe-fallback', 'fallback should preserve baseline plan kind');
  assert(plan.scoreBreakdown.farm > 0, 'fallback sequence should reward routes that approach farmable soft blocks');
  assert(plan.scoreBreakdown.position > 0, 'fallback sequence should include position/mobility score');
}

{
  const obs = observationAt(5, 5, {
    state: {
      players: [
        selfAt(5, 5),
        selfAt(7, 5, { id: 'opponent-1', needles: 0 }),
      ],
    },
  });
  const plan = planMovementSequence(obs, 'pressure-trap');
  assert(plan, 'pressure-trap should create an opponent pressure plan');
  assert.strictEqual(plan.kind, 'opponent-pressure', 'pressure plan should publish its baseline plan kind');
  assert.strictEqual(plan.objective, 'cut_escape_lane', 'pressure plan should target escape-lane denial');
  assert(plan.target && plan.target.playerId === 'opponent-1', 'pressure target should identify the opponent');
}

{
  const bot = createHeuristicAgent();
  const first = bot.nextAction(observationAt(1, 1));
  const second = bot.nextAction(observationAt(1, 1));
  assert.strictEqual(first.seq, 1, 'first bot action seq should be 1');
  assert.strictEqual(second.seq, 2, 'second bot action seq should be 2');
}

{
  const bot = createHeuristicAgent();
  const obs = observationAt(1, 1, {
    state: {
      items: [{ x: 2, y: 1, type: 'needle' }],
    },
  });
  bot.nextAction(obs);
  const policy = bot.policySnapshot();
  assert.strictEqual(policy.schema, 'crazay-arkade-agent-runtime-policy.v1', 'bot should expose runtime policy schema');
  assert(policy.cards.some((card) => card.id === 'runtime-item-route'), 'bot should generate an item-route heuristic card');
  assert(policy.cards.some((card) => card.kind === 'enforce'), 'bot should include runtime enforcement cards');
}

console.log('PASS agent heuristic unit tests');
