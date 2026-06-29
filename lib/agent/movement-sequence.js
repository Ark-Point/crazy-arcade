'use strict';

const {
  DIRECTIONS,
  actionForMove,
  cellKey,
  moveFromAction,
  normalizeObservation,
  playerCell,
} = require('./heuristic-state');
const { buildDangerMap, buildReachabilityMap } = require('./heuristic-danger');
const { selectBaselinePlan } = require('./baseline-sequences');

const SEQUENCE_MAX_STEPS = 12;

function createMovementSequencer(options = {}) {
  const maxSteps = positiveInteger(options.maxSteps, SEQUENCE_MAX_STEPS);
  let sequence = null;

  return {
    nextAction(observation, desiredAction, heuristicId) {
      const status = observation && observation.status;
      if (status && status.canAct === false) {
        sequence = null;
        return null;
      }
      if (!isMove(desiredAction)) {
        sequence = null;
        return desiredAction || null;
      }
      const normalized = normalizeObservation(observation);
      if (!normalized.ok) return desiredAction;
      const { state, self } = normalized;
      const current = playerCell(self, state);
      if (!current) return desiredAction;
      if (sequence && sequence.heuristicId !== heuristicId) sequence = null;

      const continued = continueSequence(sequence, observation, current);
      if (continued) {
        sequence = continued.sequence;
        return actionForMove(continued.move);
      }

      const planned = planMovementSequence(observation, heuristicId, maxSteps);
      if (!planned || planned.moves.length === 0) {
        sequence = null;
        return desiredAction;
      }
      sequence = planned;
      return actionForMove(planned.moves[0]);
    },

    reset() {
      sequence = null;
    },

    currentPlan() {
      if (!sequence) return null;
      return {
        heuristicId: sequence.heuristicId,
        kind: sequence.kind,
        objective: sequence.objective,
        target: sequence.target,
        interrupts: Array.isArray(sequence.interrupts) ? [...sequence.interrupts] : [],
        remainingMoves: Math.max(0, sequence.moves.length - sequence.index),
        horizonTicks: sequence.horizonTicks || sequence.moves.length,
        score: Number.isFinite(sequence.score) ? sequence.score : null,
        scoreBreakdown: sequence.scoreBreakdown ? { ...sequence.scoreBreakdown } : null,
      };
    },
  };
}

function planMovementSequence(observation, heuristicId, maxSteps) {
  const boundedMaxSteps = positiveInteger(maxSteps, SEQUENCE_MAX_STEPS);
  const normalized = normalizeObservation(observation);
  if (!normalized.ok) return null;
  const danger = buildDangerMap(observation);
  const reachability = buildReachabilityMap(observation, danger);
  reachability.danger = danger;
  const baseline = selectBaselinePlan(normalized, reachability, heuristicId, { maxDepth: boundedMaxSteps });
  if (!baseline || !baseline.node) return null;
  const path = Array.isArray(baseline.path)
    ? baseline.path.slice(0, boundedMaxSteps)
    : reachability.pathTo(cellKey(baseline.node.x, baseline.node.y)).slice(1, boundedMaxSteps + 1);
  const moves = Array.isArray(baseline.moves)
    ? baseline.moves.slice(0, boundedMaxSteps)
    : movesFromPath(reachability.start, path);
  if (moves.length === 0) return null;
  return {
    heuristicId,
    kind: baseline.kind,
    objective: baseline.objective,
    target: baseline.target,
    interrupts: [...baseline.interrupts],
    score: Number.isFinite(baseline.score) ? baseline.score : null,
    scoreBreakdown: baseline.scoreBreakdown ? { ...baseline.scoreBreakdown } : null,
    horizonTicks: baseline.horizonTicks || moves.length,
    path,
    moves,
    index: 0,
  };
}

function continueSequence(sequence, observation, current) {
  if (!sequence || !Array.isArray(sequence.path) || sequence.path.length === 0) return null;
  let index = sequence.index;
  while (index < sequence.path.length && sameCell(current, sequence.path[index])) index += 1;
  if (index >= sequence.path.length) return null;
  const nextCell = sequence.path[index];
  if (Math.abs(nextCell.x - current.x) + Math.abs(nextCell.y - current.y) !== 1) return null;
  const danger = buildDangerMap(observation);
  const reachability = buildReachabilityMap(observation, danger);
  const reachable = reachability.reachable.get(cellKey(nextCell.x, nextCell.y));
  if (!reachable || !reachable.safe) return null;
  const move = moveBetween(current, nextCell);
  if (!move) return null;
  return { move, sequence: { ...sequence, index } };
}

function movesFromPath(start, path) {
  const moves = [];
  let current = start;
  for (const cell of path) {
    const move = moveBetween(current, cell);
    if (!move) return [];
    moves.push(move);
    current = cell;
  }
  return moves;
}

function moveBetween(from, to) {
  const dir = DIRECTIONS.find((candidate) => from.x + candidate.dx === to.x && from.y + candidate.dy === to.y);
  return dir ? dir.name : null;
}

function isMove(action) {
  return !!moveFromAction(action);
}

function sameCell(left, right) {
  return !!left && !!right && left.x === right.x && left.y === right.y;
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

module.exports = {
  createMovementSequencer,
  planMovementSequence,
};
