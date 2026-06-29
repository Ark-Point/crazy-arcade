'use strict';

const constants = {
  COLS: 15,
  ROWS: 13,
  TILE: 40,
  TILE_EMPTY: 0,
  TILE_SOFT: 1,
  TILE_HARD: 2,
  BOMB_FUSE_TICKS: 90,
  STREAM_TICKS: 18,
  SAFETY_MARGIN_TICKS: 6,
  ESCAPE_URGENCY_TICKS: 18,
};

const DIRECTIONS = [
  { name: 'up', dx: 0, dy: -1 },
  { name: 'right', dx: 1, dy: 0 },
  { name: 'down', dx: 0, dy: 1 },
  { name: 'left', dx: -1, dy: 0 },
];

const REVERSE = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

const ITEM_VALUE = {
  angel: 90,
  needle: 70,
  shield: 65,
  oxygen: 62,
  bomb: 56,
  power: 54,
  ultra: 52,
  speed: 48,
  shoes: 36,
  glove: 30,
  trap: 20,
};

function waitAction() {
  return { type: 'wait' };
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function parseCellKey(key) {
  const parts = String(key).split(',');
  return { x: Number(parts[0]), y: Number(parts[1]) };
}

function dimensions(state) {
  const grid = state && Array.isArray(state.grid) ? state.grid : null;
  const height = grid && grid.length ? grid.length : constants.ROWS;
  const width = grid && Array.isArray(grid[0]) && grid[0].length ? grid[0].length : constants.COLS;
  return { width, height };
}

function inBounds(state, x, y) {
  const size = dimensions(state);
  return x >= 0 && x < size.width && y >= 0 && y < size.height;
}

function tileAt(state, x, y) {
  if (!inBounds(state, x, y)) return constants.TILE_HARD;
  if (!state || !Array.isArray(state.grid) || !Array.isArray(state.grid[y])) return constants.TILE_EMPTY;
  const tile = state.grid[y][x];
  return Number.isInteger(tile) ? tile : constants.TILE_EMPTY;
}

function normalizeCoordinate(value, limit) {
  if (!hasNumber(value)) return null;
  if (Number.isInteger(value) && value >= 0 && value < limit) return value;
  const cell = Math.floor(value / constants.TILE);
  return Number.isInteger(cell) ? cell : null;
}

function entityCell(entity, state, preferPixels) {
  if (!isObject(entity)) return null;
  const size = dimensions(state);
  const rawX = hasNumber(entity.cx) ? entity.cx : entity.x;
  const rawY = hasNumber(entity.cy) ? entity.cy : entity.y;
  if (!hasNumber(rawX) || !hasNumber(rawY)) return null;

  let x;
  let y;
  if (!preferPixels && Number.isInteger(rawX) && Number.isInteger(rawY) && rawX >= 0 && rawX < size.width && rawY >= 0 && rawY < size.height) {
    x = rawX;
    y = rawY;
  } else {
    x = normalizeCoordinate(rawX, size.width);
    y = normalizeCoordinate(rawY, size.height);
  }
  if (x === null || y === null || !inBounds(state, x, y)) return null;
  return { x, y };
}

function playerCell(player, state) {
  return entityCell(player, state, true);
}

function normalizeObservation(observation) {
  if (!isObject(observation) || !isObject(observation.state)) return { ok: false };
  const state = observation.state;
  const players = Array.isArray(state.players) ? state.players : [];
  const self = isObject(observation.self)
    ? observation.self
    : players.find((p) => p && p.id === observation.playerId);
  if (!isObject(self) || !playerCell(self, state)) return { ok: false };
  if (self.alive === false) return { ok: false };
  return { ok: true, state, self };
}

function normalizeStateInput(input) {
  if (isObject(input) && isObject(input.state)) {
    const normalized = normalizeObservation(input);
    return {
      state: input.state,
      self: normalized.ok ? normalized.self : input.self,
      ok: isObject(input.state),
    };
  }
  return { state: isObject(input) ? input : {}, self: null, ok: isObject(input) };
}

function actionForMove(move) {
  const keys = { up: false, down: false, left: false, right: false };
  if (keys[move] === false) keys[move] = true;
  return { type: 'move', keys };
}

function moveFromAction(action) {
  if (!action || !action.keys) return null;
  const direction = DIRECTIONS.find((dir) => action.keys[dir.name]);
  return direction ? direction.name : null;
}

module.exports = {
  constants,
  DIRECTIONS,
  REVERSE,
  ITEM_VALUE,
  waitAction,
  isObject,
  hasNumber,
  cellKey,
  parseCellKey,
  dimensions,
  inBounds,
  tileAt,
  normalizeCoordinate,
  entityCell,
  playerCell,
  normalizeObservation,
  normalizeStateInput,
  actionForMove,
  moveFromAction,
};
