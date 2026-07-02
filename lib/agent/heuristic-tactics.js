'use strict';

const {
  constants,
  DIRECTIONS,
  REVERSE,
  ITEM_VALUE,
  hasNumber,
  cellKey,
  dimensions,
  entityCell,
  playerCell,
  normalizeObservation,
  actionForMove,
  tileAt,
} = require('./heuristic-state');
const {
  buildDangerMap,
  buildReachabilityMap,
  blastCellsForBomb,
  findBombAt,
} = require('./heuristic-danger');

function countSoftBlocksInBlast(state, self, cell) {
  const bomb = { x: cell.x, y: cell.y, power: Math.max(1, Math.floor(hasNumber(self.power) ? self.power : 2)) };
  return blastCellsForBomb(state, bomb).filter((blast) => tileAt(state, blast.x, blast.y) === constants.TILE_SOFT).length;
}

function opponentsInBlast(state, self, cell) {
  const bomb = { x: cell.x, y: cell.y, power: Math.max(1, Math.floor(hasNumber(self.power) ? self.power : 2)) };
  const blast = new Set(blastCellsForBomb(state, bomb).map((blastCell) => cellKey(blastCell.x, blastCell.y)));
  return (Array.isArray(state.players) ? state.players : [])
    .filter((player) => player && player.id !== self.id && player.alive !== false && player.trapped !== true)
    .map((player) => playerCell(player, state))
    .filter((cellValue) => cellValue && blast.has(cellKey(cellValue.x, cellValue.y))).length;
}

function hasBombCapacity(state, self) {
  if (!hasNumber(self.maxBombs)) return true;
  const activeBombs = hasNumber(self.activeBombs)
    ? self.activeBombs
    : (Array.isArray(state.bombs) ? state.bombs.filter((bomb) => (
      bomb && (
        bomb.owner === self.id
        || bomb.ownerId === self.id
        || bomb.playerId === self.id
      )
    )).length : 0);
  return activeBombs < self.maxBombs;
}

function canSafelyPlaceBomb(input, options) {
  const normalized = normalizeObservation(input);
  if (!normalized.ok) return details(false, 'malformed', null, options);
  const { state, self } = normalized;
  const start = playerCell(self, state);
  if (!start) return details(false, 'malformed', null, options);
  if (hasNumber(self.maxBombs) && self.maxBombs <= 0) return details(false, 'no-capacity', null, options);
  if (!hasBombCapacity(state, self)) return details(false, 'capacity', null, options);
  if (findBombAt(state, start.x, start.y)) return details(false, 'bomb-present', null, options);

  const simulatedBomb = {
    id: '__self_lookahead__',
    x: start.x,
    y: start.y,
    t: constants.BOMB_FUSE_TICKS,
    power: Math.max(1, Math.floor(hasNumber(self.power) ? self.power : 2)),
    pass: [self.id],
  };
  const simulatedState = { ...state, bombs: [...(Array.isArray(state.bombs) ? state.bombs : []), simulatedBomb] };
  const observation = { ...input, self, state: simulatedState };
  const danger = buildDangerMap(observation);
  const reachability = buildReachabilityMap(observation, danger);
  const ownBlast = new Set(blastCellsForBomb(simulatedState, simulatedBomb).map((cell) => cellKey(cell.x, cell.y)));

  let escape = null;
  for (const node of reachability.reachable.values()) {
    if (!node.safe || node.dist <= 0 || ownBlast.has(cellKey(node.x, node.y))) continue;
    if (!escape || node.dist < escape.dist) escape = node;
  }
  return details(!!escape, escape ? 'ok' : 'no-safe-exit', escape, options, danger, reachability);
}

function details(ok, reason, escape, options, danger, reachability) {
  const payload = { ok, escape, danger, reachability, reason };
  return options && options.details ? payload : payload.ok;
}

function findBestItem(state, reachability) {
  let best = null;
  for (const item of Array.isArray(state.items) ? state.items : []) {
    const cell = entityCell(item, state, false);
    if (!cell) continue;
    const node = reachability.reachable.get(cellKey(cell.x, cell.y));
    if (!node || !node.safe) continue;
    const score = (ITEM_VALUE[item.type] || 10) * 10 - node.dist * 4;
    const candidate = { item, node, score, key: cellKey(cell.x, cell.y) };
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.node.dist < best.node.dist) || (candidate.score === best.score && candidate.node.dist === best.node.dist && candidate.key < best.key)) best = candidate;
  }
  return best;
}

function currentCellDanger(dangerMap, cell) {
  const key = cellKey(cell.x, cell.y);
  const at = dangerMap.dangerAt.get(key);
  if (dangerMap.lethalNow.has(key)) return 0;
  return at === undefined ? Infinity : at;
}

function adjacentSoftBlocks(state, x, y) {
  return DIRECTIONS.reduce((count, dir) => (
    tileAt(state, x + dir.dx, y + dir.dy) === constants.TILE_SOFT ? count + 1 : count
  ), 0);
}

function chooseFallbackMove(reachability, memory) {
  const start = reachability.start;
  if (!start) return null;
  const candidates = [];
  const center = { x: Math.floor(dimensions(reachability.state).width / 2), y: Math.floor(dimensions(reachability.state).height / 2) };
  const recent = new Set(memory && Array.isArray(memory.recentCells) ? memory.recentCells : []);
  for (const node of reachability.reachable.values()) {
    if (!node || !node.safe || node.dist <= 0 || !node.firstMove) continue;
    const key = cellKey(node.x, node.y);
    const reversePenalty = memory && memory.lastMove && REVERSE[memory.lastMove] === node.firstMove ? 3 : 0;
    const revisitPenalty = recent.has(key) ? 4 : 0;
    const softBonus = adjacentSoftBlocks(reachability.state, node.x, node.y) * 4;
    const centerScore = -(Math.abs(center.x - node.x) + Math.abs(center.y - node.y));
    const distancePenalty = node.dist * 1.25;
    candidates.push({
      dir: node.firstMove,
      dist: node.dist,
      score: centerScore + softBonus - distancePenalty - reversePenalty - revisitPenalty,
    });
  }
  candidates.sort((a, b) => (
    b.score - a.score
    || a.dist - b.dist
    || DIRECTIONS.findIndex((dir) => dir.name === a.dir) - DIRECTIONS.findIndex((dir) => dir.name === b.dir)
  ));
  return candidates[0] ? actionForMove(candidates[0].dir) : null;
}

function findPressureNode(state, self, reachability) {
  let best = null;
  for (const player of Array.isArray(state.players) ? state.players : []) {
    if (!player || player.id === self.id || player.alive === false || player.trapped === true) continue;
    const opponent = playerCell(player, state);
    if (!opponent) continue;
    for (const node of reachability.reachable.values()) {
      if (!node || !node.safe || node.dist <= 0 || !node.firstMove) continue;
      if (node.x === opponent.x && node.y === opponent.y) continue;
      const distance = Math.abs(node.x - opponent.x) + Math.abs(node.y - opponent.y);
      const lane = node.x === opponent.x || node.y === opponent.y ? 14 : 0;
      const blastThreat = opponentsInBlast(state, self, node) > 0 ? 22 : 0;
      const softBonus = countSoftBlocksInBlast(state, self, node) * 2;
      const score = 80 - distance * 8 - node.dist * 3 + lane + blastThreat + softBonus;
      const candidate = { node, opponent, score };
      if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.node.dist < best.node.dist)) best = candidate;
    }
  }
  return best;
}

module.exports = {
  canSafelyPlaceBomb,
  chooseFallbackMove,
  countSoftBlocksInBlast,
  currentCellDanger,
  findBestItem,
  findPressureNode,
  opponentsInBlast,
};
