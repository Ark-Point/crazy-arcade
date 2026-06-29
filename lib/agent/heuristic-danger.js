'use strict';

const {
  constants,
  DIRECTIONS,
  cellKey,
  parseCellKey,
  inBounds,
  tileAt,
  entityCell,
  normalizeObservation,
  normalizeStateInput,
  playerCell,
  hasNumber,
} = require('./heuristic-state');

function markDanger(result, x, y, at, until, source) {
  if (!Number.isFinite(at) || !Number.isFinite(until) || !inBounds(result.state, x, y)) return;
  const key = cellKey(x, y);
  const current = result.dangerAt.get(key);
  if (current === undefined || at < current) {
    result.dangerAt.set(key, at);
    result.sources.set(key, source);
  }
  const currentUntil = result.dangerUntil.get(key);
  if (currentUntil === undefined || until > currentUntil) result.dangerUntil.set(key, until);
  if (at <= 0) result.lethalNow.add(key);
}

function maxObservedPower(state, self) {
  const players = Array.isArray(state.players) ? state.players : [];
  const powers = players.map((p) => p && p.power).filter(hasNumber);
  if (self && hasNumber(self.power)) powers.push(self.power);
  return Math.max(1, ...powers, 2);
}

function normalizeBombs(state, self) {
  const power = maxObservedPower(state, self);
  return (Array.isArray(state.bombs) ? state.bombs : [])
    .map((bomb, index) => {
      const cell = entityCell(bomb, state, false);
      if (!cell) return null;
      const timer = hasNumber(bomb.t)
        ? bomb.t
        : hasNumber(bomb.timer)
          ? bomb.timer
          : hasNumber(bomb.left)
            ? bomb.left
            : constants.BOMB_FUSE_TICKS;
      return {
        id: bomb.id || `bomb-${index}`,
        x: cell.x,
        y: cell.y,
        t: Math.max(0, timer),
        power: Math.max(1, Math.floor(hasNumber(bomb.power) ? bomb.power : power)),
        pass: Array.isArray(bomb.pass) ? bomb.pass : Array.isArray(bomb.passable) ? bomb.passable : [],
      };
    })
    .filter(Boolean);
}

function blastCellsForBomb(state, bomb) {
  const cells = [{ x: bomb.x, y: bomb.y, origin: true }];
  for (const dir of DIRECTIONS) {
    for (let step = 1; step <= bomb.power; step++) {
      const x = bomb.x + dir.dx * step;
      const y = bomb.y + dir.dy * step;
      const tile = tileAt(state, x, y);
      if (tile === constants.TILE_HARD) break;
      cells.push({ x, y, origin: false });
      if (tile === constants.TILE_SOFT) break;
    }
  }
  return cells;
}

function chainBombTimes(state, bombs) {
  const bombTimes = bombs.map((bomb) => bomb.t);
  for (let pass = 0; pass < bombs.length; pass++) {
    let changed = false;
    for (let i = 0; i < bombs.length; i++) {
      const cells = blastCellsForBomb(state, bombs[i]);
      for (let j = 0; j < bombs.length; j++) {
        if (i === j || bombTimes[j] <= bombTimes[i]) continue;
        if (cells.some((cell) => cell.x === bombs[j].x && cell.y === bombs[j].y)) {
          bombTimes[j] = bombTimes[i];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return bombTimes;
}

function buildDangerMap(input, options) {
  const normalized = normalizeStateInput(input);
  const state = normalized.state || {};
  const self = normalized.self || null;
  const result = {
    state,
    dangerAt: new Map(),
    dangerUntil: new Map(),
    lethalNow: new Set(),
    sources: new Map(),
    blastCellsByBomb: new Map(),
    isDangerous(x, y, arrival, margin) {
      return !isCellSafe(this, x, y, arrival || 0, margin);
    },
  };
  const includeBombOrigins = !options || options.includeBombOrigins !== false;
  const bombs = normalizeBombs(state, self);
  const bombTimes = chainBombTimes(state, bombs);

  bombs.forEach((bomb, index) => {
    const cells = blastCellsForBomb(state, bomb);
    result.blastCellsByBomb.set(bomb.id, cells);
    for (const cell of cells) {
      if (cell.origin && !includeBombOrigins) continue;
      markDanger(result, cell.x, cell.y, bombTimes[index], bombTimes[index] + constants.STREAM_TICKS, 'bomb');
    }
  });

  markTimedCells(result, state.streams, 0, constants.STREAM_TICKS, 'stream');
  markTimedCells(result, state.hazards, 0, constants.SAFETY_MARGIN_TICKS, 'hazard');
  markTimedCells(result, state.telegraphs, null, constants.STREAM_TICKS, 'telegraph');
  markTimedCells(result, state.minions, 0, constants.SAFETY_MARGIN_TICKS, 'minion', true);
  return result;
}

function markTimedCells(result, list, defaultAt, defaultDuration, source, preferPixels) {
  for (const item of Array.isArray(list) ? list : []) {
    const cell = entityCell(item, result.state, !!preferPixels);
    if (!cell) continue;
    const left = hasNumber(item.left) ? Math.max(0, item.left) : defaultAt || 0;
    const at = defaultAt === null ? left : defaultAt;
    markDanger(result, cell.x, cell.y, at, at + Math.max(1, left || defaultDuration), source);
  }
}

function isCellSafe(dangerMap, x, y, arrival, margin) {
  const key = cellKey(x, y);
  const at = dangerMap.dangerAt.get(key);
  if (at === undefined) return true;
  const until = dangerMap.dangerUntil.get(key);
  const safety = Number.isFinite(margin) ? margin : constants.SAFETY_MARGIN_TICKS;
  if (arrival + safety < at) return true;
  return arrival > (until === undefined ? at : until) + safety;
}

function bombBlocksCell(bombs, x, y, self, startKey) {
  const key = cellKey(x, y);
  const bomb = bombs.find((candidate) => candidate.x === x && candidate.y === y);
  if (!bomb) return false;
  if (key === startKey && self && bomb.pass.includes(self.id)) return false;
  return true;
}

function isWalkable(state, bombs, x, y, self, startKey) {
  const tile = tileAt(state, x, y);
  if (tile === constants.TILE_HARD || tile === constants.TILE_SOFT) return false;
  return !bombBlocksCell(bombs, x, y, self, startKey);
}

function reconstructPath(reachable, key) {
  const path = [];
  let cursor = key;
  while (cursor && reachable.has(cursor)) {
    path.push(parseCellKey(cursor));
    cursor = reachable.get(cursor).prevKey;
  }
  return path.reverse();
}

function buildReachabilityMap(input, dangerMap, options) {
  const normalized = normalizeObservation(input);
  const state = normalized.ok ? normalized.state : input && input.state ? input.state : {};
  const self = normalized.ok ? normalized.self : null;
  const start = self ? playerCell(self, state) : null;
  const result = { state, self, start, reachable: new Map(), nearestSafe: null, nearestSafeExit: null, pathTo(key) { return reconstructPath(this.reachable, key); } };
  if (!start) return result;

  const danger = dangerMap || buildDangerMap(input);
  const margin = options && Number.isFinite(options.safetyMargin) ? options.safetyMargin : constants.SAFETY_MARGIN_TICKS;
  const bombs = normalizeBombs(state, self);
  const startKey = cellKey(start.x, start.y);
  const queue = [startKey];
  result.reachable.set(startKey, { x: start.x, y: start.y, dist: 0, firstMove: null, prevKey: null, safe: isCellSafe(danger, start.x, start.y, 0, margin) });

  for (let index = 0; index < queue.length; index++) {
    const current = result.reachable.get(queue[index]);
    for (const dir of DIRECTIONS) {
      const x = current.x + dir.dx;
      const y = current.y + dir.dy;
      const nextKey = cellKey(x, y);
      if (result.reachable.has(nextKey)) continue;
      if (!inBounds(state, x, y) || !isWalkable(state, bombs, x, y, self, startKey)) continue;
      const dist = current.dist + 1;
      const safe = isCellSafe(danger, x, y, dist, margin);
      if (!safe && (!options || options.allowDangerousPath !== true)) continue;
      result.reachable.set(nextKey, { x, y, dist, firstMove: current.firstMove || dir.name, prevKey: queue[index], safe });
      queue.push(nextKey);
    }
  }

  for (const node of result.reachable.values()) {
    if (!node.safe) continue;
    if (!result.nearestSafe || node.dist < result.nearestSafe.dist) result.nearestSafe = node;
    if (node.dist > 0 && (!result.nearestSafeExit || node.dist < result.nearestSafeExit.dist)) result.nearestSafeExit = node;
  }
  return result;
}

function findBombAt(state, x, y) {
  return normalizeBombs(state, null).find((bomb) => bomb.x === x && bomb.y === y) || null;
}

module.exports = {
  buildDangerMap,
  buildReachabilityMap,
  canUseCellSafely: isCellSafe,
  isCellSafe,
  normalizeBombs,
  blastCellsForBomb,
  findBombAt,
};
