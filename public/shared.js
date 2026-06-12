// Movement code shared between server (authoritative sim) and client
// (prediction). Both sides MUST run the exact same logic per tick so that
// client-side prediction reconciles cleanly.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COLS = 15;
  const ROWS = 13;
  const TILE = 40;
  const TICK_MS = 1000 / 30;
  const HALF = 13; // player half hitbox (px)
  const BASE_SPEED = 4.0; // px per tick (3 tiles/s at 30Hz)
  const SPEED_STEP = 0.5;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // overlap area between the player box at (x,y) and cell (cx,cy)
  function cellOverlap(x, y, cx, cy) {
    const ox = Math.min(x + HALF, (cx + 1) * TILE) - Math.max(x - HALF, cx * TILE);
    const oy = Math.min(y + HALF, (cy + 1) * TILE) - Math.max(y - HALF, cy * TILE);
    return Math.max(0, ox) * Math.max(0, oy);
  }

  // world: { solid(p, cx, cy) -> 0 open | 1 solid | 2 exit-only }
  // exit-only cells (a balloon you are standing on) block any move that would
  // increase your overlap with them: you can step off, never back in or across.
  function boxCollides(world, p, x, y) {
    const x0 = Math.floor((x - HALF) / TILE);
    const x1 = Math.floor((x + HALF - 1) / TILE);
    const y0 = Math.floor((y - HALF) / TILE);
    const y1 = Math.floor((y + HALF - 1) / TILE);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const s = world.solid(p, cx, cy);
        if (s === 1 || s === true) return true;
        if (s === 2 && cellOverlap(x, y, cx, cy) > cellOverlap(p.x, p.y, cx, cy) + 0.0001) return true;
      }
    }
    return false;
  }

  function moveAxis(world, p, dx, dy) {
    const nx = clamp(p.x + dx, HALF, COLS * TILE - HALF);
    const ny = clamp(p.y + dy, HALF, ROWS * TILE - HALF);
    if (!boxCollides(world, p, nx, ny)) {
      p.x = nx;
      p.y = ny;
      return;
    }
    // corner assist: if the cell straight ahead is open, slide toward its lane
    const cx = Math.floor(p.x / TILE);
    const cy = Math.floor(p.y / TILE);
    if (dx) {
      const tx = cx + Math.sign(dx);
      if (world.solid(p, tx, cy) === 0) {
        const laneY = cy * TILE + TILE / 2;
        const step = Math.sign(laneY - p.y) * Math.min(Math.abs(laneY - p.y), Math.abs(dx));
        if (step && !boxCollides(world, p, p.x, p.y + step)) p.y += step;
      }
    } else if (dy) {
      const ty = cy + Math.sign(dy);
      if (world.solid(p, cx, ty) === 0) {
        const laneX = cx * TILE + TILE / 2;
        const step = Math.sign(laneX - p.x) * Math.min(Math.abs(laneX - p.x), Math.abs(dy));
        if (step && !boxCollides(world, p, p.x + step, p.y)) p.x += step;
      }
    }
  }

  // Advance player p one tick with held keys. p needs {x, y, speed}.
  function moveTick(world, p, keys) {
    const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (!dx && !dy) return;
    if (dx && dy) {
      const s = p.speed * 0.7071;
      moveAxis(world, p, dx * s, 0);
      moveAxis(world, p, 0, dy * s);
    } else if (dx) {
      moveAxis(world, p, dx * p.speed, 0);
    } else {
      moveAxis(world, p, 0, dy * p.speed);
    }
  }

  return { COLS, ROWS, TILE, TICK_MS, HALF, BASE_SPEED, SPEED_STEP, clamp, boxCollides, moveAxis, moveTick };
});
