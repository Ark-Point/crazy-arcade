const { io } = require('socket.io-client');

const URL = process.env.URL || process.argv[2] || 'http://localhost:3000';
const socket = io(URL);

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

setTimeout(() => fail('test timed out'), 8000);

socket.on('connect', () => {
  socket.emit('setNick', 'SoloTeam');
  socket.emit('createRoom', '팀전솔로거부');
});

socket.on('joinedRoom', () => {
  socket.emit('setMode', 'team');
});

let requestedStart = false;
socket.on('roomUpdate', (room) => {
  if (!requestedStart && room.mode === 'team' && room.players.length === 1) {
    requestedStart = true;
    socket.emit('startGame');
  }
});

socket.on('gameStart', () => fail('solo team game should not start'));

socket.on('errorMsg', (msg) => {
  if (!msg.includes('최소 2명')) fail('unexpected error: ' + msg);
  console.log('expected rejection:', msg);
  console.log('PASS');
  process.exit(0);
});
