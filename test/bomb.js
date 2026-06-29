const { io } = require('socket.io-client');

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
setTimeout(() => fail('timed out'), 20000);

const URL = process.env.URL || process.argv[2] || 'http://localhost:3000';
const a = io(URL);
let seq = 0;
let phase = 'wait';
let placedAt = 0;
let lastX = null;

a.on('connect', () => {
  a.emit('setNick', 'BombTester');
  a.emit('createRoom', '풍선테스트');
});
a.on('joinedRoom', () => a.emit('startGame'));
a.on('errorMsg', (m) => fail(m));

const keys = { up: false, down: false, left: false, right: false };
setInterval(() => {
  if (phase === 'right' || phase === 'left') {
    a.emit('cmd', { seq: ++seq, keys });
  }
}, 33);

a.on('state', (s) => {
  const me = s.players.find((p) => p.id === a.id);
  if (!me) return;
  lastX = me.x;

  if (phase === 'wait' && s.countdown === 0) {
    // spawn is cell (0,0): drop a balloon underfoot, then walk off to the right
    a.emit('placeBomb');
    placedAt = Date.now();
    phase = 'right';
    keys.right = true;
    setTimeout(() => {
      keys.right = false;
      keys.left = true;
      phase = 'left';
    }, 450);
    setTimeout(() => {
      phase = 'done';
      console.log(`x after walking back into own balloon: ${lastX}`);
      if (lastX < 52) fail(`traversed own balloon (x=${lastX}, expected >= 52)`);
      console.log('PASS');
      process.exit(0);
    }, 2300);
  }
});
