'use strict';

function emptyTracks() {
  return {
    legality: { accepted: 0, rejected: 0, fallbacks: 0, invalidRate: 0 },
    recovery: { reconnects: 0, recoveries: 0, avgReconnectLatencyMs: 0 },
    naturalism: { reactionSamples: 0, avgReactionMs: 0, humanLikeSamples: 0 },
    policy: { selections: 0, correctSelections: 0, accuracy: 0 },
    gameplay: {
      pressureOpportunities: 0,
      pressureActions: 0,
      pressureConversionRate: 0,
      bombOpportunities: 0,
      bombsPlaced: 0,
      bombConversionRate: 0,
    },
    outcome: {
      matches: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      survivalTicksTotal: 0,
      survivalTickSamples: 0,
      avgSurvivalTicks: 0,
      reasons: {},
      deathReasons: {},
    },
    generalization: { uniqueSeeds: 0, seeds: [] },
  };
}

function createBenchmarkTracker() {
  const tracks = emptyTracks();
  const reconnectLatencies = [];
  const reactionSamples = [];
  const seeds = new Set();

  function recompute() {
    const totalLegal = tracks.legality.accepted + tracks.legality.rejected;
    tracks.legality.invalidRate = totalLegal ? tracks.legality.rejected / totalLegal : 0;
    tracks.recovery.avgReconnectLatencyMs = reconnectLatencies.length
      ? reconnectLatencies.reduce((a, b) => a + b, 0) / reconnectLatencies.length
      : 0;
    tracks.naturalism.avgReactionMs = reactionSamples.length
      ? reactionSamples.reduce((a, b) => a + b, 0) / reactionSamples.length
      : 0;
    tracks.policy.accuracy = tracks.policy.selections
      ? tracks.policy.correctSelections / tracks.policy.selections
      : 0;
    tracks.gameplay.pressureConversionRate = tracks.gameplay.pressureOpportunities
      ? tracks.gameplay.pressureActions / tracks.gameplay.pressureOpportunities
      : 0;
    tracks.gameplay.bombConversionRate = tracks.gameplay.bombOpportunities
      ? tracks.gameplay.bombsPlaced / tracks.gameplay.bombOpportunities
      : 0;
    tracks.outcome.avgSurvivalTicks = tracks.outcome.survivalTickSamples
      ? tracks.outcome.survivalTicksTotal / tracks.outcome.survivalTickSamples
      : 0;
    tracks.generalization.uniqueSeeds = seeds.size;
    tracks.generalization.seeds = [...seeds].sort();
  }

  return {
    record(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'action.accepted') tracks.legality.accepted += 1;
      else if (event.type === 'action.rejected') tracks.legality.rejected += 1;
      else if (event.type === 'fallback.used') tracks.legality.fallbacks += 1;
      else if (event.type === 'reconnect.succeeded') {
        tracks.recovery.reconnects += 1;
        if (Number.isFinite(event.latencyMs)) reconnectLatencies.push(Math.max(0, event.latencyMs));
      } else if (event.type === 'recovery.succeeded') {
        tracks.recovery.recoveries += 1;
      } else if (event.type === 'reaction') {
        if (Number.isFinite(event.ms)) {
          reactionSamples.push(Math.max(0, event.ms));
          tracks.naturalism.reactionSamples += 1;
          if (event.ms >= 120 && event.ms <= 650) tracks.naturalism.humanLikeSamples += 1;
        }
      } else if (event.type === 'policy.selected') {
        tracks.policy.selections += 1;
        if (event.expected && event.actual && event.expected === event.actual) {
          tracks.policy.correctSelections += 1;
        }
      } else if (event.type === 'gameplay.pressureOpportunity') {
        tracks.gameplay.pressureOpportunities += 1;
      } else if (event.type === 'gameplay.pressureAction') {
        tracks.gameplay.pressureActions += 1;
      } else if (event.type === 'gameplay.bombOpportunity') {
        tracks.gameplay.bombOpportunities += 1;
      } else if (event.type === 'gameplay.bombPlaced') {
        tracks.gameplay.bombsPlaced += 1;
      } else if (event.type === 'match.finished') {
        tracks.outcome.matches += 1;
        if (event.result === 'win') tracks.outcome.wins += 1;
        else if (event.result === 'loss') tracks.outcome.losses += 1;
        else if (event.result === 'tie') tracks.outcome.ties += 1;
        if (Number.isFinite(event.survivalTicks)) {
          tracks.outcome.survivalTicksTotal += Math.max(0, event.survivalTicks);
          tracks.outcome.survivalTickSamples += 1;
        }
        if (event.reason) {
          const reason = String(event.reason);
          tracks.outcome.reasons[reason] = (tracks.outcome.reasons[reason] || 0) + 1;
        }
        if (event.deathReason) {
          const deathReason = String(event.deathReason);
          tracks.outcome.deathReasons[deathReason] = (tracks.outcome.deathReasons[deathReason] || 0) + 1;
        }
      } else if (event.type === 'generalization.seed' && event.seed) {
        seeds.add(String(event.seed));
      }
      recompute();
    },
    summary() {
      recompute();
      return {
        schema: 'crazay-arkade-agent-benchmark.v1',
        tracks: JSON.parse(JSON.stringify(tracks)),
      };
    },
  };
}

module.exports = {
  createBenchmarkTracker,
};
