'use strict';

// S6 연결남용/DoS 가드 — /agent 네임스페이스 연결 상한.
// IP별·키별·전역 동시연결 카운터를 들고, 핸드셰이크 인증 성공 직후 tryAcquire 로
// 슬롯을 잡고 disconnect 에서 release 한다. release 는 멱등(중복 호출 안전)이라
// 모든 거부/예외 경로에서 try/finally 로 불러도 카운터 누수가 0 이다.
//
// keys-api(server/auth/keys-api.js)와 공유하는 선합의 계약:
//   { socketsForKey(keyId) -> Iterable<{ disconnect(force) }> }
// 키 폐기 시 그 키에 묶인 라이브 소켓을 즉시 강제 종료하는 데 쓰인다.

// maxPerIp/maxPerKey/globalMax: 각 상한(양의 정수). 미지정/비정상 값은 보수적 기본으로.
function createConnGuard({ maxPerIp, maxPerKey, globalMax } = {}) {
  const ipCap = toCap(maxPerIp, 4);
  const keyCap = toCap(maxPerKey, 2);
  const globalCap = toCap(globalMax, 200);

  const ipConns = new Map(); // ip -> count
  const keyConns = new Map(); // keyId -> count
  const socketsByKey = new Map(); // keyId -> Set<socket>
  // 획득한 소켓별 (ip,keyId) 기록 — release 가 같은 값으로 정확히 되돌리도록.
  // 이 기록의 존재 여부가 멱등 release 의 단일 출처다.
  const acquired = new Map(); // socket -> { ip, keyId }
  let globalAgentConns = 0;

  function tryAcquire(ip, keyId, socket) {
    // 이미 획득한 소켓은 중복 획득하지 않는다(방어적).
    if (socket && acquired.has(socket)) return { ok: true };
    if (globalAgentConns >= globalCap) {
      return { ok: false, reason: 'server connection capacity reached' };
    }
    if (ip != null && (ipConns.get(ip) || 0) >= ipCap) {
      return { ok: false, reason: 'too many connections from ip' };
    }
    if (keyId != null && (keyConns.get(keyId) || 0) >= keyCap) {
      return { ok: false, reason: 'too many connections for key' };
    }
    // 통과 → 카운터 증가 + 레지스트리 등록.
    globalAgentConns += 1;
    if (ip != null) ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
    if (keyId != null) {
      keyConns.set(keyId, (keyConns.get(keyId) || 0) + 1);
      let set = socketsByKey.get(keyId);
      if (!set) {
        set = new Set();
        socketsByKey.set(keyId, set);
      }
      if (socket) set.add(socket);
    }
    if (socket) acquired.set(socket, { ip: ip == null ? null : ip, keyId: keyId == null ? null : keyId });
    return { ok: true };
  }

  // 멱등: 획득 기록이 없으면 no-op. 인자 ip/keyId 는 참고용이며,
  // 실제 되돌림은 획득 시 저장한 값으로 한다(불일치로 인한 누수/오차 방지).
  function release(_ip, _keyId, socket) {
    if (!socket) return;
    const rec = acquired.get(socket);
    if (!rec) return;
    acquired.delete(socket);
    globalAgentConns = Math.max(0, globalAgentConns - 1);
    if (rec.ip != null) {
      const next = (ipConns.get(rec.ip) || 0) - 1;
      if (next > 0) ipConns.set(rec.ip, next);
      else ipConns.delete(rec.ip);
    }
    if (rec.keyId != null) {
      const next = (keyConns.get(rec.keyId) || 0) - 1;
      if (next > 0) keyConns.set(rec.keyId, next);
      else keyConns.delete(rec.keyId);
      const set = socketsByKey.get(rec.keyId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) socketsByKey.delete(rec.keyId);
      }
    }
  }

  function socketsForKey(keyId) {
    const set = socketsByKey.get(keyId);
    // 라이브 Set 참조 대신 스냅샷을 반환해, 소비자가 순회 중 disconnect→release 로
    // Set 을 변형해도 순회가 안전하도록 한다(S8 keys-api 폐기 경로 방어).
    return set ? [...set] : [];
  }

  function size() {
    return globalAgentConns;
  }

  return { tryAcquire, release, socketsForKey, size };
}

function toCap(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

module.exports = { createConnGuard };
