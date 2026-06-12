// Smoke test: two clients create/join a room, start a game,
// move and drop bombs, and we assert state ticks flow without errors.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

setTimeout(() => fail('test timed out'), 20000);

const a = io(URL);
const b = io(URL);

let stateCount = 0;
let sawCountdownEnd = false;
let sawBomb = false;
let sawStream = false;

a.on('connect_error', (e) => fail('client A connect error: ' + e.message));
b.on('connect_error', (e) => fail('client B connect error: ' + e.message));

a.on('connect', () => {
  a.emit('setNick', 'TesterA');
  a.emit('createRoom', '테스트방');
});

a.on('joinedRoom', (room) => {
  console.log('A joined room', room.id);
  b.emit('setNick', 'TesterB');
  b.emit('joinRoom', room.id);
});

b.on('joinedRoom', (room) => {
  console.log('B joined room, players:', room.players.map((p) => p.nick).join(', '));
  if (room.players.length !== 2) fail('expected 2 players in room');
  a.emit('startGame');
});

a.on('gameStart', () => {
  console.log('game started');
  // stream movement commands at ~tick rate and drop bombs once the countdown is over
  let seqA = 0;
  let seqB = 0;
  const moveTimer = setInterval(() => {
    a.emit('cmd', { seq: ++seqA, keys: { right: true } });
    b.emit('cmd', { seq: ++seqB, keys: { left: true } });
  }, 34);
  const bombTimer = setInterval(() => {
    a.emit('placeBomb');
    b.emit('placeBomb');
  }, 400);
  setTimeout(() => {
    clearInterval(moveTimer);
    clearInterval(bombTimer);
  }, 12000);
});

let firstX = null;
let lastX = null;
let lastSeqAck = 0;

a.on('state', (s) => {
  stateCount++;
  if (s.countdown === 0) sawCountdownEnd = true;
  if (s.bombs.length > 0) sawBomb = true;
  if (s.streams.length > 0) sawStream = true;
  if (!Array.isArray(s.grid) || s.grid.length !== 13 || s.grid[0].length !== 15) {
    fail('bad grid shape');
  }
  if (s.players.length !== 2) fail('expected 2 players in state');
  const me = s.players.find((p) => p.id === a.id);
  if (me && s.countdown === 0) {
    if (firstX === null) firstX = me.x;
    lastX = me.x;
    lastSeqAck = me.seq;
  }
});

a.on('errorMsg', (m) => fail('server error for A: ' + m));
b.on('errorMsg', (m) => fail('server error for B: ' + m));

setTimeout(() => {
  console.log(`states received: ${stateCount}, countdownEnded: ${sawCountdownEnd}, bombSeen: ${sawBomb}, streamSeen: ${sawStream}`);
  console.log(`movement: x ${firstX} -> ${lastX}, last acked seq: ${lastSeqAck}`);
  if (stateCount < 100) fail('too few state ticks');
  if (!sawCountdownEnd) fail('countdown never ended');
  if (!sawBomb) fail('no bomb was ever placed');
  if (!sawStream) fail('no explosion stream observed');
  if (firstX === lastX) fail('player never moved (cmd queue broken)');
  if (lastSeqAck === 0) fail('server never acked input seq (reconciliation broken)');
  console.log('PASS');
  process.exit(0);
}, 10000);
