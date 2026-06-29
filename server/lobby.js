'use strict';

// 로비 공유 로직 — 휴먼/에이전트(토큰·apiKey) 어느 경로에서도 동일하게 쓰는
// 방 생성/입장/퇴장/목록의 식별자 비의존 코어. 소켓.io 부수효과(join/leave,
// joinedRoom emit 등)는 호출부가 담당하고, 여기서는 공유 상태(rooms 등)만 변형한다.
//
// ctx 주입 계약:
//   rooms            Map<roomId, room>
//   MAX_PLAYERS      number
//   io               socket.io 서버(doLeaveRoom 의 roomUpdate 브로드캐스트용)
//   makeRoomId()     -> roomId
//   smallerTeam(room)-> 'red'|'blue'
//   roomDetail(room) -> 직렬화된 방 상세
//   broadcastRooms() -> 로비에 rooms 갱신 송신
//   maybeDeleteRoom(room) -> 활성 플레이어 없으면 방 정리(true) (controller 무관)
//   nextHost(room)   -> 활성 플레이어 기준 다음 호스트 id|null (controller 무관)
//
// identity 계약: { id, nick, char, controller:'human'|'agent', ownerId?, keyId? }
//   휴먼: id=socket.id, controller='human'
//   에이전트: id=keyId/owner 파생 playerId, controller='agent'

// identity → room.players 항목. 에이전트만 ownerId 를 보존한다(휴먼은 키 자체를 두지 않음).
function playerFromIdentity(identity, team) {
  const player = {
    nick: identity.nick,
    team,
    char: identity.char || 0,
    controller: identity.controller || 'human',
  };
  if (player.controller === 'agent') {
    player.ownerId = identity.ownerId ?? null;
  }
  return player;
}

function spectatorFromIdentity(identity) {
  return {
    nick: identity.nick,
    char: identity.char || 0,
    controller: 'human',
  };
}

// 로비 목록 직렬화(휴먼/에이전트 공용).
function listRooms(ctx) {
  return [...ctx.rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    count: r.players.size,
    spectators: r.spectators ? r.spectators.size : 0,
    max: ctx.MAX_PLAYERS,
    mode: r.mode,
    mapId: r.mode === 'boss' ? 'boss-cove' : r.mapId,
    playing: r.state === 'playing',
  }));
}

// 방 생성: 상태만 변형하고 { room } 반환. 소켓 join/joinedRoom/브로드캐스트는 호출부.
function doCreateRoom(ctx, identity, opts = {}) {
  const rawName = typeof opts.name === 'string' && opts.name.trim()
    ? opts.name.trim()
    : `${identity.nick}의 방`;
  const room = {
    id: ctx.makeRoomId(),
    name: rawName.slice(0, 20),
    host: identity.id,
    state: 'waiting',
    mode: 'ffa',
    mapId: 'village',
    players: new Map([[identity.id, playerFromIdentity(identity, 'red')]]),
    spectators: new Map(),
    game: null,
  };
  ctx.rooms.set(room.id, room);
  return { room };
}

// 방 입장: 검증 후 상태만 변형하고 { room } 반환. 에러는 코드로 반환해 경로별 메시지 매핑.
function doJoinRoom(ctx, identity, roomId) {
  const room = ctx.rooms.get(roomId);
  if (!room) return { error: 'not_found' };
  if (room.state === 'playing') return { error: 'playing' };
  if (room.players.size >= ctx.MAX_PLAYERS) return { error: 'full' };
  if (room.spectators) room.spectators.delete(identity.id);
  room.players.set(identity.id, playerFromIdentity(identity, ctx.smallerTeam(room)));
  return { room };
}

function doSetSpectator(ctx, identity, spectator) {
  let room = null;
  for (const r of ctx.rooms.values()) {
    if (r.players.has(identity.id) || (r.spectators && r.spectators.has(identity.id))) {
      room = r;
      break;
    }
  }
  if (!room) return { error: 'not_found' };
  if (room.state === 'playing') return { error: 'playing' };
  if (!room.spectators) room.spectators = new Map();

  if (spectator) {
    const player = room.players.get(identity.id);
    if (!player) return { room };
    if ((player.controller || 'human') !== 'human') return { error: 'agent' };
    room.players.delete(identity.id);
    room.spectators.set(identity.id, spectatorFromIdentity({
      ...identity,
      nick: player.nick || identity.nick,
      char: player.char || identity.char || 0,
    }));
    return { room };
  }

  const existing = room.players.get(identity.id);
  if (existing) return { room };
  const spec = room.spectators.get(identity.id);
  if (!spec) return { error: 'not_found' };
  if (room.players.size >= ctx.MAX_PLAYERS) return { error: 'full' };
  room.spectators.delete(identity.id);
  room.players.set(identity.id, playerFromIdentity({
    ...identity,
    nick: spec.nick || identity.nick,
    char: spec.char || identity.char || 0,
    controller: 'human',
  }, ctx.smallerTeam(room)));
  return { room };
}

// 방 퇴장: 플레이어 제거 + (controller 무관) 호스트 승계/방 정리/브로드캐스트.
// 소켓 leave/소켓.data 정리와 에이전트 record forget 은 호출부가 선행한다.
function doLeaveRoom(ctx, identity) {
  let room = null;
  for (const r of ctx.rooms.values()) {
    if (r.players.has(identity.id) || (r.spectators && r.spectators.has(identity.id))) { room = r; break; }
  }
  if (!room) return { room: null };
  const wasPlayer = room.players.delete(identity.id);
  if (room.spectators) room.spectators.delete(identity.id);
  if (wasPlayer && room.game) room.game.removePlayer(identity.id);
  if (ctx.maybeDeleteRoom(room)) {
    ctx.broadcastRooms();
    return { room: null, deleted: true };
  }
  if (room.host === identity.id) room.host = ctx.nextHost(room);
  ctx.io.to(room.id).emit('roomUpdate', ctx.roomDetail(room));
  ctx.broadcastRooms();
  return { room };
}

module.exports = {
  playerFromIdentity,
  spectatorFromIdentity,
  listRooms,
  doCreateRoom,
  doJoinRoom,
  doSetSpectator,
  doLeaveRoom,
};
