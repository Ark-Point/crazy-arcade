'use strict';

const { test } = require('node:test');
const assert = require('assert');
const { createBenchmarkTracker } = require('../lib/agent/benchmark');

test('benchmark tracker scores legality, recovery, naturalism, policy, and generalization tracks', () => {
  const tracker = createBenchmarkTracker();
  tracker.record({ type: 'action.accepted', actionType: 'move', policy: { phase: 'survive', selectedHeuristicId: 'survival-veto' } });
  tracker.record({ type: 'action.rejected', reason: 'invalid_action' });
  tracker.record({ type: 'fallback.used' });
  tracker.record({ type: 'reconnect.succeeded', latencyMs: 42 });
  tracker.record({ type: 'recovery.succeeded', recovery: 'trapped' });
  tracker.record({ type: 'reaction', ms: 220 });
  tracker.record({ type: 'policy.selected', expected: 'survival-veto', actual: 'survival-veto' });
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
  assert.strictEqual(summary.tracks.generalization.uniqueSeeds, 2);
});

