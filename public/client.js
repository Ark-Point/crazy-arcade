/* global io, Shared */
const { COLS, ROWS, TILE, TICK_MS, HALF, BASE_SPEED, SPEED_STEP } = Shared;
const STREAM_TICKS = 18;
const TRAP_TICKS = 180;
const INTERP_DELAY = 100; // render remote players this far in the past (ms)

const PLAYER_COLORS = ['#ff5252', '#448aff', '#66bb6a', '#ffb300', '#ab47bc', '#26c6da', '#ec407a', '#8d6e63'];
const TEAM_COLORS = { red: '#ff5252', blue: '#448aff' };

// original code-drawn roster (no external sprite assets)
const CHARACTERS = [
  { name: '버니', color: '#f3f3f3' },
  { name: '냥이', color: '#ffb74d' },
  { name: '개구리', color: '#81c784' },
  { name: '곰돌이', color: '#bf9270' },
  { name: '펭구', color: '#607d8b' },
  { name: '로보', color: '#b0bec5' },
];
const ITEM_EMOJI = { bomb: '🎈', power: '💧', speed: '🛼', needle: '🪡', shoes: '👟', ultra: '🌊' };

const socket = io();

const $ = (sel) => document.querySelector(sel);
const screens = {
  login: $('#screen-login'),
  lobby: $('#screen-lobby'),
  room: $('#screen-room'),
  game: $('#screen-game'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ---------- 로그인 ----------
$('#btn-enter').addEventListener('click', enter);
$('#nick-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enter();
});

function enter() {
  const nick = $('#nick-input').value.trim();
  if (!nick) return toast('닉네임을 입력하세요.');
  socket.emit('setNick', nick);
  showScreen('lobby');
}

// ---------- 로비 ----------
$('#btn-create').addEventListener('click', () => {
  socket.emit('createRoom', $('#room-name-input').value);
});

socket.on('rooms', (rooms) => {
  const list = $('#room-list');
  list.innerHTML = '';
  if (!rooms.length) {
    list.innerHTML = '<div class="empty-msg">아직 방이 없습니다. 첫 방을 만들어보세요!</div>';
    return;
  }
  for (const r of rooms) {
    const div = document.createElement('div');
    div.className = 'room-item' + (r.playing ? ' playing' : '');
    div.innerHTML = `<span class="room-name"></span><span class="room-meta">${r.count}/${r.max} · ${r.playing ? '게임 중' : '대기 중'}</span>`;
    div.querySelector('.room-name').textContent = r.name;
    if (!r.playing && r.count < r.max) {
      div.addEventListener('click', () => socket.emit('joinRoom', r.id));
    }
    list.appendChild(div);
  }
});

socket.on('errorMsg', toast);

// ---------- 대기실 ----------
socket.on('joinedRoom', (room) => {
  renderRoom(room);
  showScreen('room');
});

socket.on('roomUpdate', (room) => {
  renderRoom(room);
  if (room.state === 'waiting' && screens.game.classList.contains('active')) {
    showScreen('room');
  }
});

function renderRoom(room) {
  $('#room-title').textContent = `🏠 ${room.name}`;
  const isHost = room.host === socket.id;
  const teamMode = room.mode === 'team';

  $('#btn-mode-ffa').classList.toggle('selected', room.mode === 'ffa');
  $('#btn-mode-team').classList.toggle('selected', teamMode);
  $('#btn-mode-boss').classList.toggle('selected', room.mode === 'boss');
  $('#btn-mode-ffa').disabled = !isHost;
  $('#btn-mode-team').disabled = !isHost;
  $('#btn-mode-boss').disabled = !isHost;

  $('#team-row').classList.toggle('hidden', !teamMode);
  const me = room.players.find((p) => p.id === socket.id);
  $('#btn-team-red').classList.toggle('selected', !!me && me.team === 'red');
  $('#btn-team-blue').classList.toggle('selected', !!me && me.team === 'blue');
  if (me && typeof me.char === 'number') {
    myChar = me.char;
    document.querySelectorAll('.char-btn').forEach((b) => b.classList.toggle('selected', +b.dataset.char === myChar));
  }

  const list = $('#player-list');
  list.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const p = room.players[i];
    const div = document.createElement('div');
    if (p) {
      div.className = 'player-slot';
      const charName = CHARACTERS[p.char || 0].name;
      if (teamMode) {
        div.classList.add(p.team === 'blue' ? 'team-blue' : 'team-red');
        div.textContent = `${p.team === 'blue' ? '🔵' : '🔴'} ${p.nick} (${charName})`;
      } else {
        div.style.borderLeft = `5px solid ${PLAYER_COLORS[i]}`;
        div.textContent = `${p.nick} (${charName})`;
      }
      if (p.id === room.host) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = '방장';
        div.appendChild(b);
      }
    } else {
      div.className = 'player-slot empty';
      div.textContent = '빈 자리';
    }
    list.appendChild(div);
  }
  $('#btn-start').style.display = isHost ? '' : 'none';
}

// character picker: preview thumbnails drawn with the in-game avatar code
let myChar = 0;
(function buildCharPicker() {
  const list = $('#char-list');
  CHARACTERS.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'char-btn' + (i === 0 ? ' selected' : '');
    btn.dataset.char = i;
    const cv = document.createElement('canvas');
    cv.width = 44;
    cv.height = 44;
    const g = cv.getContext('2d');
    g.translate(22, 24);
    g.scale(1.15, 1.15);
    drawAvatar(g, i, c.color, 0, 0.3);
    const name = document.createElement('span');
    name.className = 'char-name';
    name.textContent = c.name;
    btn.appendChild(cv);
    btn.appendChild(name);
    btn.addEventListener('click', () => {
      myChar = i;
      socket.emit('setChar', i);
      document.querySelectorAll('.char-btn').forEach((b) => b.classList.toggle('selected', +b.dataset.char === i));
    });
    list.appendChild(btn);
  });
})();

$('#btn-start').addEventListener('click', () => socket.emit('startGame'));
$('#btn-leave').addEventListener('click', () => {
  socket.emit('leaveRoom');
  showScreen('lobby');
});
$('#btn-mode-ffa').addEventListener('click', () => socket.emit('setMode', 'ffa'));
$('#btn-mode-team').addEventListener('click', () => socket.emit('setMode', 'team'));
$('#btn-mode-boss').addEventListener('click', () => socket.emit('setMode', 'boss'));
$('#btn-team-red').addEventListener('click', () => socket.emit('setTeam', 'red'));
$('#btn-team-blue').addEventListener('click', () => socket.emit('setTeam', 'blue'));

// ---------- 게임: 넷코드 상태 ----------
const canvas = $('#game-canvas');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');

let snapshots = []; // {s, serverMs}
let offsetSamples = []; // performance.now() - serverMs per snapshot
let pending = []; // unacknowledged input commands
let seq = 0;
let myPred = null; // predicted local player {x, y, speed}
let errX = 0;
let errY = 0; // visual error offset, decays smoothly after reconciliation
let gameEnded = false;
let goFlashUntil = 0;
let shake = 0;
let particles = [];
let coinRainUntil = 0;
let celebrateUntil = 0; // fireworks + confetti while celebrating a win
let winnerId = null;
let nextFireworkAt = 0;
let banner = null; // {text, until}
const playerAnim = new Map(); // id -> {bob, dirX, dirY, moving, lastX, lastY}
const streamBorn = new Map(); // "x,y" -> time first seen
const bgCanvas = document.createElement('canvas');
bgCanvas.width = canvas.width;
bgCanvas.height = canvas.height;
let bgDrawn = false;

const latest = () => (snapshots.length ? snapshots[snapshots.length - 1].s : null);
const inGame = () => screens.game.classList.contains('active');

socket.on('gameStart', ({ players }) => {
  buildPlayerCards(players || []);
  snapshots = [];
  offsetSamples = [];
  pending = [];
  seq = 0;
  myPred = null;
  errX = errY = 0;
  gameEnded = false;
  goFlashUntil = 0;
  shake = 0;
  particles = [];
  coinRainUntil = 0;
  celebrateUntil = 0;
  winnerId = null;
  banner = null;
  playerAnim.clear();
  streamBorn.clear();
  bgDrawn = false;
  overlay.classList.add('hidden');
  showScreen('game');
});

// the predicted world mirrors server collision rules against the latest snapshot
// returns 0 open / 1 solid / 2 exit-only (same contract as the server)
const clientWorld = {
  solid(p, cx, cy) {
    const s = latest();
    if (!s) return 0;
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return 1;
    const t = s.grid[cy][cx];
    if (t === 1 || t === 2) return 1;
    const bomb = s.bombs.find((b) => b.x === cx && b.y === cy);
    if (bomb) {
      // a balloon we are still standing on is exit-only; everything else is a wall
      const ov =
        p.x + HALF > cx * TILE && p.x - HALF < (cx + 1) * TILE &&
        p.y + HALF > cy * TILE && p.y - HALF < (cy + 1) * TILE;
      return ov ? 2 : 1;
    }
    return 0;
  },
};

socket.on('state', (s) => {
  const prev = latest();
  const serverMs = s.t * TICK_MS;
  snapshots.push({ s, serverMs });
  if (snapshots.length > 60) snapshots.shift();
  offsetSamples.push(performance.now() - serverMs);
  if (offsetSamples.length > 120) offsetSamples.shift();

  if (prev && prev.countdown > 0 && s.countdown === 0) goFlashUntil = performance.now() + 700;
  if (prev) detectEffects(prev, s);

  const me = s.players.find((p) => p.id === socket.id);
  if (!me) return;
  const speed = BASE_SPEED + SPEED_STEP * me.speedLvl;

  if (!me.alive || me.trapped || s.countdown > 0) {
    myPred = { x: me.x, y: me.y, speed };
    pending = [];
    errX = errY = 0;
    return;
  }

  // server reconciliation: rewind to authoritative state, replay unacked inputs
  const visX = myPred ? myPred.x + errX : me.x;
  const visY = myPred ? myPred.y + errY : me.y;
  myPred = { x: me.x, y: me.y, speed };
  pending = pending.filter((c) => c.seq > me.seq);
  for (const c of pending) Shared.moveTick(clientWorld, myPred, c.keys);
  // keep rendering from the old position and decay the difference smoothly
  errX = visX - myPred.x;
  errY = visY - myPred.y;
  if (Math.abs(errX) > 48 || Math.abs(errY) > 48) errX = errY = 0;
});

socket.on('gameOver', ({ winner, winnerTeam, reason }) => {
  gameEnded = true;
  const s = latest();
  const bossMode = !!(s && s.boss);
  const me = s && s.players.find((p) => p.id === socket.id);
  const myTeam = me ? me.team : null;

  // did *I* win?
  let iWon = false;
  if (reason === 'bossDown') iWon = !!me;
  else if (winnerTeam) iWon = myTeam === winnerTeam;
  else if (winner) iWon = winner.id === socket.id;

  let title;
  let detail = '';
  if (reason === 'bossDown') {
    title = '보스 처치 성공!';
    coinRainUntil = performance.now() + 3500;
  } else if (reason === 'bossWipe') title = '전멸... 보스전 실패';
  else if (winnerTeam) {
    title = winnerTeam === 'red' ? '🔴 레드팀 승리!' : '🔵 블루팀 승리!';
  } else if (winner) {
    title = `${escapeHtml(winner.nick)} 승리!`;
    winnerId = winner.id;
  } else if (reason === 'timeout') title = bossMode ? '⏰ 시간 종료! 보스전 실패' : '⏰ 시간 종료! 무승부';
  else title = '💀 무승부!';

  if (iWon) {
    celebrateUntil = performance.now() + 5000;
    if (winner && winner.id === socket.id) detail = '최후의 1인이 되었습니다!';
    else if (winnerTeam) detail = '우리 팀이 해냈어요!';
    else if (reason === 'bossDown') detail = '킹 옥토를 물리쳤습니다!';
    overlay.innerHTML =
      `<div class="overlay-card win">` +
      `<div class="trophy">🏆</div>` +
      `<div class="v-title">VICTORY!</div>` +
      `<div class="v-sub">${title}</div>` +
      (detail ? `<div class="v-detail">${detail}</div>` : '') +
      `<div class="sub">잠시 후 대기실로 돌아갑니다…</div>` +
      `</div>`;
  } else {
    const lose = reason === 'bossWipe' || winnerTeam || winner || (reason === 'timeout' && bossMode);
    overlay.innerHTML =
      `<div class="overlay-card ${lose ? 'lose' : ''}">` +
      `<div class="trophy small">${lose ? '😢' : '🤝'}</div>` +
      `<div class="v-sub big">${title}</div>` +
      `<div class="sub">잠시 후 대기실로 돌아갑니다…</div>` +
      `</div>`;
  }
  overlay.classList.remove('hidden');
});

function escapeHtml(t) {
  const div = document.createElement('div');
  div.textContent = t;
  return div.innerHTML;
}

// ---------- 이펙트 감지 (스냅샷 비교) ----------
function detectEffects(prev, s) {
  const me = s.players.find((p) => p.id === socket.id);

  // broken boxes -> debris
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (prev.grid[y][x] === 1 && s.grid[y][x] === 0) {
        spawnDebris(x * TILE + TILE / 2, y * TILE + TILE / 2);
      }
    }
  }

  // new stream cells -> droplets + screen shake near me
  const prevKeys = new Set(prev.streams.map((w) => `${w.x},${w.y}`));
  for (const w of s.streams) {
    const key = `${w.x},${w.y}`;
    if (!prevKeys.has(key)) {
      streamBorn.set(key, performance.now());
      spawnDroplets(w.x * TILE + TILE / 2, w.y * TILE + TILE / 2, 3);
      if (me) {
        const d = Math.hypot(w.x * TILE + TILE / 2 - me.x, w.y * TILE + TILE / 2 - me.y);
        if (d < TILE * 3.5) shake = Math.min(9, shake + 4);
      }
    }
  }
  for (const key of [...streamBorn.keys()]) {
    if (!s.streams.some((w) => `${w.x},${w.y}` === key)) streamBorn.delete(key);
  }

  // player transitions
  const prevById = new Map(prev.players.map((p) => [p.id, p]));
  for (const p of s.players) {
    const old = prevById.get(p.id);
    if (!old) continue;
    if (old.alive && !p.alive) spawnSplash(old.x, old.y);
    if (old.alive && p.alive && old.trapped && !p.trapped) spawnSparkle(p.x, p.y, '#b3e5fc');
  }

  // picked-up items -> sparkle
  const itemKeys = new Set(s.items.map((it) => `${it.x},${it.y}`));
  for (const it of prev.items) {
    if (!itemKeys.has(`${it.x},${it.y}`)) {
      const cellGotStreamed = s.streams.some((w) => w.x === it.x && w.y === it.y);
      if (!cellGotStreamed) spawnSparkle(it.x * TILE + TILE / 2, it.y * TILE + TILE / 2, '#fff59d');
    }
  }

  // boss events
  if (prev.boss && s.boss) {
    if (s.boss.hp < prev.boss.hp) {
      spawnDamageText(s.boss.x, s.boss.y - 50, `-${prev.boss.hp - s.boss.hp}`);
      spawnDroplets(s.boss.x, s.boss.y - 20, 6);
    }
    if (s.boss.phase === 2 && prev.boss.phase === 1) {
      banner = { text: '👾 보스가 분노했다! 쫄몹 소환!', until: performance.now() + 2200 };
    } else if (s.boss.phase === 3 && prev.boss.phase === 2) {
      banner = { text: '🔥 보스 폭주!! 조심해!', until: performance.now() + 2200 };
    }
  }
  const prevMinions = new Set((prev.minions || []).map((m) => m.id));
  const curMinions = new Set((s.minions || []).map((m) => m.id));
  for (const m of prev.minions || []) {
    if (!curMinions.has(m.id)) spawnSplash(m.x, m.y);
  }
  for (const m of s.minions || []) {
    if (!prevMinions.has(m.id)) spawnSparkle(m.x, m.y, '#ce93d8');
  }
}

function spawnDamageText(x, y, text) {
  addParticle({
    kind: 'text',
    x, y,
    vx: (Math.random() - 0.5) * 30,
    vy: -70,
    g: 0,
    size: 17,
    text,
    color: '#ffeb3b',
    life: 0.8,
    maxLife: 0.8,
  });
}

// ---------- 파티클 ----------
function addParticle(p) {
  if (particles.length < 400) particles.push(p);
}

function spawnDebris(x, y) {
  for (let i = 0; i < 7; i++) {
    addParticle({
      kind: 'rect',
      x: x + (Math.random() - 0.5) * 14,
      y: y + (Math.random() - 0.5) * 14,
      vx: (Math.random() - 0.5) * 140,
      vy: -80 - Math.random() * 120,
      g: 500,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 10,
      size: 4 + Math.random() * 5,
      color: Math.random() < 0.5 ? '#c98944' : '#a9692c',
      life: 0.7,
      maxLife: 0.7,
    });
  }
}

function spawnDroplets(x, y, n) {
  for (let i = 0; i < n; i++) {
    addParticle({
      kind: 'dot',
      x, y,
      vx: (Math.random() - 0.5) * 180,
      vy: -60 - Math.random() * 160,
      g: 420,
      size: 2.5 + Math.random() * 3,
      color: Math.random() < 0.5 ? '#4fc3f7' : '#b3e5fc',
      life: 0.55,
      maxLife: 0.55,
    });
  }
}

function spawnSplash(x, y) {
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const sp = 90 + Math.random() * 130;
    addParticle({
      kind: 'dot',
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 60,
      g: 380,
      size: 3 + Math.random() * 3.5,
      color: ['#4fc3f7', '#81d4fa', '#e1f5fe'][i % 3],
      life: 0.8,
      maxLife: 0.8,
    });
  }
  addParticle({ kind: 'ring', x, y, size: 6, grow: 90, color: 'rgba(179,229,252,0.9)', life: 0.45, maxLife: 0.45 });
}

function spawnSparkle(x, y, color) {
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 70;
    addParticle({
      kind: 'star',
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 40,
      g: 120,
      size: 2 + Math.random() * 2.5,
      color,
      life: 0.6,
      maxLife: 0.6,
    });
  }
}

function updateParticles(dt) {
  const t = dt / 1000;
  const now = performance.now();
  // victory celebration: fireworks bursts + confetti rain
  if (now < celebrateUntil) {
    if (now >= nextFireworkAt) {
      nextFireworkAt = now + 280 + Math.random() * 220;
      const fx = 60 + Math.random() * (canvas.width - 120);
      const fy = 60 + Math.random() * (canvas.height * 0.45);
      const hue = ['#ff5252', '#ffd54f', '#4fc3f7', '#66bb6a', '#ec407a', '#ab47bc'][Math.floor(Math.random() * 6)];
      for (let i = 0; i < 22; i++) {
        const ang = (i / 22) * Math.PI * 2;
        const sp = 70 + Math.random() * 110;
        addParticle({
          kind: 'dot',
          x: fx, y: fy,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          g: 130,
          size: 2.5 + Math.random() * 2.5,
          color: hue,
          life: 0.9 + Math.random() * 0.4,
          maxLife: 1.3,
        });
      }
    }
    for (let i = 0; i < 2; i++) {
      addParticle({
        kind: 'confetti',
        x: Math.random() * canvas.width,
        y: -8,
        vx: (Math.random() - 0.5) * 60,
        vy: 90 + Math.random() * 120,
        g: 30,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 12,
        size: 4 + Math.random() * 4,
        color: ['#ff5252', '#ffd54f', '#4fc3f7', '#66bb6a', '#ec407a', '#fff'][Math.floor(Math.random() * 6)],
        life: 2.6,
        maxLife: 2.6,
      });
    }
  }
  // victory coin rain
  if (performance.now() < coinRainUntil) {
    for (let i = 0; i < 3; i++) {
      addParticle({
        kind: 'coin',
        x: Math.random() * canvas.width,
        y: -10,
        vx: (Math.random() - 0.5) * 40,
        vy: 120 + Math.random() * 160,
        g: 80,
        size: 5 + Math.random() * 4,
        color: Math.random() < 0.5 ? '#ffd54f' : '#ffb300',
        life: 2.4,
        maxLife: 2.4,
      });
    }
  }
  for (const p of particles) {
    p.life -= t;
    if (p.kind === 'ring') {
      p.size += p.grow * t;
      continue;
    }
    p.vy += p.g * t;
    p.x += p.vx * t;
    p.y += p.vy * t;
    if (p.vrot) p.rot += p.vrot * t;
  }
  particles = particles.filter((p) => p.life > 0);
}

function drawParticles() {
  for (const p of particles) {
    const a = Math.max(0, p.life / p.maxLife);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    if (p.kind === 'rect') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    } else if (p.kind === 'confetti') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    } else if (p.kind === 'ring') {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 3 * a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.kind === 'coin') {
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.size * Math.abs(Math.sin(p.life * 7)), p.size, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#a07800';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    } else if (p.kind === 'text') {
      ctx.font = `bold ${p.size}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillText(p.text, p.x, p.y);
    } else if (p.kind === 'star') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.life * 6);
      ctx.fillRect(-p.size, -p.size / 3, p.size * 2, (p.size / 3) * 2);
      ctx.fillRect(-p.size / 3, -p.size, (p.size / 3) * 2, p.size * 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---------- 입력 ----------
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};

document.addEventListener('keydown', (e) => {
  if (!inGame()) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) {
      const s = latest();
      const me = s && s.players.find((p) => p.id === socket.id);
      if (me && me.alive && !me.trapped) socket.emit('placeBomb');
    }
    return;
  }
  if (e.key === 'Control' || e.code === 'KeyX') {
    const s = latest();
    const me = s && s.players.find((p) => p.id === socket.id);
    if (me && me.alive && me.trapped && !e.repeat) socket.emit('useNeedle');
    e.preventDefault();
    return;
  }
  const dir = KEYMAP[e.code];
  if (dir) {
    keys[dir] = true;
    e.preventDefault();
  }
});

document.addEventListener('keyup', (e) => {
  const dir = KEYMAP[e.code];
  if (dir) keys[dir] = false;
});

window.addEventListener('blur', () => {
  keys.up = keys.down = keys.left = keys.right = false;
});

// ---------- 클라이언트 사이드 예측 ----------
function localTick() {
  const s = latest();
  if (!s || s.countdown > 0 || gameEnded) return;
  const me = s.players.find((p) => p.id === socket.id);
  if (!me || !me.alive || me.trapped) return;
  seq++;
  const cmd = { seq, keys: { up: keys.up, down: keys.down, left: keys.left, right: keys.right } };
  pending.push(cmd);
  if (pending.length > 90) pending.shift();
  socket.emit('cmd', cmd);
  if (myPred) Shared.moveTick(clientWorld, myPred, cmd.keys); // move instantly, server confirms later
}

// ---------- 원격 플레이어 보간 ----------
function renderServerMs() {
  if (!offsetSamples.length) return null;
  let off = Infinity;
  for (const o of offsetSamples) if (o < off) off = o;
  return performance.now() - off - INTERP_DELAY;
}

function straddle(rms) {
  let a = snapshots[0];
  let b = snapshots[snapshots.length - 1];
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].serverMs <= rms) {
      a = snapshots[i];
      b = snapshots[i + 1] || snapshots[i];
      break;
    }
  }
  const span = b.serverMs - a.serverMs;
  const t = span > 0 ? Math.min(1, Math.max(0, (rms - a.serverMs) / span)) : 1;
  return { a: a.s, b: b.s, t };
}

const lerp = (a, b, t) => a + (b - a) * t;

// ---------- 메인 루프 ----------
let lastFrame = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  if (!inGame() || !snapshots.length) return;

  acc += dt;
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    localTick();
  }

  // decay prediction error and screen shake
  const k = Math.exp(-dt / 80);
  errX *= k;
  errY *= k;
  shake *= Math.exp(-dt / 110);

  updateParticles(dt);
  render(now);
}

function render(now) {
  const s = latest();
  const rms = renderServerMs();
  const { a, b, t } = rms !== null ? straddle(rms) : { a: s, b: s, t: 1 };

  if (!bgDrawn) {
    drawBackground(s);
    bgDrawn = true;
  }

  ctx.save();
  if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

  ctx.drawImage(bgCanvas, 0, 0);

  // soft blocks (latest authoritative grid)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (s.grid[y][x] === 1) drawSoftBlock(x, y);
    }
  }

  drawTelegraphs(s, now);
  drawItems(s, now);
  drawStreams(s, now);
  drawBombs(a, b, t, now);
  if (s.boss) drawBoss(s, a, b, t, now);
  drawMinions(s, a, b, t, now);
  drawPlayers(s, a, b, t, now);
  drawParticles();
  if (s.boss) drawBossHpBar(s);
  drawBanner(now);
  drawCountdown(s, now);

  ctx.restore();
  renderUI(s, now);
}

// ---------- 보스전 ----------
function drawTelegraphs(s, now) {
  if (!s.telegraphs) return;
  for (const t of s.telegraphs) {
    const urgency = 1 - Math.min(1, t.left / 36);
    const pulse = 0.25 + 0.2 * Math.sin(now / 70) + urgency * 0.3;
    ctx.fillStyle = `rgba(255, 70, 60, ${pulse})`;
    rr(ctx, t.x * TILE + 3, t.y * TILE + 3, TILE - 6, TILE - 6, 6);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 220, 80, ${0.5 + urgency * 0.5})`;
    ctx.lineWidth = 2;
    rr(ctx, t.x * TILE + 3, t.y * TILE + 3, TILE - 6, TILE - 6, 6);
    ctx.stroke();
  }
}

function drawBoss(s, a, b, t, now) {
  const ab = a.boss || s.boss;
  const bb = b.boss || s.boss;
  const x = lerp(ab.x, bb.x, t);
  const y = lerp(ab.y, bb.y, t);
  const boss = s.boss;
  const groggy = boss.groggy;
  const charging = boss.charging;
  const bob = Math.sin(now / 350) * 4;
  const breathe = 1 + Math.sin(now / 280) * 0.03;
  const R = 52;

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(x, y + R - 6, R * 0.85, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(x, y + bob);
  ctx.scale(breathe, breathe);

  // tentacles
  const tone = groggy ? '#b39ddb' : boss.phase === 3 ? '#7e57c2' : '#9575cd';
  ctx.fillStyle = tone;
  for (let i = 0; i < 6; i++) {
    const tx = -R + 14 + i * ((R * 2 - 28) / 5);
    const sway = Math.sin(now / 200 + i * 1.3) * 5;
    ctx.beginPath();
    ctx.ellipse(tx + sway * 0.4, R - 16 + Math.abs(sway) * 0.4, 10, 16, sway * 0.02, 0, Math.PI * 2);
    ctx.fill();
  }

  // dome head
  const grad = ctx.createRadialGradient(-14, -22, 8, 0, -4, R + 8);
  grad.addColorStop(0, groggy ? '#d1c4e9' : '#b39ddb');
  grad.addColorStop(1, groggy ? '#9575cd' : boss.phase === 3 ? '#5e35b1' : '#7e57c2');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, -8, R - 4, R - 10, 0, Math.PI, 0);
  ctx.ellipse(0, -8, R - 4, (R - 10) * 0.72, 0, 0, Math.PI);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,20,80,0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // phase-3 rage glow
  if (boss.phase === 3 && !groggy) {
    ctx.strokeStyle = `rgba(255,82,82,${0.4 + 0.3 * Math.sin(now / 110)})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(0, -8, R + 2, R - 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // eyes
  if (groggy) {
    // dizzy X eyes
    ctx.strokeStyle = '#311b92';
    ctx.lineWidth = 3.5;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * 18 - 7, -22);
      ctx.lineTo(sx * 18 + 7, -8);
      ctx.moveTo(sx * 18 + 7, -22);
      ctx.lineTo(sx * 18 - 7, -8);
      ctx.stroke();
    }
  } else {
    for (const sx of [-1, 1]) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(sx * 18, -16, 11, 13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#311b92';
      ctx.beginPath();
      ctx.arc(sx * 18 + (charging ? 0 : 2), -13, 5.5, 0, Math.PI * 2);
      ctx.fill();
      // angry brows from phase 2
      if (boss.phase >= 2) {
        ctx.strokeStyle = '#311b92';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(sx * 8, -32);
        ctx.lineTo(sx * 28, -26);
        ctx.stroke();
      }
    }
  }

  // mouth: charges open when telegraphing
  ctx.fillStyle = '#311b92';
  ctx.beginPath();
  if (charging) {
    const o = 6 + Math.sin(now / 60) * 2;
    ctx.ellipse(0, 6, 9, o, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4fc3f7';
    ctx.beginPath();
    ctx.ellipse(0, 6, 5, o * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.arc(0, 4, 7, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#311b92';
    ctx.stroke();
  }

  ctx.restore();

  // groggy stars
  if (groggy) {
    for (let i = 0; i < 3; i++) {
      const ang = now / 300 + (i * Math.PI * 2) / 3;
      const sx = x + Math.cos(ang) * 34;
      const sy = y - R + 4 + Math.sin(ang) * 8;
      ctx.fillStyle = '#ffeb3b';
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(now / 250 + i);
      ctx.fillRect(-5, -1.7, 10, 3.4);
      ctx.fillRect(-1.7, -5, 3.4, 10);
      ctx.restore();
    }
  }
}

function drawMinions(s, a, b, t, now) {
  if (!s.minions) return;
  const prevById = new Map((a.minions || []).map((m) => [m.id, m]));
  for (const m of s.minions) {
    const bm = (b.minions || []).find((q) => q.id === m.id);
    const am = prevById.get(m.id);
    const x = am && bm ? lerp(am.x, bm.x, t) : m.x;
    const y = (am && bm ? lerp(am.y, bm.y, t) : m.y) + Math.sin(now / 180 + m.id) * 2;

    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y + 11, 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // spiky purple star creature
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(now / 260 + m.id) * 0.18);
    ctx.fillStyle = '#ab47bc';
    ctx.strokeStyle = 'rgba(60,10,80,0.55)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 13 : 7.5;
      const ang = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const px = Math.cos(ang) * r;
      const py = Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-3.5, -1, 2.6, 0, Math.PI * 2);
    ctx.arc(3.5, -1, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(-3.5, -0.6, 1.3, 0, Math.PI * 2);
    ctx.arc(3.5, -0.6, 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawBossHpBar(s) {
  const { hp, maxHp, phase, groggy } = s.boss;
  const w = 320;
  const x = (canvas.width - w) / 2;
  const y = 10;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  rr(ctx, x - 8, y - 4, w + 16, 26, 10);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  rr(ctx, x, y + 4, w, 12, 6);
  ctx.fill();
  const ratio = hp / maxHp;
  if (ratio > 0) {
    ctx.fillStyle = groggy ? '#ffee58' : ratio > 2 / 3 ? '#66bb6a' : ratio > 1 / 3 ? '#ffa726' : '#ef5350';
    rr(ctx, x, y + 4, Math.max(8, w * ratio), 12, 6);
    ctx.fill();
  }
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 3;
  const label = `👾 킹 옥토  ${hp}/${maxHp}${groggy ? ' (그로기!)' : ''}  P${phase}`;
  ctx.strokeText(label, canvas.width / 2, y + 13);
  ctx.fillText(label, canvas.width / 2, y + 13);
}

function drawBanner(now) {
  if (!banner || now > banner.until) return;
  const a = Math.min(1, (banner.until - now) / 500);
  ctx.globalAlpha = a;
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'center';
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 6;
  ctx.fillStyle = '#ffca28';
  ctx.strokeText(banner.text, canvas.width / 2, 90);
  ctx.fillText(banner.text, canvas.width / 2, 90);
  ctx.globalAlpha = 1;
}

// ---------- 배경 (정적 레이어 프리렌더) ----------
function drawBackground(s) {
  const g = bgCanvas.getContext('2d');
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#b5e07e' : '#a8d873';
      g.fillRect(x * TILE, y * TILE, TILE, TILE);
      if ((x * 7 + y * 13) % 11 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.beginPath();
        g.arc(x * TILE + 9 + ((x * 13) % 18), y * TILE + 9 + ((y * 17) % 18), 1.6, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  // hard blocks never change during a round
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (s.grid[y][x] === 2) drawHardBlock(g, x, y);
    }
  }
  const v = g.createRadialGradient(300, 260, 220, 300, 260, 420);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,40,30,0.22)');
  g.fillStyle = v;
  g.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
}

function drawHardBlock(g, x, y) {
  const px = x * TILE;
  const py = y * TILE;
  g.fillStyle = 'rgba(0,0,0,0.22)';
  rr(g, px + 3, py + 5, TILE - 4, TILE - 6, 7);
  g.fill();
  g.fillStyle = '#8d6e63';
  rr(g, px + 2, py + 2, TILE - 4, TILE - 4, 7);
  g.fill();
  g.fillStyle = '#a1887f';
  rr(g, px + 2, py + 2, TILE - 4, TILE - 12, 7);
  g.fill();
  g.fillStyle = '#bcaaa4';
  rr(g, px + 7, py + 6, TILE - 14, 7, 4);
  g.fill();
  g.strokeStyle = '#5d4037';
  g.lineWidth = 2;
  rr(g, px + 2, py + 2, TILE - 4, TILE - 4, 7);
  g.stroke();
}

function drawSoftBlock(x, y) {
  const px = x * TILE;
  const py = y * TILE;
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  rr(ctx, px + 4, py + 6, TILE - 6, TILE - 8, 6);
  ctx.fill();
  ctx.fillStyle = '#d9a05b';
  rr(ctx, px + 3, py + 3, TILE - 6, TILE - 6, 6);
  ctx.fill();
  ctx.fillStyle = '#e8bd80';
  rr(ctx, px + 3, py + 3, TILE - 6, 12, 6);
  ctx.fill();
  ctx.strokeStyle = '#8d5a24';
  ctx.lineWidth = 2;
  rr(ctx, px + 3, py + 3, TILE - 6, TILE - 6, 6);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(141,90,36,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px + 7, py + TILE / 2 + 1);
  ctx.lineTo(px + TILE - 7, py + TILE / 2 + 1);
  ctx.moveTo(px + TILE / 2, py + 7);
  ctx.lineTo(px + TILE / 2, py + TILE - 7);
  ctx.stroke();
}

// ---------- 아이템 ----------
function drawItems(s, now) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const item of s.items) {
    const cx = item.x * TILE + TILE / 2;
    const bobP = (item.x * 31 + item.y * 17) % 7;
    const bob = Math.sin(now / 320 + bobP) * 2.5;
    const cy = item.y * TILE + TILE / 2 + bob;
    if (item.type === 'ultra' || item.type === 'needle') {
      const pulse = 0.5 + 0.5 * Math.sin(now / 200 + bobP);
      ctx.fillStyle = `rgba(255, 235, 130, ${0.25 + pulse * 0.2})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 17 + pulse * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(cx, item.y * TILE + TILE - 6, 10, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    rr(ctx, cx - 14, cy - 14, 28, 28, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    rr(ctx, cx - 14, cy - 14, 28, 28, 9);
    ctx.stroke();
    ctx.font = '19px serif';
    ctx.fillText(ITEM_EMOJI[item.type] || '?', cx, cy + 1);
  }
}

// ---------- 물풍선 ----------
function drawBombs(a, b, t, now) {
  const prevById = new Map(a.bombs.map((x) => [x.id, x]));
  for (const bomb of b.bombs) {
    const old = prevById.get(bomb.id) || bomb;
    const px = lerp(old.px, bomb.px, t);
    const py = lerp(old.py, bomb.py, t);
    const urgent = bomb.t < 30;
    const wob = Math.sin(now / (urgent ? 70 : 140) + bomb.id * 1.7);
    const sx = 1 + 0.08 * wob;
    const sy = 1 - 0.08 * wob;
    const r = 15.5;

    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(px, py + 14, 11 * sx, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(px, py + 2);
    ctx.scale(sx, sy);
    const grad = ctx.createRadialGradient(-5, -6, 2, 0, 0, r + 3);
    grad.addColorStop(0, urgent ? '#90caf9' : '#7ec8f7');
    grad.addColorStop(1, urgent && Math.floor(now / 130) % 2 === 0 ? '#ef5350' : '#1e88e5');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 1.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1565c0';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.ellipse(-5.5, -6, 4, 6, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1565c0';
    ctx.beginPath();
    ctx.arc(0, -r - 2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------- 물줄기 ----------
function drawStreams(s, now) {
  const set = new Set(s.streams.map((w) => `${w.x},${w.y}`));
  for (const w of s.streams) {
    const born = streamBorn.get(`${w.x},${w.y}`) || now;
    const age = (now - born) / 1000;
    const grow = Math.min(1, age / 0.07);
    const fade = w.left < 6 ? w.left / 6 : 1;
    const width = (15 + Math.sin(now / 55 + w.x + w.y) * 1.5) * grow * (0.55 + 0.45 * fade);
    const cx = w.x * TILE + TILE / 2;
    const cy = w.y * TILE + TILE / 2;
    const E = set.has(`${w.x + 1},${w.y}`);
    const W = set.has(`${w.x - 1},${w.y}`);
    const N = set.has(`${w.x},${w.y - 1}`);
    const S = set.has(`${w.x},${w.y + 1}`);

    for (const [color, k] of [['rgba(41,142,235,0.88)', 1], ['rgba(179,229,252,0.92)', 0.52]]) {
      const wd = width * k;
      ctx.fillStyle = color;
      const x0 = W ? w.x * TILE : cx - wd;
      const x1 = E ? (w.x + 1) * TILE : cx + wd;
      const y0 = N ? w.y * TILE : cy - wd;
      const y1 = S ? (w.y + 1) * TILE : cy + wd;
      if (E || W || (!N && !S)) {
        rr(ctx, x0, cy - wd, x1 - x0, wd * 2, wd);
        ctx.fill();
      }
      if (N || S) {
        rr(ctx, cx - wd, y0, wd * 2, y1 - y0, wd);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, wd * 1.06, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------- 플레이어 ----------
function drawPlayers(s, a, b, t, now) {
  const rms = renderServerMs();
  const prevById = new Map(a.players.map((p) => [p.id, p]));
  for (const p of s.players) {
    if (!p.alive) continue;
    let x;
    let y;
    if (p.id === socket.id && myPred && !p.trapped) {
      x = myPred.x + errX;
      y = myPred.y + errY;
    } else if (p.id === socket.id) {
      x = p.x;
      y = p.y;
    } else {
      const bp = b.players.find((q) => q.id === p.id);
      const ap = prevById.get(p.id);
      if (bp && ap) {
        x = lerp(ap.x, bp.x, t);
        y = lerp(ap.y, bp.y, t);
      } else {
        x = p.x;
        y = p.y;
      }
    }

    let anim = playerAnim.get(p.id);
    if (!anim) {
      anim = { bob: 0, dirX: 0, dirY: 1, lastX: x, lastY: y, moveAmt: 0 };
      playerAnim.set(p.id, anim);
    }
    const mvx = x - anim.lastX;
    const mvy = y - anim.lastY;
    const moving = Math.hypot(mvx, mvy) > 0.25;
    if (moving) {
      anim.bob += Math.hypot(mvx, mvy) * 0.13;
      const m = Math.hypot(mvx, mvy);
      anim.dirX = mvx / m;
      anim.dirY = mvy / m;
    }
    anim.moveAmt = Math.max(0, Math.min(1, anim.moveAmt + (moving ? 0.2 : -0.15)));
    anim.lastX = x;
    anim.lastY = y;

    drawCharacter(x, y, p, anim, now, rms);
  }
}

function drawCharacter(x, y, p, anim, now) {
  const color = p.team ? TEAM_COLORS[p.team] : CHARACTERS[p.char || 0].color;
  const isMe = p.id === socket.id;
  const dancing = gameEnded && winnerId === p.id;
  let bounce = Math.abs(Math.sin(anim.bob)) * 3 * anim.moveAmt;
  const breathe = 1 + Math.sin(now / 420 + p.color) * 0.02;
  let squash = 1 + Math.sin(anim.bob * 2) * 0.07 * anim.moveAmt;
  if (dancing) {
    // victory hops!
    bounce = Math.abs(Math.sin(now / 130)) * 10;
    squash = 1 + Math.sin(now / 130 + Math.PI / 2) * 0.12;
  }
  const float = p.trapped ? Math.sin(now / 300) * 3 : 0;
  const by = y - bounce + float;

  if (dancing) {
    // sparkles around the champion
    if (Math.random() < 0.15) spawnSparkle(x + (Math.random() - 0.5) * 40, by - 10, '#ffe082');
  }

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, y + 13, 11 / squash, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(x, by);
  ctx.scale((1 / squash) * breathe, squash * breathe);
  drawAvatar(ctx, p.char || 0, color, anim.dirX, anim.dirY);
  ctx.restore();

  // trapped bubble
  if (p.trapped) {
    const wobble = Math.sin(now / 160) * 1.4;
    const bg = ctx.createRadialGradient(x - 5, by - 6, 3, x, by, 22);
    bg.addColorStop(0, 'rgba(225,245,254,0.55)');
    bg.addColorStop(1, 'rgba(79,195,247,0.35)');
    ctx.fillStyle = bg;
    ctx.strokeStyle = 'rgba(129,212,250,0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, by, 20 + wobble, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.ellipse(x - 7, by - 9, 3.5, 5.5, -0.6, 0, Math.PI * 2);
    ctx.fill();
    // remaining-time arc
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, by, 24, -Math.PI / 2, -Math.PI / 2 + (p.trapLeft / TRAP_TICKS) * Math.PI * 2);
    ctx.stroke();
    if (p.id === socket.id && p.needles > 0) {
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      const hint = 'Ctrl/X 탈출!';
      ctx.strokeText(hint, x, by - 34);
      ctx.fillText(hint, x, by - 34);
    }
  }

  // nickname
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 3;
  ctx.fillStyle = isMe ? '#ffe082' : '#fff';
  ctx.strokeText(p.nick, x, by - 23);
  ctx.fillText(p.nick, x, by - 23);
}

// Draws one character centered at (0,0), body radius 13. bodyColor follows
// the character palette in FFA and the team color in team mode.
function drawAvatar(g, charId, bodyColor, dirX, dirY) {
  const outline = 'rgba(0,0,0,0.35)';
  g.lineWidth = 2;

  // behind-the-body features
  if (charId === 0) {
    // bunny ears
    for (const sx of [-1, 1]) {
      g.fillStyle = bodyColor;
      g.strokeStyle = outline;
      g.beginPath();
      g.ellipse(sx * 5.5, -16, 4, 9.5, sx * 0.18, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = '#f8bbd0';
      g.beginPath();
      g.ellipse(sx * 5.5, -15, 2, 6, sx * 0.18, 0, Math.PI * 2);
      g.fill();
    }
  } else if (charId === 1) {
    // cat ears
    for (const sx of [-1, 1]) {
      g.fillStyle = bodyColor;
      g.strokeStyle = outline;
      g.beginPath();
      g.moveTo(sx * 3.5, -11.5);
      g.lineTo(sx * 12, -17.5);
      g.lineTo(sx * 12.5, -7);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#ffe0b2';
      g.beginPath();
      g.moveTo(sx * 6.5, -11.2);
      g.lineTo(sx * 10.8, -14.6);
      g.lineTo(sx * 11, -9);
      g.closePath();
      g.fill();
    }
  } else if (charId === 3) {
    // bear ears
    for (const sx of [-1, 1]) {
      g.fillStyle = bodyColor;
      g.strokeStyle = outline;
      g.beginPath();
      g.arc(sx * 9, -11, 4.8, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(255,235,210,0.8)';
      g.beginPath();
      g.arc(sx * 9, -11, 2.3, 0, Math.PI * 2);
      g.fill();
    }
  } else if (charId === 5) {
    // robot antenna
    g.strokeStyle = '#546e7a';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(0, -12);
    g.lineTo(0, -18);
    g.stroke();
    g.fillStyle = '#ff5252';
    g.beginPath();
    g.arc(0, -19.5, 2.6, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 2;
  }

  // body
  const grad = g.createRadialGradient(-4, -6, 2, 0, 0, 16);
  grad.addColorStop(0, lighten(bodyColor, 0.35));
  grad.addColorStop(1, bodyColor);
  g.fillStyle = grad;
  g.strokeStyle = outline;
  g.beginPath();
  g.arc(0, 0, 13, 0, Math.PI * 2);
  g.fill();
  g.stroke();

  // belly (penguin gets a big white one)
  g.fillStyle = charId === 4 ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.45)';
  g.beginPath();
  if (charId === 4) g.ellipse(0, 4, 8.5, 8, 0, 0, Math.PI * 2);
  else g.ellipse(0, 6, 7, 5, 0, 0, Math.PI * 2);
  g.fill();

  // eyes track movement direction (frog eyes sit on top bumps)
  const ex = dirX * 2.2;
  const frog = charId === 2;
  const eyeY = (frog ? -10.5 : -3) + dirY * 1.6;
  const eyeDX = frog ? 5.5 : 4.5;
  if (frog) {
    g.fillStyle = bodyColor;
    g.strokeStyle = outline;
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.arc(sx * 5.5, -10.5, 4.6, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }
  if (charId === 5) {
    // square LED eyes
    g.fillStyle = '#263238';
    g.fillRect(-8, -7, 6.5, 6.5);
    g.fillRect(1.5, -7, 6.5, 6.5);
    g.fillStyle = '#69f0ae';
    g.fillRect(-7 + ex * 0.6, -6 + dirY, 4, 4);
    g.fillRect(2.5 + ex * 0.6, -6 + dirY, 4, 4);
  } else {
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(-eyeDX + ex * 0.4, eyeY, 3.6, 0, Math.PI * 2);
    g.arc(eyeDX + ex * 0.4, eyeY, 3.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#222';
    g.beginPath();
    g.arc(-eyeDX + ex, eyeY + dirY * 1.2, 1.9, 0, Math.PI * 2);
    g.arc(eyeDX + ex, eyeY + dirY * 1.2, 1.9, 0, Math.PI * 2);
    g.fill();
  }

  // blush
  if (charId !== 5) {
    g.fillStyle = 'rgba(255,160,160,0.5)';
    g.beginPath();
    g.arc(-8.5, 1.5, 2.2, 0, Math.PI * 2);
    g.arc(8.5, 1.5, 2.2, 0, Math.PI * 2);
    g.fill();
  }

  // mouth / muzzle / beak / whiskers
  if (charId === 1) {
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 1.2;
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.moveTo(sx * 9, 2.5);
      g.lineTo(sx * 15, 1);
      g.moveTo(sx * 9, 4.5);
      g.lineTo(sx * 15, 5);
      g.stroke();
    }
  }
  if (charId === 3) {
    g.fillStyle = 'rgba(255,235,210,0.9)';
    g.beginPath();
    g.ellipse(0, 4, 5.5, 4.2, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#5d4037';
    g.beginPath();
    g.ellipse(0, 2.5, 2, 1.5, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (charId === 4) {
    g.fillStyle = '#ffa726';
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-4, -1);
    g.lineTo(4, -1);
    g.lineTo(0, 3.5);
    g.closePath();
    g.fill();
    g.stroke();
  } else if (charId === 5) {
    g.strokeStyle = '#546e7a';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(-4, 5);
    g.lineTo(4, 5);
    g.moveTo(-3, 7.5);
    g.lineTo(3, 7.5);
    g.stroke();
  } else if (charId !== 3) {
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(0, 3.2, frog ? 4 : 2.6, 0.2 * Math.PI, 0.8 * Math.PI);
    g.stroke();
  }
}

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (n >> 16) + 255 * amt);
  const g = Math.min(255, ((n >> 8) & 255) + 255 * amt);
  const b = Math.min(255, (n & 255) + 255 * amt);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function rr(g, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + h, rad);
  g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
}

// ---------- 카운트다운 / GO ----------
function drawCountdown(s, now) {
  if (s.countdown > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const num = Math.ceil(s.countdown / 30);
    const frac = (s.countdown % 30) / 30 || 1;
    const scale = 1 + (1 - frac) * 0.45;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 0.4 + frac * 0.6;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 84px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(21,101,192,0.8)';
    ctx.lineWidth = 8;
    ctx.strokeText(String(num), 0, 0);
    ctx.fillText(String(num), 0, 0);
    ctx.restore();
  } else if (now < goFlashUntil) {
    const a = (goFlashUntil - now) / 700;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(1 + (1 - a) * 0.8, 1 + (1 - a) * 0.8);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffe082';
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 8;
    ctx.strokeText('GO!', 0, 0);
    ctx.fillText('GO!', 0, 0);
    ctx.restore();
  }
}

// ---------- 인게임 UI (사이드바 + 하단 바) ----------
const cardEls = new Map(); // playerId -> {root, stats, status}
let lastUiUpdate = 0;

function buildPlayerCards(roster) {
  const wrap = $('#player-cards');
  wrap.innerHTML = '';
  cardEls.clear();
  roster.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'p-card';
    if (p.id === socket.id) card.classList.add('me');
    if (p.team) card.classList.add(p.team === 'blue' ? 'team-blue' : 'team-red');

    const cv = document.createElement('canvas');
    cv.width = 36;
    cv.height = 36;
    const g = cv.getContext('2d');
    g.translate(18, 20);
    g.scale(0.95, 0.95);
    const color = p.team ? TEAM_COLORS[p.team] : CHARACTERS[p.char || 0].color;
    drawAvatar(g, p.char || 0, color, 0, 0.3);

    const info = document.createElement('div');
    info.className = 'p-info';
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = p.nick + (p.id === socket.id ? ' (나)' : '');
    const stats = document.createElement('div');
    stats.className = 'p-stats';
    stats.textContent = '🎈1 💧1 🛼0';
    info.appendChild(name);
    info.appendChild(stats);

    const status = document.createElement('div');
    status.className = 'p-status';

    card.appendChild(cv);
    card.appendChild(info);
    card.appendChild(status);
    wrap.appendChild(card);
    cardEls.set(p.id, { root: card, stats, status });
  });
}

function renderUI(s, now) {
  if (now - lastUiUpdate < 120) return;
  lastUiUpdate = now;

  // timer
  const secs = Math.ceil(s.timeLeft / 30);
  const timer = $('#timer');
  timer.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  timer.classList.toggle('urgent', secs <= 20);

  // player cards
  for (const p of s.players) {
    const el = cardEls.get(p.id);
    if (!el) continue;
    el.stats.textContent = `🎈${p.maxBombs} 💧${p.power} 🛼${p.speedLvl}${p.hasShoes ? ' 👟' : ''}`;
    el.root.classList.toggle('dead', !p.alive);
    el.status.textContent = !p.alive ? '💀' : p.trapped ? '💧' : '';
  }

  // sidebar ITEM box: usable item (needle)
  const me = s.players.find((p) => p.id === socket.id);
  const slot = $('#item-slot');
  if (me && me.alive && me.needles > 0) {
    slot.innerHTML = `🪡<span class="count">x${me.needles}</span>`;
  } else {
    slot.innerHTML = '<span class="empty">없음</span>';
  }

  // bottom bar: my loadout
  const bb = $('#bb-slots');
  if (!me) {
    bb.innerHTML = '<div class="bb-slot off">관전 중</div>';
  } else {
    bb.innerHTML =
      `<div class="bb-slot">🎈<span class="n">${me.maxBombs}</span></div>` +
      `<div class="bb-slot">💧<span class="n">${me.power}</span></div>` +
      `<div class="bb-slot">🛼<span class="n">${me.speedLvl}</span></div>` +
      `<div class="bb-slot${me.needles ? '' : ' off'}">🪡<span class="n">${me.needles}</span></div>` +
      `<div class="bb-slot${me.hasShoes ? '' : ' off'}">👟</div>`;
  }
}

$('#btn-exit').addEventListener('click', () => {
  socket.emit('leaveRoom');
  showScreen('lobby');
});
$('#btn-help').addEventListener('click', () => $('#guide').classList.toggle('hidden'));
$('#btn-guide-close').addEventListener('click', () => $('#guide').classList.add('hidden'));

requestAnimationFrame(frame);
