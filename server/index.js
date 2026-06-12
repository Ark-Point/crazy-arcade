const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // roomId -> room

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function roomList() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    count: r.players.size,
    max: MAX_PLAYERS,
    playing: r.state === 'playing',
  }));
}

function broadcastRooms() {
  io.to('lobby').emit('rooms', roomList());
}

function roomDetail(room) {
  return {
    id: room.id,
    name: room.name,
    host: room.host,
    state: room.state,
    mode: room.mode,
    players: [...room.players.entries()].map(([id, p]) => ({ id, nick: p.nick, team: p.team, char: p.char })),
  };
}

const CHAR_COUNT = 6;

function smallerTeam(room) {
  let red = 0;
  let blue = 0;
  for (const p of room.players.values()) {
    if (p.team === 'red') red++;
    else if (p.team === 'blue') blue++;
  }
  return red <= blue ? 'red' : 'blue';
}

function leaveRoom(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.id);
  socket.data.roomId = null;
  if (room.game) room.game.removePlayer(socket.id);

  if (room.players.size === 0) {
    if (room.game) room.game.stop();
    rooms.delete(room.id);
  } else {
    if (room.host === socket.id) room.host = room.players.keys().next().value;
    io.to(room.id).emit('roomUpdate', roomDetail(room));
  }
  broadcastRooms();
}

function startGame(room) {
  room.state = 'playing';
  const players = [...room.players.entries()].map(([id, p]) => ({
    id,
    nick: p.nick,
    team: room.mode === 'team' ? p.team : null,
    char: p.char || 0,
  }));
  room.game = new Game(
    players,
    (event, data) => io.to(room.id).emit(event, data),
    () => {
      room.game = null;
      room.state = 'waiting';
      io.to(room.id).emit('roomUpdate', roomDetail(room));
      broadcastRooms();
    },
    room.mode
  );
  io.to(room.id).emit('gameStart', { players: players.map((p, i) => ({ ...p, color: i })) });
  io.to(room.id).emit('roomUpdate', roomDetail(room));
  broadcastRooms();
}

io.on('connection', (socket) => {
  socket.data.nick = '플레이어';
  socket.join('lobby');
  socket.emit('rooms', roomList());

  socket.on('setNick', (nick) => {
    if (typeof nick === 'string' && nick.trim()) {
      socket.data.nick = nick.trim().slice(0, 12);
    }
  });

  socket.on('setChar', (char) => {
    if (!Number.isInteger(char) || char < 0 || char >= CHAR_COUNT) return;
    socket.data.char = char;
    const room = rooms.get(socket.data.roomId);
    if (room && room.state === 'waiting') {
      const p = room.players.get(socket.id);
      if (p) {
        p.char = char;
        io.to(room.id).emit('roomUpdate', roomDetail(room));
      }
    }
  });

  socket.on('createRoom', (name) => {
    if (socket.data.roomId) return;
    const room = {
      id: makeRoomId(),
      name: (typeof name === 'string' && name.trim() ? name.trim() : `${socket.data.nick}의 방`).slice(0, 20),
      host: socket.id,
      state: 'waiting',
      mode: 'ffa',
      players: new Map([[socket.id, { nick: socket.data.nick, team: 'red', char: socket.data.char || 0 }]]),
      game: null,
    };
    rooms.set(room.id, room);
    socket.leave('lobby');
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('joinedRoom', roomDetail(room));
    broadcastRooms();
  });

  socket.on('joinRoom', (roomId) => {
    if (socket.data.roomId) return;
    const room = rooms.get(roomId);
    if (!room) return socket.emit('errorMsg', '방이 존재하지 않습니다.');
    if (room.state === 'playing') return socket.emit('errorMsg', '게임이 이미 진행 중입니다.');
    if (room.players.size >= MAX_PLAYERS) return socket.emit('errorMsg', '방이 가득 찼습니다.');
    room.players.set(socket.id, { nick: socket.data.nick, team: smallerTeam(room), char: socket.data.char || 0 });
    socket.leave('lobby');
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('joinedRoom', roomDetail(room));
    io.to(room.id).emit('roomUpdate', roomDetail(room));
    broadcastRooms();
  });

  socket.on('leaveRoom', () => {
    leaveRoom(socket);
    socket.join('lobby');
    socket.emit('rooms', roomList());
  });

  socket.on('setMode', (mode) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.host !== socket.id || room.state === 'playing') return;
    if (mode !== 'ffa' && mode !== 'team' && mode !== 'boss') return;
    room.mode = mode;
    if (mode === 'team') {
      // rebalance: alternate red/blue in join order
      let i = 0;
      for (const p of room.players.values()) p.team = i++ % 2 === 0 ? 'red' : 'blue';
    }
    io.to(room.id).emit('roomUpdate', roomDetail(room));
  });

  socket.on('setTeam', (team) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state === 'playing' || room.mode !== 'team') return;
    if (team !== 'red' && team !== 'blue') return;
    const p = room.players.get(socket.id);
    if (p) {
      p.team = team;
      io.to(room.id).emit('roomUpdate', roomDetail(room));
    }
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.host !== socket.id || room.state === 'playing') return;
    if (room.mode === 'team' && room.players.size >= 2) {
      const teams = new Set([...room.players.values()].map((p) => p.team));
      if (teams.size < 2) return socket.emit('errorMsg', '팀전은 양 팀에 최소 1명씩 필요합니다.');
    }
    startGame(room);
  });

  socket.on('cmd', (cmd) => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.queueCmd(socket.id, cmd);
  });

  socket.on('placeBomb', () => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.placeBomb(socket.id);
  });

  socket.on('useNeedle', () => {
    const room = rooms.get(socket.data.roomId);
    if (room && room.game) room.game.useNeedle(socket.id);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Crazy Arcade server running: http://localhost:${PORT}`);
});
