const assert = require('assert');
const { io } = require('socket.io-client');

const URL = process.env.URL || process.argv[2] || 'http://localhost:3000';

function fail(message) {
  console.error('FAIL:', message);
  process.exit(1);
}

function waitForEvent(socket, event, predicate, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    function onEvent(payload) {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

function emitWithAck(socket, event, payload, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, response) => {
      if (err) {
        reject(new Error(`${event} ack timed out: ${err.message || err}`));
        return;
      }
      resolve(response);
    });
  });
}

async function main() {
  const a = io(URL);
  const b = io(URL);
  const cleanup = () => {
    a.close();
    b.close();
  };
  process.on('exit', cleanup);
  setTimeout(() => fail('test timed out'), 15000);

  a.on('connect_error', (error) => fail(`client A connect error: ${error.message}`));
  b.on('connect_error', (error) => fail(`client B connect error: ${error.message}`));
  a.on('errorMsg', (message) => fail(`server error for A: ${message}`));
  b.on('errorMsg', (message) => fail(`server error for B: ${message}`));

  await Promise.all([
    waitForEvent(a, 'connect', null, 'client A connect'),
    waitForEvent(b, 'connect', null, 'client B connect'),
  ]);

  a.emit('setNick', 'ChatA');
  b.emit('setNick', 'ChatB');
  a.emit('createRoom', '채팅방');
  const room = await waitForEvent(a, 'joinedRoom', null, 'host joined');
  b.emit('joinRoom', room.id);
  await waitForEvent(b, 'joinedRoom', (joined) => joined.id === room.id, 'guest joined');

  let blankBroadcasted = false;
  b.once('chatMessage', () => {
    blankBroadcasted = true;
  });
  const blankAck = await emitWithAck(a, 'chatMessage', { text: '   ' });
  assert.deepStrictEqual(blankAck, { ok: false, error: 'empty message' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(blankBroadcasted, false, 'blank chat should not broadcast');

  const longText = '가'.repeat(160);
  const longReceived = waitForEvent(
    b,
    'chatMessage',
    (message) => message && message.text && message.text.startsWith('가'),
    'long chat broadcast'
  );
  const longAck = await emitWithAck(a, 'chatMessage', { text: longText });
  assert.strictEqual(longAck.ok, true, `long message ack should be ok: ${JSON.stringify(longAck)}`);
  const longMessage = await longReceived;
  assert.strictEqual(longMessage.scope, 'room');
  assert.strictEqual(longMessage.nick, 'ChatA');
  assert.strictEqual(longMessage.text.length, 100, 'long chat should be capped at 100 chars');

  const htmlText = '<img data-chat-edge="x">';
  const htmlReceived = waitForEvent(
    b,
    'chatMessage',
    (message) => message && message.text === htmlText,
    'html-like chat broadcast'
  );
  const htmlAck = await emitWithAck(a, 'chatMessage', { text: htmlText });
  assert.strictEqual(htmlAck.ok, true, `html-like message ack should be ok: ${JSON.stringify(htmlAck)}`);
  await htmlReceived;

  const gameStarts = Promise.all([
    waitForEvent(a, 'gameStart', null, 'host gameStart'),
    waitForEvent(b, 'gameStart', null, 'guest gameStart'),
  ]);
  a.emit('startGame');
  await gameStarts;

  const gameReceived = waitForEvent(
    a,
    'chatMessage',
    (message) => message && message.scope === 'game' && message.text === '게임 고고',
    'game chat broadcast'
  );
  const gameAck = await emitWithAck(b, 'chatMessage', { text: '게임 고고' });
  assert.strictEqual(gameAck.ok, true, `game message ack should be ok: ${JSON.stringify(gameAck)}`);
  const gameMessage = await gameReceived;
  assert.strictEqual(gameMessage.nick, 'ChatB');

  cleanup();
  console.log('PASS: waiting-room and in-game chat socket contract');
  process.exit(0);
}

main().catch((error) => {
  fail(error.message);
});
