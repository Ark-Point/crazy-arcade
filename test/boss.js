// Boss mode test: solo player starts a boss room and idles.
// Expected loop: boss present -> telegraph appears -> splash lands ->
// player gets bubbled -> trap expires -> wipe -> gameOver(reason bossWipe).
const { io } = require('socket.io-client');

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
setTimeout(() => fail('timed out (no bossWipe within 40s)'), 40000);

const URL = process.env.URL || process.argv[2] || 'http://localhost:3000';
const a = io(URL);

let sawBoss = false;
let sawTelegraph = false;
let sawSplash = false;
let sawTrapped = false;
let maxHp = 0;

a.on('connect', () => {
  a.emit('setNick', 'BossTester');
  a.emit('createRoom', '보스테스트');
});
a.on('joinedRoom', () => a.emit('setMode', 'boss'));
a.on('roomUpdate', (room) => {
  if (room.mode === 'boss' && room.state === 'waiting' && !a._started) {
    a._started = true;
    a.emit('startGame');
  }
});
a.on('errorMsg', (m) => fail(m));

a.on('state', (s) => {
  if (s.boss) {
    sawBoss = true;
    maxHp = s.boss.maxHp;
    if (s.boss.hp > s.boss.maxHp) fail('boss hp above max');
  }
  if (s.telegraphs && s.telegraphs.length) sawTelegraph = true;
  if (sawTelegraph && s.streams.length) sawSplash = true;
  const me = s.players.find((p) => p.id === a.id);
  if (me && me.trapped) sawTrapped = true;
});

a.on('gameOver', ({ reason }) => {
  console.log(
    `boss(maxHp=${maxHp}): ${sawBoss}, telegraph: ${sawTelegraph}, splash: ${sawSplash}, trapped: ${sawTrapped}, gameOver: ${reason}`
  );
  if (!sawBoss) fail('boss never appeared in state');
  if (!sawTelegraph) fail('no telegraph was broadcast');
  if (!sawSplash) fail('no splash landed');
  if (!sawTrapped) fail('player was never bubbled by the splash');
  if (reason !== 'bossWipe') fail('expected bossWipe, got ' + reason);
  if (maxHp !== 27) fail('solo boss maxHp expected 27 (18+9), got ' + maxHp);
  console.log('PASS');
  process.exit(0);
});
