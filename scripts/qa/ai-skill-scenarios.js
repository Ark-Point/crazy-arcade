'use strict';

const {
  constants,
  createHeuristicAgent,
  chooseAction,
} = require('../../lib/agent/heuristics');
const { createBenchmarkTracker } = require('../../lib/agent/benchmark');
const { localHeuristicId } = require('../../examples/llm-reply-agent');

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
    activeBombs: 0,
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
  return { roomId: 'qa-room', playerId: self.id, self, state };
}

function isMove(action, dir) {
  return action && action.type === 'move' && action.keys && action.keys[dir] === true;
}

function benchmarkOutcomeSummary() {
  const tracker = createBenchmarkTracker();
  tracker.record({ type: 'match.finished', result: 'win', survivalTicks: 120, reason: 'elimination' });
  tracker.record({ type: 'match.finished', result: 'loss', survivalTicks: 80, reason: 'stream', deathReason: 'stream' });
  tracker.record({ type: 'match.finished', result: 'tie', survivalTicks: 100, reason: 'timeout' });
  return tracker.summary().tracks.outcome;
}

function run() {
  const pressureBot = createHeuristicAgent();
  const pressureApproach = pressureBot.chooseAction(observationAt(1, 1, {
    state: {
      players: [
        selfAt(1, 1),
        selfAt(5, 1, { id: 'opponent-1', needles: 0 }),
      ],
    },
  }));
  const pressureConversion = pressureBot.chooseAction(observationAt(3, 1, {
    state: {
      tick: 121,
      players: [
        selfAt(3, 1),
        selfAt(5, 1, { id: 'opponent-1', needles: 0 }),
      ],
    },
  }));
  const freshRouteCommit = createHeuristicAgent().chooseActionForHeuristic(observationAt(4, 1, {
    state: {
      tick: 121,
      players: [
        selfAt(4, 1),
        selfAt(5, 1, { id: 'opponent-1', needles: 0 }),
      ],
    },
  }), 'route-commit');
  const pendingBot = createHeuristicAgent();
  pendingBot.chooseAction(observationAt(1, 1, {
    state: {
      players: [
        selfAt(1, 1),
        selfAt(5, 1, { id: 'opponent-1', needles: 0 }),
      ],
    },
  }));
  const pendingRouteCommit = pendingBot.chooseActionForHeuristic(observationAt(4, 1, {
    state: {
      tick: 121,
      players: [
        selfAt(4, 1),
        selfAt(5, 1, { id: 'opponent-1', needles: 0 }),
      ],
    },
  }), 'route-commit');

  const distantBombItem = observationAt(1, 1, {
    state: {
      bombs: [{ id: 'far-bomb', x: 10, y: 10, t: 60, power: 1, pass: [] }],
      items: [{ x: 2, y: 1, type: 'needle' }],
    },
  });
  const distantBombFarm = observationAt(3, 3, {
    state: {
      grid: (() => {
        const grid = emptyGrid();
        grid[3][5] = constants.TILE_SOFT;
        return grid;
      })(),
      bombs: [{ id: 'far-bomb', x: 10, y: 10, t: 60, power: 1, pass: [] }],
    },
  });
  const selfAtCapacity = observationAt(3, 3, {
    self: { activeBombs: 1 },
    state: {
      grid: (() => {
        const grid = emptyGrid();
        grid[3][5] = constants.TILE_SOFT;
        return grid;
      })(),
    },
  });
  const urgentBomb = observationAt(3, 3, {
    state: {
      bombs: [{ id: 'urgent-bomb', x: 3, y: 3, t: 8, power: 2, pass: ['agent-1'] }],
    },
  });
  const outcome = benchmarkOutcomeSummary();

  const checks = {
    pressureApproachStartsRight: isMove(pressureApproach, 'right'),
    pressureConvertsToBomb: pressureConversion.type === 'placeBomb',
    pendingPressureOverridesRouteCommit: freshRouteCommit.type !== 'placeBomb' && pendingRouteCommit.type === 'placeBomb',
    distantHazardAllowsItemSelector: localHeuristicId(distantBombItem) === 'item-value',
    distantHazardAllowsSafeFarm: localHeuristicId(distantBombFarm) === 'safe-bomb-farm' && chooseAction(distantBombFarm, {}).type === 'placeBomb',
    selfCapacityStillBlocksBomb: chooseAction(selfAtCapacity, {}).type !== 'placeBomb',
    urgentSelfDangerUsesSurvivalVeto: localHeuristicId(urgentBomb) === 'survival-veto',
    fallbackExecutorEscapesUrgentDanger: chooseAction(urgentBomb, {}).type === 'move',
    benchmarkTracksOutcome: outcome.matches === 3
      && outcome.wins === 1
      && outcome.losses === 1
      && outcome.ties === 1
      && outcome.avgSurvivalTicks === 100
      && outcome.deathReasons.stream === 1,
  };

  const payload = {
    schema: 'crazay-arkade-ai-skill-scenarios.v1',
    ok: Object.values(checks).every(Boolean),
    checks,
    observations: {
      pressureApproach,
      pressureConversion,
      freshRouteCommit,
      pendingRouteCommit,
      distantHazardSelector: localHeuristicId(distantBombItem),
      distantHazardFarmSelector: localHeuristicId(distantBombFarm),
      distantHazardFarmAction: chooseAction(distantBombFarm, {}),
      selfCapacityAction: chooseAction(selfAtCapacity, {}),
      urgentDangerSelector: localHeuristicId(urgentBomb),
      urgentDangerAction: chooseAction(urgentBomb, {}),
      outcome,
    },
    cleanup: {
      spawnedProcesses: 0,
      sockets: 0,
      note: 'CLI/data QA only; no runtime resources to tear down.',
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!payload.ok) process.exitCode = 1;
}

run();
