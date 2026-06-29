'use strict';

// S6 메시지 throttle — 소켓별 1초 슬라이딩 윈도우.
// 로비 이벤트(rooms/createRoom/joinRoom/leaveRoom)처럼 게임플레이 입력이 아닌
// 제어성 이벤트에만 적용한다. 게임 액션(agentAction)은 별도 30/s 불변식이 담당하므로
// 이 throttle 합산에서 제외한다.
//
// 윈도우는 소켓 객체를 키로 하는 WeakMap 에 보관 → 소켓 GC 시 자동 회수(누수 없음).

// perSecCap: 1초 윈도우 내 허용 횟수(양의 정수). 미지정/비정상 값은 30 으로.
function createMsgThrottle({ perSecCap } = {}) {
  const cap = Number.isFinite(Number(perSecCap)) && Number(perSecCap) > 0
    ? Math.floor(Number(perSecCap))
    : 30;
  const windows = new WeakMap(); // socket -> number[](최근 1초 타임스탬프)

  function allow(socket) {
    if (!socket) return true;
    const now = Date.now();
    let w = windows.get(socket);
    if (!w) {
      w = [];
      windows.set(socket, w);
    }
    // 1초보다 오래된 타임스탬프 제거(슬라이딩).
    while (w.length && w[0] <= now - 1000) w.shift();
    if (w.length >= cap) return false;
    w.push(now);
    return true;
  }

  return { allow };
}

module.exports = { createMsgThrottle };
