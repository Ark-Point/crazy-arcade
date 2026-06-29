'use strict';

const {
  constants,
  DIRECTIONS,
  ITEM_VALUE,
  cellKey,
  dimensions,
  entityCell,
  playerCell,
  tileAt,
} = require('./heuristic-state');
const { selectScoredSequencePlan } = require('./sequence-evaluator');

function selectBaselinePlan(normalized, reachability, heuristicId, options = {}) {
  const scored = selectScoredSequencePlan(normalized, reachability, heuristicId, {
    minDepth: Math.min(6, options.maxDepth || 12),
    maxDepth: options.maxDepth || 12,
    beamWidth: options.beamWidth || 96,
  });
  if (scored) return scored;

  const { state, self } = normalized;
  if (heuristicId === 'item-value') return itemRoutePlan(state, reachability);
  if (heuristicId === 'pressure-trap') return pressureTrapPlan(state, self, reachability);
  if (heuristicId === 'safe-bomb-farm') return escapePlan(reachability, 'bomb-escape', 'escape_after_bomb');
  if (heuristicId === 'survival-veto') return escapePlan(reachability, 'survival-escape', 'reach_safe_cell');
  return fallbackPlan(state, reachability);
}

function itemRoutePlan(state, reachability) {
  let best = null;
  for (const item of Array.isArray(state.items) ? state.items : []) {
    const cell = entityCell(item, state, false);
    if (!cell) continue;
    const node = reachability.reachable.get(cellKey(cell.x, cell.y));
    if (!node || !node.safe || node.dist <= 0) continue;
    const value = ITEM_VALUE[item.type] || 10;
    const score = value * 10 - node.dist * 4;
    if (!best || score > best.score || (score === best.score && node.dist < best.node.dist)) {
      best = { node, score, target: { type: 'item', itemType: item.type || 'unknown', x: node.x, y: node.y } };
    }
  }
  return best ? makePlan('item-route', 'collect_item', best.node, best.target, best.score) : null;
}

function pressureTrapPlan(state, self, reachability) {
  let best = null;
  for (const opponent of opponents(state, self)) {
    const cell = playerCell(opponent, state);
    if (!cell) continue;
    for (const dir of DIRECTIONS) {
      const node = reachability.reachable.get(cellKey(cell.x + dir.dx, cell.y + dir.dy));
      if (!node || !node.safe || node.dist <= 0) continue;
      const exits = openNeighborCount(state, cell.x, cell.y);
      const score = 80 - node.dist * 3 - exits * 8 + adjacentSoftBlocks(state, node.x, node.y) * 2;
      if (!best || score > best.score || (score === best.score && node.dist < best.node.dist)) {
        best = {
          node,
          score,
          target: { type: 'opponent', playerId: opponent.id || 'unknown', x: cell.x, y: cell.y },
        };
      }
    }
    const staging = pressureStagingNode(state, reachability, cell);
    if (staging && (!best || staging.score > best.score || (staging.score === best.score && staging.node.dist < best.node.dist))) {
      best = {
        node: staging.node,
        score: staging.score,
        target: { type: 'opponent', playerId: opponent.id || 'unknown', x: cell.x, y: cell.y },
      };
    }
  }
  return best ? makePlan('opponent-pressure', 'cut_escape_lane', best.node, best.target, best.score) : null;
}

function pressureStagingNode(state, reachability, opponentCell) {
  let best = null;
  for (const node of reachability.reachable.values()) {
    if (!node || !node.safe || node.dist <= 0) continue;
    const opponentDistance = Math.abs(node.x - opponentCell.x) + Math.abs(node.y - opponentCell.y);
    const score = 45 - opponentDistance * 5 - node.dist * 1.5 + adjacentSoftBlocks(state, node.x, node.y) * 2;
    if (!best || score > best.score || (score === best.score && node.dist < best.node.dist)) best = { node, score };
  }
  return best;
}

function escapePlan(reachability, kind, objective) {
  const node = reachability.nearestSafeExit;
  return node ? makePlan(kind, objective, node, { type: 'safe-cell', x: node.x, y: node.y }, 100 - node.dist) : null;
}

function fallbackPlan(state, reachability) {
  let best = null;
  const size = dimensions(state);
  const center = { x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) };
  for (const node of reachability.reachable.values()) {
    if (!node || !node.safe || node.dist <= 0) continue;
    const softBonus = adjacentSoftBlocks(state, node.x, node.y) * 4;
    const centerScore = -(Math.abs(center.x - node.x) + Math.abs(center.y - node.y));
    const score = centerScore + softBonus - node.dist * 1.25;
    if (!best || score > best.score || (score === best.score && node.dist < best.node.dist)) best = { node, score };
  }
  return best ? makePlan('safe-fallback', 'avoid_stall', best.node, { type: 'safe-cell', x: best.node.x, y: best.node.y }, best.score) : null;
}

function makePlan(kind, objective, node, target, score) {
  return {
    kind,
    objective,
    target,
    score,
    node,
    interrupts: ['danger_threshold', 'target_invalid', 'path_blocked'],
  };
}

function opponents(state, self) {
  return (Array.isArray(state.players) ? state.players : [])
    .filter((player) => player && player.id !== self.id && player.alive !== false && player.trapped !== true);
}

function openNeighborCount(state, x, y) {
  return DIRECTIONS.reduce((count, dir) => (
    tileAt(state, x + dir.dx, y + dir.dy) === constants.TILE_EMPTY ? count + 1 : count
  ), 0);
}

function adjacentSoftBlocks(state, x, y) {
  return DIRECTIONS.reduce((count, dir) => (
    tileAt(state, x + dir.dx, y + dir.dy) === constants.TILE_SOFT ? count + 1 : count
  ), 0);
}

module.exports = { selectBaselinePlan };
