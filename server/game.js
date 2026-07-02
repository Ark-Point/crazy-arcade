// Authoritative game simulation for one round.
// Movement runs through shared.js so the client can predict with identical code.
const Shared = require('../public/shared');
const Catalog = require('../public/catalog');

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

const MAX_NEEDLES = 3;
const MAX_ACTIVE_ITEMS = 3;
const ITEM_DROP_RATE = 0.45;
// boss mode is co-op PvE: the arena has fewer boxes AND the boss itself crushes
// boxes as it roams, so loot is scarce. Boost the drop rates and make the boss's
// own box-crushing yield items so players can actually gear up for the fight.
const BOSS_ITEM_DROP_RATE = 0.7;   // box broken by a player's balloon
const BOSS_SPLASH_DROP_RATE = 0.4; // box broken by the boss water-cannon splash
const BOSS_CRUSH_DROP_RATE = 0.3;  // box the boss steamrolls while roaming/charging
const BOSS_SUPPLY_TICKS = 300;     // boss mode: a fresh item drops somewhere every ~10s

// weighted drop table: core stat items dominate, utility items stay rare
// so a typical round yields ~2 needles / ~1-2 shoes / ~1 ultra across ALL players
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
const MINION_FREEZE_TICKS = 120; // 4s frozen by a water stream
const MINION_FLY_SPEED = 9;     // kicked frozen minion slide speed
const MINION_KICK_DAMAGE = 3;
const CHARGE_GROGGY_TICKS = 90; // longer punish window after a charge
const CHARGE_SPEED = 10;

function weightedRoll(table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [type, weight] of table) {
    r -= weight;
    if (r < 0) return type;
  }
  return table[0][0];
}

function speedFromLevel(level) {
  return BASE_SPEED + SPEED_STEP * level;
}

function parseLayout(rows) {
  return rows.map((row) => {
    const cells = [];
    for (let x = 0; x < COLS; x++) {
      const c = row[x] || '.';
      cells.push(c === '#' ? TILE_HARD : c === '+' ? TILE_SOFT : TILE_EMPTY);
    }
    return cells;
  });
}

class Game {
  // players: [{id, nick, team}], emit(event, data) broadcasts to the room, onEnd(winner|null)
  // team is 'red' | 'blue' in team mode, null in free-for-all
  // mode 'boss' is co-op PvE: everyone is an ally, the round ends on boss kill or wipe
  constructor(players, emit, onEnd, mode = 'ffa', mapId = 'village') {
    this.emit = emit;
    this.onEnd = onEnd;
    this.mode = mode;
    this.mapId = mode === 'boss' ? 'boss-cove' : mapId;
    this.map = Catalog.getMap(this.mapId);
    this.tick = 0;
    this.over = false;
    this.overTick = 0;
    this.bombs = [];
    this.bombSeq = 0;
    this.streams = []; // {x, y, until}
    this.items = [];   // {x, y, type}
    this.telegraphs = []; // boss attack warnings {x, y, until}
    this.mapTelegraphs = [];
    this.dynamicHazards = [];
    this.minions = [];
    this.minionSeq = 0;
    this.roundTicks = mode === 'boss' ? 180 * 30 : ROUND_TICKS;
    this.grid = this.genMap();
    this.hazards = (this.map.hazards || []).map((h) => ({ ...h }));
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
        attack: null, // {type:'cannon',until} | {type:'charge',phase:'tele'|'dash',until,dx,tx}
        groggyUntil: 0,
        minionAt: 0,
      };
      this.supplyAt = COUNTDOWN_TICKS + BOSS_SUPPLY_TICKS;
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
      const character = Catalog.getCharacter(p.char || 0);
      const stats = character.stats;
      this.players.set(p.id, {
        id: p.id,
        nick: p.nick,
        team: p.team || null,
        char: p.char || 0,
        controller: p.controller || 'human',
        ownerId: p.ownerId || null,
        color: i,
        x: sx * TILE + TILE / 2,
        y: sy * TILE + TILE / 2,
        spawnX: sx * TILE + TILE / 2,
        spawnY: sy * TILE + TILE / 2,
        diedAt: 0,
        alive: true,
        trapped: false,
        trapUntil: 0,
        safeUntil: 0,
        input: {},
        cmdQueue: [],
        lastSeq: 0,
        lastQueuedSeq: 0,
        speed: speedFromLevel(stats.baseSpeedLevel),
        maxBombs: stats.baseBombs,
        power: stats.basePower,
        maxBombCap: stats.maxBombs,
        maxPowerCap: stats.maxPower,
        maxSpeedLevel: stats.maxSpeedLevel,
        activeBombs: 0,
        needles: 1,
        hasShoes: false,
        inventory: { shield: 0, glove: 0, oxygen: 0, trap: 0 },
        selectedItem: 'shield',
        shieldUntil: 0,
        oxygenUntil: 0,
        lastDir: { dx: 0, dy: 1 },
        kickCooldown: 0,
      });
    });

    this.interval = setInterval(() => this.step(), TICK_MS);
  }

  genMap() {
    const grid = parseLayout(this.map.layout || Catalog.MAPS.village.layout);
    // keep spawn corners walkable
    for (const [cx, cy] of SPAWNS) {
      const cells = [[cx, cy], [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (const [x, y] of cells) {
        if (x >= 0 && x < COLS && y >= 0 && y < ROWS && grid[y][x] === TILE_SOFT) {
          grid[y][x] = TILE_EMPTY;
        }
      }
    }
    if (this.mode === 'boss') {
      const midX = Math.floor(COLS / 2);
      const midY = Math.floor(ROWS / 2);
      for (let y = midY - 2; y <= midY + 2; y++) {
        for (let x = midX - 2; x <= midX + 2; x++) {
          if (x >= 0 && x < COLS && y >= 0 && y < ROWS) grid[y][x] = TILE_EMPTY;
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

  rollItem() {
    return weightedRoll(this.map.itemTable || Catalog.DEFAULT_ITEM_TABLE);
  }

  // clear a soft block and maybe drop loot (one item per cell at most)
  breakSoftBlock(cx, cy, rate) {
    this.grid[cy][cx] = TILE_EMPTY;
    if (!this.itemAt(cx, cy) && Math.random() < rate) {
      this.items.push({ x: cx, y: cy, type: this.rollItem() });
    }
  }

  selectItem(id, type) {
    const p = this.players.get(id);
    if (!p || !Catalog.isActiveItem(type)) return;
    p.selectedItem = type;
  }

  addActiveItem(p, type) {
    if (!Catalog.isActiveItem(type)) return;
    p.inventory[type] = Math.min(MAX_ACTIVE_ITEMS, (p.inventory[type] || 0) + 1);
    p.selectedItem = type;
  }

  isProtected(p) {
    return this.tick < p.safeUntil || this.tick < p.shieldUntil;
  }

  trapPlayer(p, ticks = TRAP_TICKS) {
    p.trapped = true;
    p.trapUntil = this.tick + ticks + (p.oxygenUntil > this.tick ? 90 : 0);
  }

  consumeActive(p, type) {
    if (!p.inventory[type]) return false;
    p.inventory[type]--;
    if (!p.inventory[p.selectedItem]) {
      p.selectedItem = Catalog.ACTIVE_ITEMS.find((it) => p.inventory[it] > 0) || p.selectedItem;
    }
    return true;
  }

  useActiveItem(id, requestedType) {
    if (this.over) return;
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    if (p.trapped) {
      if (p.needles > 0) {
        this.useNeedle(id);
        return;
      }
      if (p.inventory.oxygen > 0 && this.consumeActive(p, 'oxygen')) {
        p.trapUntil += 90;
        p.oxygenUntil = this.tick + 120;
      }
      return;
    }
    const type = Catalog.isActiveItem(requestedType) ? requestedType : p.selectedItem;
    if (!type || !p.inventory[type]) return;
    if (type === 'shield') {
      this.consumeActive(p, type);
      p.shieldUntil = Math.max(p.shieldUntil, this.tick + 150);
      p.safeUntil = Math.max(p.safeUntil, this.tick + 30);
    } else if (type === 'oxygen') {
      this.consumeActive(p, type);
      p.oxygenUntil = Math.max(p.oxygenUntil, this.tick + 300);
    } else if (type === 'glove') {
      if (this.throwBomb(p)) this.consumeActive(p, type);
    } else if (type === 'trap') {
      if (this.placeBubbleTrap(p)) this.consumeActive(p, type);
    }
  }

  throwBomb(p) {
    const dir = p.lastDir || { dx: 0, dy: 1 };
    const cx = Math.floor(p.x / TILE);
    const cy = Math.floor(p.y / TILE);
    const bomb = this.bombAt(cx + dir.dx, cy + dir.dy) || this.bombAt(cx, cy);
    if (!bomb || bomb.dx || bomb.dy) return false;
    const tx = bomb.cx + dir.dx;
    const ty = bomb.cy + dir.dy;
    if (tx < 0 || tx >= COLS || ty < 0 || ty >= ROWS) return false;
    if (this.grid[ty][tx] !== TILE_EMPTY || this.bombAt(tx, ty)) return false;
    bomb.dx = dir.dx;
    bomb.dy = dir.dy;
    return true;
  }

  placeBubbleTrap(p) {
    const dir = p.lastDir || { dx: 0, dy: 1 };
    let cx = Math.floor(p.x / TILE) + dir.dx;
    let cy = Math.floor(p.y / TILE) + dir.dy;
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS || this.grid[cy][cx] !== TILE_EMPTY || this.bombAt(cx, cy)) {
      cx = Math.floor(p.x / TILE);
      cy = Math.floor(p.y / TILE);
    }
    if (this.grid[cy][cx] !== TILE_EMPTY || this.bombAt(cx, cy)) return false;
    if (this.hazards.some((h) => h.x === cx && h.y === cy) || this.dynamicHazards.some((h) => h.x === cx && h.y === cy)) return false;
    this.dynamicHazards.push({ type: 'bubbleTrap', x: cx, y: cy, owner: p.id, until: this.tick + 450 });
    return true;
  }

  solidFor(p, cx, cy) {
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return 1;
    const t = this.grid[cy][cx];
    if (t === TILE_SOFT || t === TILE_HARD) return 1;
    const bomb = this.bombAt(cx, cy);
    if (bomb) return bomb.passable.has(p.id) ? 0 : 1;
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
        const dx = (cmd.keys.right ? 1 : 0) - (cmd.keys.left ? 1 : 0);
        const dy = (cmd.keys.down ? 1 : 0) - (cmd.keys.up ? 1 : 0);
        if (dx || dy) {
          if (Math.abs(dx) >= Math.abs(dy)) p.lastDir = { dx: Math.sign(dx), dy: 0 };
          else p.lastDir = { dx: 0, dy: Math.sign(dy) };
        }
        Shared.moveTick(this.world, p, cmd.keys);
        this.tryKick(p, cmd.keys);
      }
    }
  }

  // G002 생존성: 멈춤/이탈한 에이전트 슬롯을 baseline 봇이 인계할 때 호출.
  // processCmds 와 동일한 이동(+tryKick) 을 1틱 수행하되, p.lastSeq 만 증가시키고
  // p.lastQueuedSeq 는 건드리지 않는다 — 클라이언트 seq 레인을 오염시키지 않아야
  // 재개 입력(에이전트 재접속/스톨 해제)이 무음 드랍되지 않는다.
  // 게이트: controller==='agent' · alive · !trapped · !over (사람/boss/team 슬롯 누수 차단).
  driveBotInput(id, keys) {
    if (this.over) return;
    const p = this.players.get(id);
    if (!p || (p.controller || 'human') !== 'agent') return;
    if (!p.alive || p.trapped) return;
    const k = {
      up: !!(keys && keys.up),
      down: !!(keys && keys.down),
      left: !!(keys && keys.left),
      right: !!(keys && keys.right),
    };
    p.lastSeq++;
    p.input = k;
    const dx = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    const dy = (k.down ? 1 : 0) - (k.up ? 1 : 0);
    if (dx || dy) {
      if (Math.abs(dx) >= Math.abs(dy)) p.lastDir = { dx: Math.sign(dx), dy: 0 };
      else p.lastDir = { dx: 0, dy: Math.sign(dy) };
    }
    Shared.moveTick(this.world, p, k);
    this.tryKick(p, k);
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
    for (const b of this.bombs) {
      if (this.boxOverlapsCell(p, b.cx, b.cy)) return;
    }
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
        this.breakSoftBlock(x, y, BOSS_SPLASH_DROP_RATE);
      }
      const chained = this.bombAt(x, y);
      if (chained) this.explodeBomb(chained, exploded);
      this.streams.push({ x, y, until });
    }
  }

  // boss mode supply drop: a normal item on a random empty tile away from the boss
  spawnSupplyItem() {
    for (let tries = 0; tries < 30; tries++) {
      const cx = 1 + Math.floor(Math.random() * (COLS - 2));
      const cy = 1 + Math.floor(Math.random() * (ROWS - 2));
      if (this.grid[cy][cx] !== TILE_EMPTY || this.bombAt(cx, cy) || this.itemAt(cx, cy)) continue;
      const px = cx * TILE + TILE / 2;
      const py = cy * TILE + TILE / 2;
      if (this.boss && Math.hypot(this.boss.x - px, this.boss.y - py) < TILE * 2.5) continue;
      this.items.push({ x: cx, y: cy, type: this.rollItem() });
      return;
    }
  }

  spawnAngelCoin() {
    for (let tries = 0; tries < 30; tries++) {
      const cx = 1 + Math.floor(Math.random() * (COLS - 2));
      const cy = 1 + Math.floor(Math.random() * (ROWS - 2));
      if (this.grid[cy][cx] !== TILE_EMPTY || this.bombAt(cx, cy) || this.itemAt(cx, cy)) continue;
      const px = cx * TILE + TILE / 2;
      const py = cy * TILE + TILE / 2;
      if (this.boss && Math.hypot(this.boss.x - px, this.boss.y - py) < TILE * 2.5) continue;
      this.items.push({ x: cx, y: cy, type: 'angel' });
      return;
    }
  }

  reviveAlly(rescuer) {
    const dead = [...this.players.values()]
      .filter((p) => !p.alive && !p.disconnected)
      .sort((a, b) => b.diedAt - a.diedAt)[0];
    if (!dead) return;
    dead.alive = true;
    dead.trapped = false;
    dead.x = dead.spawnX;
    dead.y = dead.spawnY;
    dead.safeUntil = this.tick + 90; // 3s of safety after revival
    dead.cmdQueue.length = 0;
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
    const b = this.boss;
    for (const m of [...this.minions]) {
      // kicked frozen minion: slides until it hits the boss (big damage) or a wall
      if (m.flying) {
        m.x += m.fdx * MINION_FLY_SPEED;
        m.y += m.fdy * MINION_FLY_SPEED;
        if (b && b.hp > 0 && Math.abs(m.x - b.x) < 54 && Math.abs(m.y - b.y) < 54) {
          this.damageBoss(MINION_KICK_DAMAGE);
          this.minions.splice(this.minions.indexOf(m), 1);
          continue;
        }
        const fcx = Math.floor(m.x / TILE);
        const fcy = Math.floor(m.y / TILE);
        if (
          m.x < HALF || m.x > COLS * TILE - HALF || m.y < HALF || m.y > ROWS * TILE - HALF ||
          this.grid[fcy] === undefined || this.grid[fcy][fcx] !== TILE_EMPTY || this.bombAt(fcx, fcy)
        ) {
          this.minions.splice(this.minions.indexOf(m), 1); // shatters on impact
        }
        continue;
      }

      const mcx = Math.floor(m.x / TILE);
      const mcy = Math.floor(m.y / TILE);
      const inStream = this.streams.some((s) => s.x === mcx && s.y === mcy);

      if (m.frozenUntil > this.tick) {
        // frozen solid: an ally can push it to send it flying toward the boss
        for (const p of alive) {
          if (Math.abs(p.x - m.x) < HALF + 12 && Math.abs(p.y - m.y) < HALF + 12) {
            const ax = m.x - p.x;
            const ay = m.y - p.y;
            if (Math.abs(ax) > Math.abs(ay)) {
              m.fdx = Math.sign(ax) || 1;
              m.fdy = 0;
            } else {
              m.fdx = 0;
              m.fdy = Math.sign(ay) || 1;
            }
            m.flying = true;
            m.frozenUntil = 0;
            break;
          }
        }
        continue;
      }

      // a water stream freezes the minion instead of killing it
      if (inStream) {
        m.frozenUntil = this.tick + MINION_FREEZE_TICKS;
        m.wasFrozen = true;
        m.dx = 0;
        m.dy = 0;
        continue;
      }

      // freeze timer ran out un-kicked -> brief berserk (faster chase)
      if (m.wasFrozen) {
        m.wasFrozen = false;
        m.berserkUntil = this.tick + 120;
      }
      const speed = m.berserkUntil > this.tick ? MINION_SPEED * 1.9 : MINION_SPEED;

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
      const nx = Shared.clamp(m.x + m.dx * speed, HALF, COLS * TILE - HALF);
      const ny = Shared.clamp(m.y + m.dy * speed, HALF, ROWS * TILE - HALF);
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
        if (p.trapped || this.isProtected(p)) continue;
        if (Math.abs(p.x - m.x) < HALF + 8 && Math.abs(p.y - m.y) < HALF + 8) this.trapPlayer(p);
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
      if (b.attack && b.attack.type === 'cannon') {
        // telegraph finished -> splash lands, then the vulnerable window opens
        if (this.tick >= b.attack.until) {
          this.bossSplash(this.telegraphs.map((t) => [t.x, t.y]));
          this.telegraphs = [];
          b.attack = null;
          b.groggyUntil = this.tick + BOSS_GROGGY_TICKS;
          b.attackAt = this.tick + cfg.cooldown;
        }
      } else if (b.attack && b.attack.type === 'charge') {
        const atk = b.attack;
        if (atk.phase === 'tele') {
          if (this.tick >= atk.until) {
            atk.phase = 'dash';
            this.telegraphs = [];
          }
        } else {
          // dash across the lane, crushing boxes; body contact below bubbles players
          b.x += atk.dx * CHARGE_SPEED;
          b.x = Shared.clamp(b.x, TILE * 1.5, COLS * TILE - TILE * 1.5);
          for (const [cx, cy] of this.bossCells()) {
            if (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && this.grid[cy][cx] === TILE_SOFT) {
              this.breakSoftBlock(cx, cy, BOSS_CRUSH_DROP_RATE);
            }
          }
          if ((atk.dx > 0 && b.x >= atk.tx) || (atk.dx < 0 && b.x <= atk.tx)) {
            b.attack = null;
            b.target = null;
            b.groggyUntil = this.tick + CHARGE_GROGGY_TICKS;
            b.attackAt = this.tick + cfg.cooldown;
          }
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
            this.breakSoftBlock(cx, cy, BOSS_CRUSH_DROP_RATE);
          }
        }
        // pick the next attack (weighted random; charge unlocks at phase 2)
        if (this.tick >= b.attackAt) {
          const alive = [...this.players.values()].filter((p) => p.alive);
          if (!alive.length) {
            b.attackAt = this.tick + cfg.cooldown;
          } else if (b.phase >= 2 && Math.random() < 0.4) {
            this.startCharge();
          } else {
            this.startCannon(alive, cfg);
          }
        }
      }
    }

    this.bossContactAndMinions(cfg);
  }

  startCannon(alive, cfg) {
    const b = this.boss;
    const targets = alive.sort(() => Math.random() - 0.5).slice(0, cfg.targets);
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
    b.attack = { type: 'cannon', until };
  }

  startCharge() {
    const b = this.boss;
    // dash toward whichever side has more runway, telegraphing the 3-row lane
    const dx = b.x < (COLS * TILE) / 2 ? 1 : -1;
    const cy = Math.floor(b.y / TILE);
    const until = this.tick + BOSS_TELE_TICKS;
    const fromX = Math.floor(b.x / TILE);
    for (let y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= ROWS) continue;
      for (let x = dx > 0 ? fromX : 0; dx > 0 ? x < COLS : x <= fromX; x++) {
        this.telegraphs.push({ x, y, until });
      }
    }
    b.attack = {
      type: 'charge',
      phase: 'tele',
      until,
      dx,
      tx: dx > 0 ? COLS * TILE - TILE * 1.5 : TILE * 1.5,
    };
  }

  bossContactAndMinions(cfg) {
    const b = this.boss;
    // body contact bubbles players (54px ~= the 3x3 visual body)
    for (const p of this.players.values()) {
      if (!p.alive || p.trapped || this.isProtected(p)) continue;
      if (Math.abs(p.x - b.x) < 54 && Math.abs(p.y - b.y) < 54) {
        this.trapPlayer(p);
      }
    }

    // minion management (phase 2+)
    if (cfg.minions > 0 && this.minions.length < cfg.minions && this.tick >= b.minionAt) {
      this.spawnMinion();
      b.minionAt = this.tick + 120;
    }
    this.updateMinions();
  }

  streamLineFromHazard(h) {
    const cells = [];
    for (let i = 0; i <= h.length; i++) {
      const x = h.x + h.dx * i;
      const y = h.y + h.dy * i;
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) break;
      if (this.grid[y][x] === TILE_HARD) break;
      cells.push([x, y]);
      if (this.grid[y][x] === TILE_SOFT) break;
    }
    return cells;
  }

  addMapSplash(cells) {
    const exploded = new Set();
    const until = this.tick + STREAM_TICKS;
    for (const [x, y] of cells) {
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
      if (this.grid[y][x] === TILE_HARD) continue;
      if (this.grid[y][x] === TILE_SOFT) this.breakSoftBlock(x, y, ITEM_DROP_RATE);
      const chained = this.bombAt(x, y);
      if (chained) this.explodeBomb(chained, exploded);
      this.streams.push({ x, y, until });
    }
  }

  updateMapHazards() {
    this.mapTelegraphs = [];
    this.dynamicHazards = this.dynamicHazards.filter((h) => h.until > this.tick);
    if (this.mode !== 'boss') {
      for (const h of this.hazards) {
        if (h.type !== 'turret') continue;
        const phase = (this.tick + (h.offset || 0)) % h.interval;
        const cells = this.streamLineFromHazard(h);
        if (phase >= h.interval - h.warning) {
          for (const [x, y] of cells) this.mapTelegraphs.push({ x, y, until: this.tick + (h.interval - phase) });
        }
        if (phase === 0) this.addMapSplash(cells);
      }
    }
    const traps = [...this.hazards, ...this.dynamicHazards].filter((h) => h.type === 'bubbleTrap');
    for (const p of this.players.values()) {
      if (!p.alive || p.trapped || this.isProtected(p)) continue;
      const cx = Math.floor(p.x / TILE);
      const cy = Math.floor(p.y / TILE);
      const trap = traps.find((h) => h.x === cx && h.y === cy && h.owner !== p.id);
      if (!trap) continue;
      this.trapPlayer(p);
      if (trap.owner) this.dynamicHazards = this.dynamicHazards.filter((h) => h !== trap);
    }
  }

  applyCurrentHazards() {
    if (this.mode === 'boss') return;
    const currents = this.hazards.filter((h) => h.type === 'current');
    if (!currents.length) return;
    for (const p of this.players.values()) {
      if (!p.alive || p.trapped) continue;
      const cx = Math.floor(p.x / TILE);
      const cy = Math.floor(p.y / TILE);
      const current = currents.find((h) => h.x === cx && h.y === cy);
      if (!current) continue;
      const probe = { ...p };
      const nx = Shared.clamp(p.x + current.dx * 1.4, HALF, COLS * TILE - HALF);
      const ny = Shared.clamp(p.y + current.dy * 1.4, HALF, ROWS * TILE - HALF);
      if (!Shared.boxCollides(this.world, probe, nx, ny)) {
        p.x = nx;
        p.y = ny;
      }
    }
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
          this.breakSoftBlock(cx, cy, this.mode === 'boss' ? BOSS_ITEM_DROP_RATE : ITEM_DROP_RATE);
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
    const originNoTrapFor = new Set(bomb.passable);
    for (const [x, y] of cells) {
      this.streams.push({
        x,
        y,
        until,
        noTrap: x === bomb.cx && y === bomb.cy,
        noTrapFor: x === bomb.cx && y === bomb.cy ? originNoTrapFor : null,
      });
    }

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

      this.applyCurrentHazards();
      this.updateSlidingBombs();

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

      this.updateMapHazards();

      if (this.mode === 'boss') {
        this.updateBoss();
        if (this.tick >= this.supplyAt) {
          this.spawnSupplyItem();
          this.supplyAt = this.tick + BOSS_SUPPLY_TICKS;
        }
      }

      // water stream traps players (brief immunity right after rescue/needle)
      for (const p of this.players.values()) {
        if (!p.alive || p.trapped || this.isProtected(p)) continue;
        const cx = Math.floor(p.x / TILE);
        const cy = Math.floor(p.y / TILE);
        if (this.streams.some((s) => (
          s.x === cx && s.y === cy && (!s.noTrap || !(s.noTrapFor && s.noTrapFor.has(p.id)))
        ))) {
          this.trapPlayer(p);
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
          p.diedAt = this.tick;
          // boss mode: an angel coin drops somewhere — grab it to revive an ally
          if (this.mode === 'boss' && !this.items.some((it) => it.type === 'angel')) {
            this.spawnAngelCoin();
          }
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
        if (item.type === 'bomb') p.maxBombs = Math.min(p.maxBombCap, p.maxBombs + 1);
        else if (item.type === 'power') p.power = Math.min(p.maxPowerCap, p.power + 1);
        else if (item.type === 'speed') {
          const level = Math.round((p.speed - BASE_SPEED) / SPEED_STEP);
          p.speed = speedFromLevel(Math.min(p.maxSpeedLevel, level + 1));
        }
        else if (item.type === 'needle') p.needles = Math.min(MAX_NEEDLES, p.needles + 1);
        else if (item.type === 'shoes') p.hasShoes = true;
        else if (item.type === 'ultra') p.power = p.maxPowerCap;
        else if (Catalog.isActiveItem(item.type)) this.addActiveItem(p, item.type);
        else if (item.type === 'angel') this.reviveAlly(p);
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
      map: {
        id: this.map.id,
        name: this.map.name,
        theme: this.map.theme,
        description: this.map.description,
      },
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
            charging: !!(this.boss.attack && this.boss.attack.type === 'cannon'),
            dashing: !!(this.boss.attack && this.boss.attack.type === 'charge' && this.boss.attack.phase === 'dash'),
          }
        : undefined,
      telegraphs: this.telegraphs.length || this.mapTelegraphs.length
        ? [...this.telegraphs, ...this.mapTelegraphs].map((t) => ({ x: t.x, y: t.y, left: t.until - this.tick }))
        : undefined,
      hazards: [...this.hazards, ...this.dynamicHazards].map((h) => ({
        type: h.type,
        x: h.x,
        y: h.y,
        dx: h.dx,
        dy: h.dy,
        owner: h.owner,
        left: h.until ? h.until - this.tick : 0,
      })),
      minions: this.minions.length
        ? this.minions.map((m) => ({
            id: m.id,
            x: Math.round(m.x),
            y: Math.round(m.y),
            frozen: m.frozenUntil > this.tick,
            flying: !!m.flying,
            berserk: m.berserkUntil > this.tick,
          }))
        : undefined,
      grid: this.grid,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        nick: p.nick,
        team: p.team,
        char: p.char,
        controller: p.controller || 'human',
        ownerId: p.ownerId || null,
        color: p.color,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        seq: p.lastSeq,
        alive: p.alive,
        trapped: p.trapped,
        trapLeft: p.trapped ? p.trapUntil - this.tick : 0,
        activeBombs: p.activeBombs,
        maxBombs: p.maxBombs,
        maxBombCap: p.maxBombCap,
        power: p.power,
        maxPowerCap: p.maxPowerCap,
        speedLvl: Math.round((p.speed - BASE_SPEED) / SPEED_STEP),
        maxSpeedLvl: p.maxSpeedLevel,
        needles: p.needles,
        hasShoes: p.hasShoes,
        inventory: p.inventory,
        selectedItem: p.selectedItem,
        shieldLeft: Math.max(0, p.shieldUntil - this.tick),
        oxygenLeft: Math.max(0, p.oxygenUntil - this.tick),
      })),
      bombs: this.bombs.map((b) => ({
        id: b.id,
        x: b.cx,
        y: b.cy,
        owner: b.owner,
        px: Math.round(b.px),
        py: Math.round(b.py),
        t: b.timer,
        pass: [...b.passable],
      })),
      streams: this.streams.map((s) => ({ x: s.x, y: s.y, left: s.until - this.tick })),
      items: this.items,
    });
  }
}

module.exports = { Game, COLS, ROWS, TILE };
