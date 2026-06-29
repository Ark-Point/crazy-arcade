'use strict';

function emptyTracks() {
  return {
    legality: { accepted: 0, rejected: 0, fallbacks: 0, invalidRate: 0 },
    recovery: { reconnects: 0, recoveries: 0, avgReconnectLatencyMs: 0 },
    naturalism: { reactionSamples: 0, avgReactionMs: 0, humanLikeSamples: 0 },
    policy: { selections: 0, correctSelections: 0, accuracy: 0 },
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

