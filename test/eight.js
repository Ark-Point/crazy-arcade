// 4v4 capacity test: 8 clients join one room, switch to team mode (4/4 split),
// start, and verify 8 players spawn at distinct positions.
const { io } = require('socket.io-client');

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
setTimeout(() => fail('timed out'), 20000);

const clients = [];
let roomId = null;
let joined = 0;

const host = io('http://localhost:3000');
clients.push(host);

host.on('connect', () => {
  host.emit('setNick', 'P1');
  host.emit('createRoom', '8인테스트');
});

host.on('joinedRoom', (room) => {
  roomId = room.id;
  for (let i = 2; i <= 8; i++) {
    const c = io('http://localhost:3000');
    clients.push(c);
    c.on('connect', () => {
      c.emit('setNick', 'P' + i);
      c.emit('joinRoom', roomId);
    });
    c.on('joinedRoom', () => {
      joined++;
      if (joined === 7) host.emit('setMode', 'team');
    });
    c.on('errorMsg', (m) => fail('join error: ' + m));
  }
});

let started = false;
host.on('roomUpdate', (room) => {
  if (room.mode === 'team' && room.players.length === 8 && !started) {
    const red = room.players.filter((p) => p.team === 'red').length;
    const blue = room.players.filter((p) => p.team === 'blue').length;
    console.log(`team split: red ${red} vs blue ${blue}`);
    if (red !== 4 || blue !== 4) fail(`expected 4v4 split, got ${red}v${blue}`);
    started = true;
    host.emit('startGame');
  }
});

host.on('errorMsg', (m) => fail(m));

host.on('state', (s) => {
  if (s.players.length !== 8) fail('expected 8 players in state, got ' + s.players.length);
  const positions = new Set(s.players.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
  if (s.t < 5 && positions.size !== 8) fail('spawn positions overlap: ' + positions.size);
  if (s.t > 10) {
    console.log(`8 players in game, ${positions.size} distinct spawn positions`);
    console.log('PASS');
    clients.forEach((c) => c.close());
    process.exit(0);
  }
});
