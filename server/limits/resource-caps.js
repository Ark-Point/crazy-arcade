'use strict';

// G007(S7): 자원/동시성 상한 + 에이전트 예약 파티셔닝.
// 동시에 'playing' 상태인 방(=진행중 게임) 수를 전역/키별로 제한하고, 그 중 일부
// 슬롯을 '에이전트 포함 게임' 전용으로 예약한다. 이 모듈은 rooms 등 공유 상태를
// 읽기만 하고(부수효과 없음), 시작/입장 가능 여부를 순수 의사결정으로 돌려준다.
// 거부 메시지 표준화는 호출부(server/index.js)가 errorMsg/ack 로 전달한다.
//
// 소프트 플로어(C1 확정) — 휴먼 비회귀:
//   - 휴먼 전용 게임: (maxGames - agentReservedGames) 까지만 허용.
//     미인증 메인io 가 예약분(에이전트 슬롯)을 잠식하지 못한다.
//   - 에이전트 포함 게임: 전역 maxGames 까지 허용(공유분 + 예약분 모두 사용).
//   - 키별 동시 게임: 한 apiKey 가 참여한 진행중 게임은 maxGamesPerKey 까지.
//
// 주입 계약:
//   rooms              Map<roomId, room>            (room.state === 'playing' 가 진행중 게임)
//   isAgentRoom(room)  -> boolean                   (방에 controller==='agent' 플레이어가 있으면 true)
//   keyIdsForRoom(room)-> Iterable<keyId>           (방에 참여한 apiKey 에이전트들의 keyId 집합)
//   maxGames           number                       (전역 동시 게임 상한; 기본 50)
//   agentReservedGames number                       (그 중 에이전트 포함 게임 전용 예약분; 기본 25)
//   maxGamesPerKey     number                       (키별 동시 게임 상한; 기본 2)

// 표준 거부 메시지(휴먼 errorMsg / 에이전트 ack 양쪽에서 동일 문구 사용).
const GAME_CAPACITY_ERROR = '서버 동시 게임 수가 가득 찼습니다.';
const KEY_GAMES_ERROR = '키당 동시 게임 수 상한을 초과했습니다.';

function createResourceCaps({
  maxGames,
  agentReservedGames,
  maxGamesPerKey,
  rooms,
  isAgentRoom,
  keyIdsForRoom,
} = {}) {
  const gamesCap = toCap(maxGames, 50);
  const perKeyCap = toCap(maxGamesPerKey, 2);
  const reserved = clampReserved(agentReservedGames, gamesCap);
  // 휴먼 전용 게임 소프트 플로어: 예약분을 제외한 공유분까지만.
  const humanCap = Math.max(0, gamesCap - reserved);

  const roomsMap = rooms || new Map();
  const agentRoomFn = typeof isAgentRoom === 'function' ? isAgentRoom : () => false;
  const keyIdsFn = typeof keyIdsForRoom === 'function' ? keyIdsForRoom : () => [];

  // --- 카운팅 헬퍼(매 호출 시 공유 상태를 스냅샷 없이 직접 집계) ---------------
  function playingGameCount() {
    let n = 0;
    for (const room of roomsMap.values()) if (room.state === 'playing') n += 1;
    return n;
  }

  // 에이전트 player 가 1명이라도 포함된 진행중 게임 수.
  function agentInvolvedPlayingCount() {
    let n = 0;
    for (const room of roomsMap.values()) {
      if (room.state === 'playing' && agentRoomFn(room)) n += 1;
    }
    return n;
  }

  // 휴먼 전용(에이전트 미포함) 진행중 게임 수.
  function humanOnlyPlayingCount() {
    let n = 0;
    for (const room of roomsMap.values()) {
      if (room.state === 'playing' && !agentRoomFn(room)) n += 1;
    }
    return n;
  }

  // 해당 keyId 의 에이전트가 참여한 진행중 게임 수.
  function gamesForKey(keyId) {
    if (keyId == null) return 0;
    let n = 0;
    for (const room of roomsMap.values()) {
      if (room.state !== 'playing') continue;
      for (const id of keyIdsFn(room)) {
        if (id === keyId) { n += 1; break; }
      }
    }
    return n;
  }

  // --- 고수준 의사결정 ---------------------------------------------------------
  // 휴먼 전용 게임 시작 가능 여부: 공유분 소프트 플로어 미만이면 허용.
  function canStartHumanGame() {
    return humanOnlyPlayingCount() < humanCap;
  }

  // 에이전트 포함 게임 시작 가능 여부: 전역 상한 미만이고, 그 키의 동시 게임도 상한 미만.
  function canStartAgentGame(keyId) {
    return playingGameCount() < gamesCap && gamesForKey(keyId) < perKeyCap;
  }

  // 해당 키가 새 방(대기/시작)에 더 관여할 수 있는지: 진행중 게임 수가 키 상한 미만.
  function canKeyTakeRoom(keyId) {
    return gamesForKey(keyId) < perKeyCap;
  }

  // startGame 진입부 게이트: 방 성격(에이전트 포함/휴먼 전용)에 맞는 상한을 적용한다.
  // 통과 시 { ok:true }, 초과 시 { ok:false, error } (호출부가 errorMsg/ack 로 전달).
  function evaluateStart(room) {
    if (agentRoomFn(room)) {
      if (playingGameCount() >= gamesCap) return { ok: false, error: GAME_CAPACITY_ERROR };
      for (const keyId of keyIdsFn(room)) {
        if (gamesForKey(keyId) >= perKeyCap) return { ok: false, error: KEY_GAMES_ERROR };
      }
      return { ok: true };
    }
    if (!canStartHumanGame()) return { ok: false, error: GAME_CAPACITY_ERROR };
    return { ok: true };
  }

  // join/create 진입부 게이트: 키별 동시 게임 상한을 선제 적용한다.
  // (이미 maxGamesPerKey 개 진행중인 키는 새 방을 더 만들/잡을 수 없게 거부.)
  function evaluateKeyRoom(keyId) {
    if (!canKeyTakeRoom(keyId)) return { ok: false, error: KEY_GAMES_ERROR };
    return { ok: true };
  }

  return {
    // 카운팅
    playingGameCount,
    agentInvolvedPlayingCount,
    humanOnlyPlayingCount,
    gamesForKey,
    // 의사결정
    canStartHumanGame,
    canStartAgentGame,
    canKeyTakeRoom,
    evaluateStart,
    evaluateKeyRoom,
    // 설정 스냅샷(진단/테스트용)
    limits: { maxGames: gamesCap, agentReservedGames: reserved, maxGamesPerKey: perKeyCap, humanGameCap: humanCap },
  };
}

// 양의 정수 상한으로 정규화. 미지정/비정상 값은 보수적 기본으로.
function toCap(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// 예약분은 0 이상 maxGames 이하로 클램프. 미지정/비정상 값은 min(25, maxGames).
function clampReserved(value, maxGames) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), maxGames);
  return Math.min(25, maxGames);
}

module.exports = { createResourceCaps, GAME_CAPACITY_ERROR, KEY_GAMES_ERROR };
