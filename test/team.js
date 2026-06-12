// Team mode test: host switches room to team mode, both players check team
// assignment, game starts with teams, and team info flows through state.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

setTimeout(() => fail('test timed out'), 15000);

const a = io(URL);
const b = io(URL);

a.on('connect', () => {
  a.emit('setNick', 'RedHost');
  a.emit('createRoom', '팀전테스트');
});

a.on('joinedRoom', (room) => {
  b.emit('setNick', 'BluePal');
  b.emit('joinRoom', room.id);
});

let modeSet = false;
b.on('joinedRoom', () => {
  a.emit('setMode', 'team');
});

a.on('roomUpdate', (room) => {
  if (room.mode === 'team' && !modeSet) {
    modeSet = true;
    const teams = room.players.map((p) => p.team).sort();
    console.log('teams after rebalance:', teams.join(','));
    if (!(teams.includes('red') && teams.includes('blue'))) fail('teams not balanced');
    // both on red should block start
    b.emit('setTeam', 'red');
  }
  if (modeSet && room.players.every((p) => p.team === 'red') && room.state === 'waiting') {
    a.emit('startGame'); // should be rejected
    setTimeout(() => {
      b.emit('setTeam', 'blue');
      setTimeout(() => a.emit('startGame'), 200);
    }, 400);
  }
});

let sawError = false;
a.on('errorMsg', (m) => {
  console.log('expected rejection:', m);
  sawError = true;
});

a.on('gameStart', ({ players }) => {
  console.log('game started with teams:', players.map((p) => `${p.nick}`).join(', '));
});

let checked = false;
a.on('state', (s) => {
  if (checked || s.countdown > 0) return;
  checked = true;
  const teams = s.players.map((p) => p.team).sort();
  if (!(teams.includes('red') && teams.includes('blue'))) fail('state missing team info: ' + JSON.stringify(teams));
  if (!sawError) fail('same-team start was not rejected');
  console.log('state carries teams:', teams.join(','));
  console.log('PASS');
  process.exit(0);
});
