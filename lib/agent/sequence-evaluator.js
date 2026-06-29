'use strict';

const {
  constants,
  DIRECTIONS,
  ITEM_VALUE,
  cellKey,
  dimensions,
  entityCell,
  hasNumber,
  tileAt,
  playerCell,
} = require('./heuristic-state');
const {
  blastCellsForBomb,
  canUseCellSafely,
  normalizeBombs,
} = require('./heuristic-danger');

const DEFAULT_MIN_DEPTH = 6;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_BEAM_WIDTH = 96;

function selectScoredSequencePlan(normalized, reachability, heuristicId, options = {}) {
  const start = reachability && reachability.start;
  if (!normalized || !normalized.ok || !start) return null;
  const { state, self } = normalized;
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const minDepth = Math.min(maxDepth, positiveInteger(options.minDepth, DEFAULT_MIN_DEPTH));
  const beamWidth = positiveInteger(options.beamWidth, DEFAULT_BEAM_WIDTH);
  const context = makeContext(state, self, reachability, heuristicId);
  let beam = [makeSeed(start)];
  const finished = [];

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const expanded = [];
    for (const candidate of beam) {
      for (const dir of DIRECTIONS) {
        const next = extendCandidate(candidate, dir, depth, context);
        if (next) expanded.push(next);
      }
    }
    if (!expanded.length) break;
    expanded.sort(compareCandidates);
    beam = diversified(expanded, beamWidth);
    if (depth >= minDepth) finished.push(...beam.slice(0, beamWidth));
  }

  if (!finished.length) return null;
  finished.sort(compareCandidates);
  return makePlan(finished[0], context, heuristicId);
}

function makeContext(state, self, reachability, heuristicId) {
  const size = dimensions(state);
  const center = { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) };
  return {
    state,
    self,
    reachability,
    heuristicId,
    center,
    bombs: normalizeBombs(state, self),
    items: indexedItems(state),
    opponents: indexedOpponents(state, self),
    weights: weightsFor(heuristicId),
  };
}

function extendCandidate(candidate, dir, depth, context) {
  const cell = { x: candidate.x + dir.dx, y: candidate.y + dir.dy };
  if (!isWalkable(context, cell.x, cell.y)) return null;
  const key = cellKey(cell.x, cell.y);
  const reachable = context.reachability.reachable.get(key);
  if (!reachable || !reachable.safe || !cellSafeAt(context, cell.x, cell.y, depth)) return null;

  const visited = new Map(candidate.visited);
  visited.set(key, (visited.get(key) || 0) + 1);
  const collected = new Set(candidate.collected);
  const step = scoreStep(context, cell, depth, candidate, dir, collected, visited);
  const breakdown = addBreakdown(candidate.breakdown, step.breakdown);
  const score = totalScore(breakdown, context.weights);
  const target = step.target || candidate.target;
  return {
    x: cell.x,
    y: cell.y,
    path: [...candidate.path, cell],
    moves: [...candidate.moves, dir.name],
    visited,
    collected,
    target,
    breakdown,
    score,
    rankScore: rankScore(score, context, cell, target, depth),
  };
}

function scoreStep(context, cell, depth, candidate, dir, collected, visited) {
  const mobility = openNeighborCount(context.state, cell.x, cell.y);
  const revisit = Math.max(0, (visited.get(cellKey(cell.x, cell.y)) || 1) - 1);
  const reverse = candidate.moves.length && opposite(candidate.moves[candidate.moves.length - 1]) === dir.name ? 1 : 0;
  const item = itemAt(context.items, cell.x, cell.y, collected);
  let target = null;
  let farm = farmScore(context, cell, depth);
  if (item) {
    collected.add(item.key);
    farm += (ITEM_VALUE[item.item.type] || 10) / 4;
    target = { type: 'item', itemType: item.item.type || 'unknown', x: cell.x, y: cell.y };
  }
  const trap = trapScore(context, cell);
  const position = mobility * 1.8 + centerScore(context.center, cell) - revisit * 3 - reverse * 1.5;
  return {
    target,
    breakdown: {
      survival: 10 + mobility * 2 + futureSafetyScore(context, cell, depth),
      trap,
      farm,
      position,
    },
  };
}

function farmScore(context, cell, depth) {
  const soft = adjacentSoftBlocks(context.state, cell.x, cell.y);
  const blastSoft = softBlocksInBlast(context, cell);
  const speed = Math.max(0, DEFAULT_MAX_DEPTH - depth);
  return soft * 4 + blastSoft * 7 + speed * 0.2;
}

function trapScore(context, cell) {
  let best = 0;
  for (const opponent of context.opponents) {
    const distance = Math.abs(cell.x - opponent.x) + Math.abs(cell.y - opponent.y);
    const exits = openNeighborCount(context.state, opponent.x, opponent.y);
    const lane = cell.x === opponent.x || cell.y === opponent.y ? 8 : 0;
    best = Math.max(best, Math.max(0, 28 - distance * 4 - exits * 3 + lane));
  }
  return best;
}

function futureSafetyScore(context, cell, depth) {
  let exits = 0;
  for (const dir of DIRECTIONS) {
    const x = cell.x + dir.dx;
    const y = cell.y + dir.dy;
    if (isWalkable(context, x, y) && cellSafeAt(context, x, y, depth + 1)) exits += 1;
  }
  return exits * 4;
}

function makePlan(candidate, context, heuristicId) {
  const finalKey = cellKey(candidate.x, candidate.y);
  const node = context.reachability.reachable.get(finalKey) || { x: candidate.x, y: candidate.y, dist: candidate.path.length, safe: true };
  return {
    kind: kindFor(heuristicId),
    objective: objectiveFor(heuristicId),
    target: candidate.target || targetFor(context, candidate),
    node,
    path: candidate.path,
    moves: candidate.moves,
    score: round(candidate.score),
    scoreBreakdown: roundBreakdown(candidate.breakdown),
    horizonTicks: candidate.moves.length,
    interrupts: ['danger_threshold', 'target_invalid', 'path_blocked', 'score_drop'],
  };
}

function makeSeed(start) {
  return {
    x: start.x,
    y: start.y,
    path: [],
    moves: [],
    visited: new Map([[cellKey(start.x, start.y), 1]]),
    collected: new Set(),
    target: null,
    breakdown: { survival: 0, trap: 0, farm: 0, position: 0 },
    score: 0,
    rankScore: 0,
  };
}

function indexedItems(state) {
  return (Array.isArray(state.items) ? state.items : [])
    .map((item) => ({ item, cell: entityCell(item, state, false) }))
    .filter((entry) => entry.cell)
    .map((entry) => ({ ...entry, key: cellKey(entry.cell.x, entry.cell.y) }));
}

function indexedOpponents(state, self) {
  return (Array.isArray(state.players) ? state.players : [])
    .filter((player) => player && player.id !== self.id && player.alive !== false && player.trapped !== true)
    .map((player) => ({ player, cell: playerCell(player, state) }))
    .filter((entry) => entry.cell)
    .map((entry) => ({ id: entry.player.id || 'unknown', x: entry.cell.x, y: entry.cell.y }));
}

function isWalkable(context, x, y) {
  const tile = tileAt(context.state, x, y);
  if (tile === constants.TILE_HARD || tile === constants.TILE_SOFT) return false;
  return !context.bombs.some((bomb) => bomb.x === x && bomb.y === y);
}

function cellSafeAt(context, x, y, arrival) {
  if (!context.reachability.danger) return true;
  return canUseCellSafely(context.reachability.danger, x, y, arrival);
}

function itemAt(items, x, y, collected) {
  return items.find((item) => item.cell.x === x && item.cell.y === y && !collected.has(item.key)) || null;
}

function adjacentSoftBlocks(state, x, y) {
  return DIRECTIONS.reduce((count, dir) => (
    tileAt(state, x + dir.dx, y + dir.dy) === constants.TILE_SOFT ? count + 1 : count
  ), 0);
}

function softBlocksInBlast(context, cell) {
  const power = Math.max(1, Math.floor(hasNumber(context.self.power) ? context.self.power : 2));
  return blastCellsForBomb(context.state, { x: cell.x, y: cell.y, power })
    .filter((blast) => tileAt(context.state, blast.x, blast.y) === constants.TILE_SOFT).length;
}

function openNeighborCount(state, x, y) {
  return DIRECTIONS.reduce((count, dir) => (
    tileAt(state, x + dir.dx, y + dir.dy) === constants.TILE_EMPTY ? count + 1 : count
  ), 0);
}

function centerScore(center, cell) {
  return Math.max(0, 12 - Math.abs(center.x - cell.x) - Math.abs(center.y - cell.y));
}

function totalScore(breakdown, weights) {
  return breakdown.survival * weights.survival
    + breakdown.trap * weights.trap
    + breakdown.farm * weights.farm
    + breakdown.position * weights.position;
}

function rankScore(score, context, cell, target, depth) {
  const targetBonus = target && target.x === cell.x && target.y === cell.y ? 55 : 0;
  const pressureBonus = context.heuristicId === 'pressure-trap' && trapScore(context, cell) > 0 ? 18 : 0;
  const farmBonus = adjacentSoftBlocks(context.state, cell.x, cell.y) > 0 ? 10 : 0;
  return score / Math.max(1, depth) + targetBonus + pressureBonus + farmBonus;
}

function weightsFor(heuristicId) {
  if (heuristicId === 'pressure-trap') return { survival: 1.8, trap: 3.4, farm: 0.8, position: 1 };
  if (heuristicId === 'item-value' || heuristicId === 'safe-bomb-farm') return { survival: 2.4, trap: 0.6, farm: 2.8, position: 1 };
  if (heuristicId === 'survival-veto') return { survival: 4, trap: 0.4, farm: 0.4, position: 1.4 };
  return { survival: 2.2, trap: 1, farm: 1.4, position: 1.6 };
}

function kindFor(heuristicId) {
  if (heuristicId === 'item-value') return 'item-route';
  if (heuristicId === 'pressure-trap') return 'opponent-pressure';
  if (heuristicId === 'safe-bomb-farm') return 'bomb-escape';
  if (heuristicId === 'survival-veto') return 'survival-escape';
  return 'safe-fallback';
}

function objectiveFor(heuristicId) {
  if (heuristicId === 'item-value') return 'collect_item';
  if (heuristicId === 'pressure-trap') return 'cut_escape_lane';
  if (heuristicId === 'safe-bomb-farm') return 'escape_after_bomb';
  if (heuristicId === 'survival-veto') return 'reach_safe_cell';
  return 'avoid_stall';
}

function targetFor(context, candidate) {
  if (context.heuristicId === 'pressure-trap' && context.opponents[0]) {
    return { type: 'opponent', playerId: context.opponents[0].id, x: context.opponents[0].x, y: context.opponents[0].y };
  }
  return { type: 'safe-cell', x: candidate.x, y: candidate.y };
}

function diversified(candidates, limit) {
  const counts = new Map();
  const selected = [];
  for (const candidate of candidates) {
    const key = cellKey(candidate.x, candidate.y);
    const count = counts.get(key) || 0;
    if (count >= 4) continue;
    counts.set(key, count + 1);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function compareCandidates(a, b) {
  return b.rankScore - a.rankScore || b.score - a.score || a.moves.length - b.moves.length || a.moves.join('').localeCompare(b.moves.join(''));
}

function addBreakdown(left, right) {
  return {
    survival: left.survival + right.survival,
    trap: left.trap + right.trap,
    farm: left.farm + right.farm,
    position: left.position + right.position,
  };
}

function roundBreakdown(breakdown) {
  return {
    survival: round(breakdown.survival),
    trap: round(breakdown.trap),
    farm: round(breakdown.farm),
    position: round(breakdown.position),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function opposite(move) {
  return { up: 'down', down: 'up', left: 'right', right: 'left' }[move] || null;
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

module.exports = { selectScoredSequencePlan };
