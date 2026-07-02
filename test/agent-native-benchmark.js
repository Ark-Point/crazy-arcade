'use strict';

const { test } = require('node:test');
const assert = require('assert');
const { createBenchmarkTracker } = require('../lib/agent/benchmark');

test('benchmark tracker scores legality, recovery, naturalism, policy, gameplay, and generalization tracks', () => {
  const tracker = createBenchmarkTracker();
  tracker.record({ type: 'action.accepted', actionType: 'move', policy: { phase: 'survive', selectedHeuristicId: 'survival-veto' } });
  tracker.record({ type: 'action.rejected', reason: 'invalid_action' });
  tracker.record({ type: 'fallback.used' });
  tracker.record({ type: 'reconnect.succeeded', latencyMs: 42 });
  tracker.record({ type: 'recovery.succeeded', recovery: 'trapped' });
  tracker.record({ type: 'reaction', ms: 220 });
  tracker.record({ type: 'policy.selected', expected: 'survival-veto', actual: 'survival-veto' });
  tracker.record({ type: 'gameplay.pressureOpportunity' });
  tracker.record({ type: 'gameplay.pressureAction' });
  tracker.record({ type: 'gameplay.bombOpportunity' });
  tracker.record({ type: 'gameplay.bombPlaced' });
  tracker.record({ type: 'generalization.seed', seed: 'map-a' });
  tracker.record({ type: 'generalization.seed', seed: 'map-b' });

  const summary = tracker.summary();
  assert.strictEqual(summary.schema, 'crazay-arkade-agent-benchmark.v1');
  assert.strictEqual(summary.tracks.legality.accepted, 1);
  assert.strictEqual(summary.tracks.legality.rejected, 1);
  assert.strictEqual(summary.tracks.legality.fallbacks, 1);
  assert.strictEqual(summary.tracks.recovery.reconnects, 1);
  assert.strictEqual(summary.tracks.recovery.recoveries, 1);
  assert.strictEqual(summary.tracks.naturalism.reactionSamples, 1);
  assert.strictEqual(summary.tracks.policy.correctSelections, 1);
  assert.strictEqual(summary.tracks.gameplay.pressureConversionRate, 1);
  assert.strictEqual(summary.tracks.gameplay.bombConversionRate, 1);
  assert.strictEqual(summary.tracks.generalization.uniqueSeeds, 2);
});

test('benchmark tracker records match outcome, survival ticks, and death reasons', () => {
  const tracker = createBenchmarkTracker();
  tracker.record({ type: 'match.finished', result: 'win', survivalTicks: 120, reason: 'elimination' });
  tracker.record({ type: 'match.finished', result: 'loss', survivalTicks: 80, reason: 'stream', deathReason: 'stream' });
  tracker.record({ type: 'match.finished', result: 'tie', survivalTicks: 100, reason: 'timeout' });
  tracker.record({ type: 'match.finished', result: 'tie', reason: 'missing-survival-sample' });

  const summary = tracker.summary();
  assert.strictEqual(summary.tracks.outcome.matches, 4);
  assert.strictEqual(summary.tracks.outcome.wins, 1);
  assert.strictEqual(summary.tracks.outcome.losses, 1);
  assert.strictEqual(summary.tracks.outcome.ties, 2);
  assert.strictEqual(summary.tracks.outcome.survivalTickSamples, 3);
  assert.strictEqual(summary.tracks.outcome.avgSurvivalTicks, 100);
  assert.deepStrictEqual(summary.tracks.outcome.reasons, { elimination: 1, stream: 1, timeout: 1, 'missing-survival-sample': 1 });
  assert.deepStrictEqual(summary.tracks.outcome.deathReasons, { stream: 1 });
});
