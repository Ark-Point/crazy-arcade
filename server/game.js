// Authoritative game simulation for one round.
// Movement runs through shared.js so the client can predict with identical code.
const Shared = require('../public/shared');

const { COLS, ROWS, TILE, HALF, BASE_SPEED, SPEED_STEP } = Shared;
const TICK_MS = Shared.TICK_MS;

const BOMB_TICKS = 90;      // 3s fuse
const STREAM_TICKS = 18;    // 0.6s water stream
const TRAP_TICKS = 180;     // 6s trapped in bubble
const COUNTDOWN_TICKS = 90; // 3s start countdown
const ROUND_TICKS = 120 * 30; // 2 min round limit, draw on timeout
const OVER_LINGER_TICKS = 150; // 5s of celebration before returning to the room
const BOMB_SLIDE_SPEED = 6; // px per tick for kicked balloons
const KICK_COOLDOWN = 6;

const MAX_BOMBS = 6;
const MAX_POWER = 7;
const MAX_SPEED = BASE_SPEED + SPEED_STEP * 6;
const MAX_NEEDLES = 3;
const ITEM_DROP_RATE = 0.45;
const SOFT_BLOCK_RATE = 0.62;

// weighted drop table: core stat items dominate, utility items stay rare
// so a typical round yields ~2 needles / ~1-2 shoes / ~1 ultra across ALL players
const ITEM_TABLE = [
  ['bomb', 30],  // 🎈 +1 balloon
  ['power', 30], // 💧 +1 stream length
  ['speed', 22], // 🛼 roller: +1 speed step
  ['shoes', 8],  // 👟 kick placed balloons
  ['needle', 6], // 🪡 escape the bubble (Ctrl/X)
  ['ultra', 4],  // 🌊 max stream length
];
const ITEM_TOTAL = ITEM_TABLE.reduce((s, [, w]) => s + w, 0);

const TILE_EMPTY = 0;
const TILE_SOFT = 1;
const TILE_HARD = 2;

// 8 spawn points: 4 corners + 4 edge midpoints (left half = red side in team mode)
const MIDX = Math.floor(COLS / 2);
const MIDY = Math.floor(ROWS / 2);
const SPAWNS = [
  [0, 0],
  [COLS - 1, ROWS - 1],
  [COLS - 1, 0],
  [0, ROWS - 1],
  [MIDX, 0],
  [MIDX, ROWS - 1],
  [0, MIDY],
  [COLS - 1, MIDY],
];

function rollItem() {
  let r = Math.random() * ITEM_TOTAL;
  for (const [type, w] of ITEM_TABLE) {
    r -= w;
    if (r < 0) return type;
  }
  return 'bomb';
}

// boss mode tuning (phase 1 is the simple "learning" phase per boss-design research)
const BOSS_HP_BASE = 18;
const BOSS_HP_PER_PLAYER = 9;
const BOSS_TELE_TICKS = 36;   // 1.2s danger-tile telegraph before the splash lands
const BOSS_GROGGY_TICKS = 60; // 2s vulnerable window after a volley (double damage)
const BOSS_PHASE = [
  { cooldown: 160, speed: 1.3, targets: 1, minions: 0 },
  { cooldown: 115, speed: 1.7, targets: 2, minions: 2 },
  { cooldown: 80, speed: 2.3, targets: 9, minions: 4 },
];
const MINION_SPEED = 2.1;

class Game {
  // players: [{id, nick, team}], emit(event, data) broadcasts to the room, onEnd(winner|null)
  // team is 'red' | 'blue' in team mode, null in free-for-all
  // mode 'boss' is co-op PvE: everyone is an ally, the round ends on boss kill or wipe
  constructor(players, emit, onEnd, mode = 'ffa') {
    this.emit = emit;
    this.onEnd = onEnd;
    this.mode = mode;
    this.tick = 0;
    this.over = false;
    this.overTick = 0;
    this.bombs = [];
    this.bombSeq = 0;
    this.streams = []; // {x, y, until}
    this.items = [];   // {x, y, type}
    this.telegraphs = []; // boss attack warnings {x, y, until}
    this.minions = [];
    this.minionSeq = 0;
    this.roundTicks = mode === 'boss' ? 180 * 30 : ROUND_TICKS;
    this.grid = this.genMap();
    this.world = { solid: (p, cx, cy) => this.solidFor(p, cx, cy) };

    if (mode === 'boss') {
      this.boss = {
        x: Math.floor(COLS / 2) * TILE + TILE / 2,
        y: Math.floor(ROWS / 2) * TILE + TILE / 2,
        hp: BOSS_HP_BASE + BOSS_HP_PER_PLAYER * players.length,
        maxHp: BOSS_HP_BASE + BOSS_HP_PER_PLAYER * players.length,
        phase: 1,
        target: null,
        attackAt: COUNTDOWN_TICKS + 150,
        teleUntil: 0,
        groggyUntil: 0,
        minionAt: 0,
      };
    }

    this.players = new Map();
    // team mode: red spawns on the left side, blue on the right (up to 4 each)
    const teamSlots = { red: [0, 3, 6, 4], blue: [1, 2, 7, 5] };
    const taken = { red: 0, blue: 0 };
    players.forEach((p, i) => {
      let slot = i % SPAWNS.length;
      if (p.team && teamSlots[p.team] && taken[p.team] < teamSlots[p.team].length) {
        slot = teamSlots[p.team][taken[p.team]++];
      }
      const [sx, sy] = SPAWNS[slot];
      this.players.set(p.id, {
        id: p.id,
        nick: p.nick,
        team: p.team || null,
        char: p.char || 0,
        color: i,
        x: sx * TILE + TILE / 2,
        y: sy * TILE + TILE / 2,
        alive: true,
        trapped: false,
        trapUntil: 0,
        safeUntil: 0,
        input: {},
        cmdQueue: [],
        lastSeq: 0,
        lastQueuedSeq: 0,
        speed: BASE_SPEED,
        maxBombs: 1,
        power: 1,
        activeBombs: 0,
        needles: 1,
        hasShoes: false,
        kickCooldown: 0,
      });
    });

    this.interval = setInterval(() => this.step(), TICK_MS);
  }

  genMap() {
    const boss = this.mode === 'boss';
    const grid = [];
    const midX = Math.floor(COLS / 2);
    const midY = Math.floor(ROWS / 2);
    for (let y = 0; y < ROWS; y++) {
      const row = [];
      for (let x = 0; x < COLS; x++) {
        if (boss) {
          // open arena: no pillars, sparse boxes, clear 5x5 center for the boss
          const nearBoss = Math.abs(x - midX) <= 2 && Math.abs(y - midY) <= 2;
          row.push(!nearBoss && Math.random() < 0.3 ? TILE_SOFT : TILE_EMPTY);
        } else if (x % 2 === 1 && y % 2 === 1) {
          row.push(TILE_HARD);
        } else {
          row.push(Math.random() < SOFT_BLOCK_RATE ? TILE_SOFT : TILE_EMPTY);
        }
      }
      grid.push(row);
    }
    // keep spawn corners walkable
    for (const [cx, cy] of SPAWNS) {
      const cells = [[cx, cy], [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (const [x, y] of cells) {
        if (x >= 0 && x < COLS && y >= 0 && y < ROWS && grid[y][x] === TILE_SOFT) {
          grid[y][x] = TILE_EMPTY;
        }
      }
    }
    return grid;
  }

  // one movement command per client tick, sequence-numbered for reconciliation
  queueCmd(id, cmd) {
    const p = this.players.get(id);
    if (!p || !cmd || typeof cmd.seq !== 'number') return;
    if (cmd.seq <= p.lastQueuedSeq) return;
    if (p.cmdQueue.length >= 60) return;
    p.lastQueuedSeq = cmd.seq;
    const k = cmd.keys || {};
    p.cmdQueue.push({
      seq: cmd.seq,
      keys: { up: !!k.up, down: !!k.down, left: !!k.left, right: !!k.right },
    });
  }

  useNeedle(id) {
    if (this.over) return;
    const p = this.players.get(id);
    if (!p || !p.alive || !p.trapped || p.needles <= 0) return;
    p.needles--;
    p.trapped = false;
    p.trapUntil = 0;
    p.safeUntil = this.tick + 30; // 1s of stream immunity after escaping
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.alive = false;
    p.disconnected = true;
    this.checkEnd();
  }

  stop() {
    clearInterval(this.interval);
  }

  bombAt(cx, cy) {
    return this.bombs.find((b) => b.cx === cx && b.cy === cy);
  }

  itemAt(cx, cy) {
    return this.items.find((it) => it.x === cx && it.y === cy);
  }

  // 0 = open, 1 = solid, 2 = exit-only (balloon the player is still standing on)
  solidFor(p, cx, cy) {
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return 1;
    const t = this.grid[cy][cx];
    if (t === TILE_SOFT || t === TILE_HARD) return 1;
    const bomb = this.bombAt(cx, cy);
    if (bomb) return bomb.passable.has(p.id) ? 2 : 1;
    return 0;
  }

  boxOverlapsCell(p, cx, cy) {
    return (
      p.x + HALF > cx * TILE &&
      p.x - HALF < (cx + 1) * TILE &&
      p.y + HALF > cy * TILE &&
      p.y - HALF < (cy + 1) * TILE
    );
  }

  processCmds(p) {
    if (!p.alive) {
      p.cmdQueue.length = 0;
      return;
    }
    // normally one cmd per tick; catch up by two when the queue backs up
    let n = p.cmdQueue.length > 4 ? 2 : 1;
    while (n-- > 0 && p.cmdQueue.length) {
      const cmd = p.cmdQueue.shift();
      p.lastSeq = cmd.seq;
      p.input = cmd.keys;
      if (!p.trapped) {
        Shared.moveTick(this.world, p, cmd.keys);
        this.tryKick(p, cmd.keys);
      }
    }
  }

  // shoes: walking into a stationary balloon kicks it sliding away
  tryKick(p, keys) {
    if (!p.hasShoes || p.kickCooldown > this.tick) return;
    const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (!dx && !dy) return;
    const cx = Math.floor(p.x / TILE);
    const cy = Math.floor(p.y / TILE);
    for (const [ax, ay] of [[dx, 0], [0, dy]]) {
      if (!ax && !ay) continue;
      const bomb = this.bombAt(cx + ax, cy + ay);
      if (!bomb || bomb.dx || bomb.dy || bomb.passable.has(p.id)) continue;
      // only kick when actually pressed against it
      const edge = ax
        ? Math.abs(p.x - (cx * TILE + TILE / 2 + ax * (TILE / 2 - HALF)))
        : Math.abs(p.y - (cy * TILE + TILE / 2 + ay * (TILE / 2 - HALF)));
      if (edge > 4) continue;
      bomb.dx = ax;
      bomb.dy = ay;
      p.kickCooldown = this.tick + KICK_COOLDOWN;
      break;
    }
  }

  updateSlidingBombs() {
    for (const b of this.bombs) {
      if (!b.dx && !b.dy) continue;
      const targetX = (b.cx + b.dx) * TILE + TILE / 2;
      const targetY = (b.cy + b.dy) * TILE + TILE / 2;
      const tx = b.cx + b.dx;
      const ty = b.cy + b.dy;
      const blocked =
        tx < 0 || tx >= COLS || ty < 0 || ty >= ROWS ||
        this.grid[ty][tx] !== TILE_EMPTY ||
        this.bombs.some((o) => o !== b && o.cx === tx && o.cy === ty);
      if (blocked) {
        b.dx = 0;
        b.dy = 0;
        b.px = b.cx * TILE + TILE / 2;
        b.py = b.cy * TILE + TILE / 2;
        continue;
      }
      b.px += b.dx * BOMB_SLIDE_SPEED;
      b.py += b.dy * BOMB_SLIDE_SPEED;
      const arrived = b.dx ? (b.px - targetX) * b.dx >= 0 : (b.py - targetY) * b.dy >= 0;
      if (arrived) {
        b.cx = tx;
        b.cy = ty;
        b.px = targetX;
        b.py = targetY;
        // anyone now standing inside the cell may walk out freely
        for (const q of this.players.values()) {
          if (q.alive && this.boxOverlapsCell(q, b.cx, b.cy)) b.passable.add(q.id);
        }
      }
    }
  }

  placeBomb(id) {
    if (this.over || this.tick < COUNTDOWN_TICKS) return;
    const p = this.players.get(id);
    if (!p || !p.alive || p.trapped) return;
    if (p.activeBombs >= p.maxBombs) return;
    const cx = Math.floor(p.x / TILE);
    const cy = Math.floor(p.y / TILE);
    if (this.bombAt(cx, cy) || this.grid[cy][cx] !== TILE_EMPTY) return;
    const passable = new Set();
    for (const q of this.players.values()) {
      if (q.alive && this.boxOverlapsCell(q, cx, cy)) passable.add(q.id);
    }
    this.bombs.push({
      id: ++this.bombSeq,
      cx,
      cy,
      px: cx * TILE + TILE / 2,
      py: cy * TILE + TILE / 2,
      dx: 0,
      dy: 0,
      power: p.power,
      owner: p.id,
      timer: BOMB_TICKS,
      passable,
    });
    p.activeBombs++;
  }

  // ---------- boss mode ----------

  bossCells() {
    const b = this.boss;
    const cx = Math.floor(b.x / TILE);
    const cy = Math.floor(b.y / TILE);
    const cells = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) cells.push([cx + dx, cy + dy]);
    }
    return cells;
  }

  damageBoss(n) {
    const b = this.boss;
    if (!b || b.hp <= 0 || this.over) return;
    const groggy = b.groggyUntil > this.tick;
    b.hp = Math.max(0, b.hp - (groggy ? n * 2 : n));
    if (b.hp === 0) {
      this.over = true;
      this.overTick = this.tick;
      this.winner = null;
      this.winnerTeam = null;
      this.emit('gameOver', { winner: null, winnerTeam: null, reason: 'bossDown' });
    }
  }

  bossSplash(cells) {
    const exploded = new Set();
    const until = this.tick + 14;
    for (const [x, y] of cells) {
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
      if (this.grid[y][x] === TILE_HARD) continue;
      if (this.grid[y][x] === TILE_SOFT) {
        this.grid[y][x] = TILE_EMPTY;
        if (Math.random() < 0.2) this.items.push({ x, y, type: rollItem() });
      }
      const chained = this.bombAt(x, y);
      if (chained) this.explodeBomb(chained, exploded);
      this.streams.push({ x, y, until });
    }
  }

  spawnMinion() {
    for (let tries = 0; tries < 20; tries++) {
      const cx = 1 + Math.floor(Math.random() * (COLS - 2));
      const cy = 1 + Math.floor(Math.random() * (ROWS - 2));
      if (this.grid[cy][cx] !== TILE_EMPTY || this.bombAt(cx, cy)) continue;
      const px = cx * TILE + TILE / 2;
      const py = cy * TILE + TILE / 2;
      const nearPlayer = [...this.players.values()].some(
        (p) => p.alive && Math.hypot(p.x - px, p.y - py) < TILE * 3
      );
      const nearBoss = Math.hypot(this.boss.x - px, this.boss.y - py) < TILE * 2.5;
      if (nearPlayer || nearBoss) continue;
      this.minions.push({
        id: ++this.minionSeq,
        x: px,
        y: py,
        dx: 0,
        dy: 0,
        repathAt: 0,
      });
      return;
    }
  }

  updateMinions() {
    const alive = [...this.players.values()].filter((p) => p.alive);
    for (const m of [...this.minions]) {
      // water streams kill minions
      const mcx = Math.floor(m.x / TILE);
      const mcy = Math.floor(m.y / TILE);
      if (this.streams.some((s) => s.x === mcx && s.y === mcy)) {
        this.minions.splice(this.minions.indexOf(m), 1);
        continue;
      }
      // chase the nearest player, re-deciding the axis periodically
      if (this.tick >= m.repathAt && alive.length) {
        let best = alive[0];
        let bd = Infinity;
        for (const p of alive) {
          const d = Math.abs(p.x - m.x) + Math.abs(p.y - m.y);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        const ax = best.x - m.x;
        const ay = best.y - m.y;
        if (Math.abs(ax) > Math.abs(ay)) {
          m.dx = Math.sign(ax);
          m.dy = 0;
        } else {
          m.dx = 0;
          m.dy = Math.sign(ay);
        }
        m.repathAt = this.tick + 20;
      }
      const probe = { id: 'minion' + m.id, x: m.x, y: m.y };
      const nx = Shared.clamp(m.x + m.dx * MINION_SPEED, HALF, COLS * TILE - HALF);
      const ny = Shared.clamp(m.y + m.dy * MINION_SPEED, HALF, ROWS * TILE - HALF);
      if (!Shared.boxCollides(this.world, probe, nx, ny)) {
        m.x = nx;
        m.y = ny;
      } else {
        // blocked: try the other axis toward the target next tick
        m.repathAt = this.tick;
        const t = m.dx;
        m.dx = m.dy;
        m.dy = t;
      }
      // touching a minion bubbles you
      for (const p of alive) {
        if (p.trapped || this.tick < p.safeUntil) continue;
        if (Math.abs(p.x - m.x) < HALF + 8 && Math.abs(p.y - m.y) < HALF + 8) {
          p.trapped = true;
          p.trapUntil = this.tick + TRAP_TICKS;
        }
      }
    }
  }

  updateBoss() {
    const b = this.boss;
    if (!b || b.hp <= 0) return;
    const ratio = b.hp / b.maxHp;
    b.phase = ratio > 2 / 3 ? 1 : ratio > 1 / 3 ? 2 : 3;
    const cfg = BOSS_PHASE[b.phase - 1];

    const groggy = b.groggyUntil > this.tick;
    if (!groggy) {
      if (b.teleUntil) {
        // telegraph finished -> splash lands, then the vulnerable window opens
        if (this.tick >= b.teleUntil) {
          this.bossSplash(this.telegraphs.map((t) => [t.x, t.y]));
          this.telegraphs = [];
          b.teleUntil = 0;
          b.groggyUntil = this.tick + BOSS_GROGGY_TICKS;
          b.attackAt = this.tick + cfg.cooldown;
        }
      } else {
        // roam: drift toward a random reachable point, crushing boxes underfoot
        if (!b.target || (Math.abs(b.x - b.target.x) < 2 && Math.abs(b.y - b.target.y) < 2)) {
          b.target = {
            x: (1 + Math.floor(Math.random() * (COLS - 2))) * TILE + TILE / 2,
            y: (1 + Math.floor(Math.random() * (ROWS - 2))) * TILE + TILE / 2,
          };
        }
        const ax = b.target.x - b.x;
        const ay = b.target.y - b.y;
        const d = Math.hypot(ax, ay) || 1;
        b.x += (ax / d) * cfg.speed;
        b.y += (ay / d) * cfg.speed;
        b.x = Shared.clamp(b.x, TILE * 1.5, COLS * TILE - TILE * 1.5);
        b.y = Shared.clamp(b.y, TILE * 1.5, ROWS * TILE - TILE * 1.5);
        for (const [cx, cy] of this.bossCells()) {
          if (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && this.grid[cy][cx] === TILE_SOFT) {
            this.grid[cy][cx] = TILE_EMPTY;
          }
        }
        // telegraphed water-cannon volley aimed at players' current cells
        if (this.tick >= b.attackAt) {
          const alive = [...this.players.values()].filter((p) => p.alive);
          if (alive.length) {
            const targets = alive
              .sort(() => Math.random() - 0.5)
              .slice(0, cfg.targets);
            const until = this.tick + BOSS_TELE_TICKS;
            const seen = new Set();
            for (const t of targets) {
              const cx = Math.floor(t.x / TILE);
              const cy = Math.floor(t.y / TILE);
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const x = cx + dx;
                  const y = cy + dy;
                  const key = x + ',' + y;
                  if (x < 0 || x >= COLS || y < 0 || y >= ROWS || seen.has(key)) continue;
                  seen.add(key);
                  this.telegraphs.push({ x, y, until });
                }
              }
            }
            b.teleUntil = until;
          } else {
            b.attackAt = this.tick + cfg.cooldown;
          }
        }
      }
    }

    // body contact bubbles players (54px ~= the 3x3 visual body)
    for (const p of this.players.values()) {
      if (!p.alive || p.trapped || this.tick < p.safeUntil) continue;
      if (Math.abs(p.x - b.x) < 54 && Math.abs(p.y - b.y) < 54) {
        p.trapped = true;
        p.trapUntil = this.tick + TRAP_TICKS;
      }
    }

    // minion management (phase 2+)
    if (cfg.minions > 0 && this.minions.length < cfg.minions && this.tick >= b.minionAt) {
      this.spawnMinion();
      b.minionAt = this.tick + 120;
    }
    this.updateMinions();
  }

  explodeBomb(bomb, exploded) {
    if (exploded.has(bomb)) return;
    exploded.add(bomb);
    const idx = this.bombs.indexOf(bomb);
    if (idx !== -1) this.bombs.splice(idx, 1);
    const owner = this.players.get(bomb.owner);
    if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);

    const cells = [[bomb.cx, bomb.cy]];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      for (let i = 1; i <= bomb.power; i++) {
        const cx = bomb.cx + dx * i;
        const cy = bomb.cy + dy * i;
        if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) break;
        const t = this.grid[cy][cx];
        if (t === TILE_HARD) break;
        if (t === TILE_SOFT) {
          this.grid[cy][cx] = TILE_EMPTY;
          if (Math.random() < ITEM_DROP_RATE) {
            this.items.push({ x: cx, y: cy, type: rollItem() });
          }
          cells.push([cx, cy]);
          break;
        }
        cells.push([cx, cy]);
        const item = this.itemAt(cx, cy);
        if (item) {
          this.items.splice(this.items.indexOf(item), 1);
          break;
        }
        const chained = this.bombAt(cx, cy);
        if (chained) this.explodeBomb(chained, exploded);
      }
    }
    const until = this.tick + STREAM_TICKS;
    for (const [x, y] of cells) this.streams.push({ x, y, until });

    // boss takes 1 damage per explosion whose stream touches its body
    if (this.boss && this.boss.hp > 0) {
      const bodySet = new Set(this.bossCells().map(([x, y]) => x + ',' + y));
      if (cells.some(([x, y]) => bodySet.has(x + ',' + y))) this.damageBoss(1);
    }
  }

  step() {
    this.tick++;
    const counting = this.tick < COUNTDOWN_TICKS;

    if (!counting) {
      for (const p of this.players.values()) this.processCmds(p);

      this.updateSlidingBombs();

      // bombs become solid once the player steps off
      for (const b of this.bombs) {
        for (const id of [...b.passable]) {
          const q = this.players.get(id);
          if (!q || !q.alive || !this.boxOverlapsCell(q, b.cx, b.cy)) b.passable.delete(id);
        }
      }

      // fuses + explosions (chained)
      const exploded = new Set();
      for (const b of [...this.bombs]) {
        b.timer--;
        if (b.timer <= 0) this.explodeBomb(b, exploded);
      }
      this.streams = this.streams.filter((s) => s.until > this.tick);

      if (this.mode === 'boss') this.updateBoss();

      // water stream traps players (brief immunity right after rescue/needle)
      for (const p of this.players.values()) {
        if (!p.alive || p.trapped || this.tick < p.safeUntil) continue;
        const cx = Math.floor(p.x / TILE);
        const cy = Math.floor(p.y / TILE);
        if (this.streams.some((s) => s.x === cx && s.y === cy)) {
          p.trapped = true;
          p.trapUntil = this.tick + TRAP_TICKS;
        }
      }

      // trapped players: pop on timeout, enemy touch kills, teammate touch rescues
      for (const p of this.players.values()) {
        if (!p.alive || !p.trapped) continue;
        let dead = this.tick >= p.trapUntil;
        let rescued = false;
        if (!dead) {
          for (const q of this.players.values()) {
            if (q.id === p.id || !q.alive || q.trapped) continue;
            if (Math.abs(q.x - p.x) < HALF * 2 && Math.abs(q.y - p.y) < HALF * 2) {
              // boss mode is fully co-op: every touch is a rescue
              if (this.mode === 'boss' || (p.team && q.team === p.team)) rescued = true;
              else dead = true;
              break;
            }
          }
        }
        if (dead) {
          p.alive = false;
          p.trapped = false;
        } else if (rescued) {
          p.trapped = false;
          p.trapUntil = 0;
          p.safeUntil = this.tick + 45; // 1.5s of stream immunity after rescue
        }
      }

      // item pickup
      for (const p of this.players.values()) {
        if (!p.alive || p.trapped) continue;
        const cx = Math.floor(p.x / TILE);
        const cy = Math.floor(p.y / TILE);
        const item = this.itemAt(cx, cy);
        if (!item) continue;
        this.items.splice(this.items.indexOf(item), 1);
        if (item.type === 'bomb') p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
        else if (item.type === 'power') p.power = Math.min(MAX_POWER, p.power + 1);
        else if (item.type === 'speed') p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);
        else if (item.type === 'needle') p.needles = Math.min(MAX_NEEDLES, p.needles + 1);
        else if (item.type === 'shoes') p.hasShoes = true;
        else if (item.type === 'ultra') p.power = MAX_POWER;
      }

      this.checkEnd();

      // round timer: time out -> draw (boss mode: defeat)
      if (!this.over && this.tick - COUNTDOWN_TICKS >= this.roundTicks) {
        this.over = true;
        this.overTick = this.tick;
        this.winner = null;
        this.winnerTeam = null;
        this.emit('gameOver', { winner: null, winnerTeam: null, reason: 'timeout' });
      }
    }

    this.broadcast();

    if (this.over && this.tick - this.overTick > OVER_LINGER_TICKS) {
      this.stop();
      this.onEnd(this.winner);
    }
  }

  checkEnd() {
    if (this.over) return;
    if (this.mode === 'boss') {
      // wipe = defeat (the boss-kill victory is handled in damageBoss)
      if (![...this.players.values()].some((p) => p.alive)) {
        this.over = true;
        this.overTick = this.tick;
        this.winner = null;
        this.winnerTeam = null;
        this.emit('gameOver', { winner: null, winnerTeam: null, reason: 'bossWipe' });
      }
      return;
    }
    if (this.players.size < 2) return; // solo practice never ends by elimination
    const alive = [...this.players.values()].filter((p) => p.alive);
    const teamMode = [...this.players.values()].some((p) => p.team);

    if (teamMode) {
      const aliveTeams = new Set(alive.map((p) => p.team));
      if (aliveTeams.size <= 1) {
        this.over = true;
        this.overTick = this.tick;
        this.winner = null;
        this.winnerTeam = aliveTeams.size === 1 ? alive[0].team : null;
        this.emit('gameOver', { winner: null, winnerTeam: this.winnerTeam });
      }
    } else if (alive.length <= 1) {
      this.over = true;
      this.overTick = this.tick;
      this.winner = alive[0] ? { id: alive[0].id, nick: alive[0].nick, char: alive[0].char } : null;
      this.emit('gameOver', { winner: this.winner, winnerTeam: null });
    }
  }

  broadcast() {
    this.emit('state', {
      t: this.tick,
      countdown: Math.max(0, COUNTDOWN_TICKS - this.tick),
      timeLeft: Math.max(0, this.roundTicks - Math.max(0, this.tick - COUNTDOWN_TICKS)),
      boss: this.boss
        ? {
            x: Math.round(this.boss.x),
            y: Math.round(this.boss.y),
            hp: this.boss.hp,
            maxHp: this.boss.maxHp,
            phase: this.boss.phase,
            groggy: this.boss.groggyUntil > this.tick,
            charging: this.boss.teleUntil > this.tick,
          }
        : undefined,
      telegraphs: this.telegraphs.length
        ? this.telegraphs.map((t) => ({ x: t.x, y: t.y, left: t.until - this.tick }))
        : undefined,
      minions: this.minions.length ? this.minions.map((m) => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y) })) : undefined,
      grid: this.grid,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        nick: p.nick,
        team: p.team,
        char: p.char,
        color: p.color,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        seq: p.lastSeq,
        alive: p.alive,
        trapped: p.trapped,
        trapLeft: p.trapped ? p.trapUntil - this.tick : 0,
        maxBombs: p.maxBombs,
        power: p.power,
        speedLvl: Math.round((p.speed - BASE_SPEED) / SPEED_STEP),
        needles: p.needles,
        hasShoes: p.hasShoes,
      })),
      bombs: this.bombs.map((b) => ({
        id: b.id,
        x: b.cx,
        y: b.cy,
        px: Math.round(b.px),
        py: Math.round(b.py),
        t: b.timer,
      })),
      streams: this.streams.map((s) => ({ x: s.x, y: s.y, left: s.until - this.tick })),
      items: this.items,
    });
  }
}

module.exports = { Game, COLS, ROWS, TILE };
