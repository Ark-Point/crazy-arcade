'use strict';

// 에이전트 테스트 공유 하네스 — 소켓 헬퍼와 서버 스폰 로직의 단일 출처.
// test/agent.js, test/agent-security.js 등이 중복 헬퍼 없이 재사용한다.

const net = require('net');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { createSessionToken, SESSION_COOKIE } = require('../../server/auth/session');

// --- 소켓 추적 ---------------------------------------------------------------
// 하네스가 만든 모든 소켓을 추적해 closeAll()로 일괄 정리한다.
const sockets = [];

const track = (socket) => {
  sockets.push(socket);
  return socket;
};

const closeAll = () => {
  while (sockets.length) {
    const socket = sockets.pop();
    try {
      socket.close();
    } catch {
      // 정리 중 오류는 무시
    }
  }
};

// --- 서버 수명 관리 ----------------------------------------------------------
let serverChild = null;
let serverOutput = '';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// argv[2] 또는 env.URL 이 지정되면 외부 서버 모드: 그 URL 사용, spawn 하지 않음.
// 둘 다 없으면 null 반환 → 호출자가 startServer()로 self-spawn 한다.
const resolveUrl = () => process.argv[2] || process.env.URL || null;

// OS가 할당하는 빈 포트를 얻는다(0번 바인드 후 닫음).
const getFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// socket.io connect 시도로 서버가 준비될 때까지 폴링(최대 ~5s).
const waitForServer = async (url) => {
  for (let i = 0; i < 50; i++) {
    const ready = await new Promise((resolve) => {
      const socket = io(url, { reconnection: false, timeout: 400, forceNew: true });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // 무시
        }
        resolve(ok);
      };
      socket.once('connect', () => finish(true));
      socket.once('connect_error', () => finish(false));
      setTimeout(() => finish(false), 450).unref();
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error(`server did not become ready at ${url}\n${serverOutput}`);
};

// 외부 URL 미지정 시에만 node server/index.js 를 OS 할당 포트로 spawn 한다.
// 외부 URL이 지정되면 spawn 생략하고 그 url 을 그대로 사용.
const startServer = async () => {
  const external = resolveUrl();
  if (external) {
    return { url: external, stop: stopServer };
  }
  const port = await getFreePort();
  const url = `http://localhost:${port}`;
  serverChild = spawn('node', ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  serverChild.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  serverChild.once('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      serverOutput += `server exited code=${code} signal=${signal}\n`;
    }
  });
  await waitForServer(url);
  return { url, stop: stopServer };
};

// spawn 한 child 가 있으면 kill, 없으면 no-op.
const stopServer = () => {
  if (serverChild) {
    try {
      serverChild.kill();
    } catch {
      // 무시
    }
    serverChild = null;
  }
};

// 사용하지 않더라도 호출자가 진단에 쓸 수 있도록 노출.
const serverLog = () => serverOutput;

// --- 단언 헬퍼 ---------------------------------------------------------------
// 하네스 헬퍼는 실패 시 throw 한다(호출자의 try/catch → fail → exit 1 계약 유지).
const assert = (condition, msg) => {
  if (!condition) throw new Error(msg);
};

// --- 소켓 헬퍼 ---------------------------------------------------------------
const connectSocket = (url, label, opts = {}) => {
  const socket = track(io(url, { reconnection: false, timeout: 2000, forceNew: true, ...opts }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} connect timed out`)), 2500);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label} connect error: ${err.message}`));
    });
  });
};

// 휴먼 소켓 연결. onRoom 콜백이 주어지면 roomUpdate 를 구독해 호출자에게 전달.
const connectHuman = async (url, onRoom) => {
  const socket = track(io(url, { reconnection: false, timeout: 2000, forceNew: true }));
  if (typeof onRoom === 'function') {
    socket.on('roomUpdate', (room) => onRoom(room));
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('human connect timed out')), 2500);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`human connect error: ${err.message}`));
    });
  });
  return socket;
};

// /agent 네임스페이스에 토큰으로 연결(성공 기대).
const connectAgent = (url, token, label) => new Promise((resolve, reject) => {
  const agent = track(io(`${url}/agent`, {
    auth: { token },
    reconnection: false,
    timeout: 1500,
    forceNew: true,
  }));
  const timer = setTimeout(() => {
    agent.close();
    reject(new Error(`${label} did not connect`));
  }, 2500);
  agent.once('connect', () => {
    clearTimeout(timer);
    resolve(agent);
  });
  agent.once('connect_error', (err) => {
    clearTimeout(timer);
    reject(new Error(`${label} connect error: ${err.message}`));
  });
});

const connectAgentReady = (url, token, label) => new Promise((resolve, reject) => {
  const agent = track(io(`${url}/agent`, {
    auth: { token },
    reconnection: false,
    timeout: 1500,
    forceNew: true,
  }));
  let connected = false;
  let ready = null;
  const timer = setTimeout(() => {
    agent.close();
    reject(new Error(`${label} did not become ready`));
  }, 3000);
  const finish = () => {
    if (!connected || !ready) return;
    clearTimeout(timer);
    resolve({ agent, ready });
  };
  agent.once('connect', () => {
    connected = true;
    finish();
  });
  agent.once('agentReady', (payload) => {
    ready = payload;
    finish();
  });
  agent.once('connect_error', (err) => {
    clearTimeout(timer);
    reject(new Error(`${label} connect error: ${err.message}`));
  });
});

// /agent 네임스페이스에 apiKey 로 연결(성공 기대). agentAuthenticated 페이로드를 함께 반환한다.
const connectAgentWithKey = (url, apiKey, label) => new Promise((resolve, reject) => {
  const agent = track(io(`${url}/agent`, {
    auth: { apiKey },
    reconnection: false,
    timeout: 1500,
    forceNew: true,
  }));
  const timer = setTimeout(() => {
    agent.close();
    reject(new Error(`${label} did not connect`));
  }, 2500);
  agent.once('connect', () => {
    agent.once('agentAuthenticated', (auth) => {
      clearTimeout(timer);
      resolve({ agent, auth });
    });
  });
  agent.once('connect_error', (err) => {
    clearTimeout(timer);
    reject(new Error(`${label} connect error: ${err.message}`));
  });
});

// /agent apiKey 연결이 거부될 것을 기대(connect_error 의 메시지를 반환).
const expectAgentKeyRejected = (url, apiKey, label) => new Promise((resolve, reject) => {
  const agent = track(io(`${url}/agent`, {
    auth: { apiKey },
    reconnection: false,
    timeout: 1500,
    forceNew: true,
  }));
  const timer = setTimeout(() => {
    agent.close();
    reject(new Error(`${label} unexpectedly stayed pending`));
  }, 2500);
  agent.once('connect', () => {
    clearTimeout(timer);
    reject(new Error(`${label} unexpectedly connected`));
  });
  agent.once('connect_error', (err) => {
    clearTimeout(timer);
    if (!(err && err.message)) {
      reject(new Error(`${label} did not include a rejection reason`));
      return;
    }
    resolve(err.message);
  });
});

// /agent 연결이 거부될 것을 기대(connect_error 의 메시지를 반환).
const expectAgentRejected = (url, token, label) => new Promise((resolve, reject) => {
  const agent = track(io(`${url}/agent`, {
    auth: { token },
    reconnection: false,
    timeout: 1500,
    forceNew: true,
  }));
  const timer = setTimeout(() => {
    agent.close();
    reject(new Error(`${label} unexpectedly stayed pending`));
  }, 2500);
  agent.once('connect', () => {
    clearTimeout(timer);
    reject(new Error(`${label} unexpectedly connected`));
  });
  agent.once('connect_error', (err) => {
    clearTimeout(timer);
    if (!(err && err.message)) {
      reject(new Error(`${label} did not include a rejection reason`));
      return;
    }
    resolve(err.message);
  });
});

const expectDisconnect = (socket, label) => new Promise((resolve, reject) => {
  if (!socket.connected) {
    resolve();
    return;
  }
  const timer = setTimeout(() => reject(new Error(`${label} did not disconnect`)), 2500);
  socket.once('disconnect', () => {
    clearTimeout(timer);
    resolve();
  });
});

const waitForEvent = (socket, event, predicate, label, ms = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`${label} timed out waiting for ${event}`));
  }, ms);
  const handler = (payload) => {
    if (!predicate || predicate(payload)) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
  };
  socket.on(event, handler);
});

// ack 가 ok===false 면 거부로 간주해 reject. invite 가 있으면 invite 를 반환.
const emitWithAck = (socket, event, payload, ms = 1500) => new Promise((resolve, reject) => {
  socket.timeout(ms).emit(event, payload, (err, response) => {
    if (err) {
      reject(new Error(`${event} ack timed out or failed: ${err.message || err}`));
      return;
    }
    if (response && response.ok === false) {
      reject(new Error(`${event} rejected: ${response.error || 'unknown error'}`));
      return;
    }
    resolve(response && response.invite ? response.invite : response);
  });
});

// 거부 여부 판단 없이 원본 ack 응답을 그대로 반환.
const emitRawAck = (socket, event, payload, ms = 1500) => new Promise((resolve, reject) => {
  socket.timeout(ms).emit(event, payload, (err, response) => {
    if (err) reject(new Error(`${event} ack timed out or failed: ${err.message || err}`));
    else resolve(response);
  });
});

// --- 방/상태 헬퍼 ------------------------------------------------------------
const agentPlayers = (room) => {
  if (!room || !Array.isArray(room.players)) return [];
  return room.players.filter((p) => p.controller === 'agent');
};

const statePlayer = (state, id) => {
  if (!state || !Array.isArray(state.players)) return null;
  return state.players.find((p) => p.id === id);
};

const assertHumanOnlyRoom = (room, context) => {
  assert(room && Array.isArray(room.players), `${context}: room payload missing players`);
  assert(room.players.length === 1, `${context}: expected one human player, got ${room.players.length}`);
  assert(!room.players.some((p) => p.controller === 'agent'), `${context}: room contains an agent controller player`);
};

// getLatestRoom() 로 최신 방을 읽어와 휴먼 전용 상태를 단언(미증식 검증).
const assertNoRoomGrowth = async (getLatestRoom, context) => {
  await delay(350);
  assertHumanOnlyRoom(getLatestRoom(), context);
};

// createRoom → createAgentInvite 흐름. { room, invite } 반환.
const createRoomWithAgentInvite = async (host, opts = {}) => {
  const {
    nick = 'AgentHost',
    roomName = 'agent room',
    invite: inviteOpts = { nick: 'AgentAlpha', char: 1 },
  } = opts;
  host.emit('setNick', nick);
  host.emit('createRoom', roomName);
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'human room creation');
  const invite = await emitWithAck(host, 'createAgentInvite', inviteOpts);
  return { room, invite };
};

// 기형/oversized/고빈도 액션 n 건을 송신하고 raw ack 배열을 반환(후속 거부 검증용).
const floodActions = async (socket, n) => {
  const acks = [];
  for (let i = 0; i < n; i++) {
    let payload;
    const variant = i % 3;
    if (variant === 0) {
      // 기형: 객체가 아닌 페이로드
      payload = 'not-an-object';
    } else if (variant === 1) {
      // oversized: 2048바이트 한도를 넘는 junk
      payload = { type: 'move', seq: 1, keys: { left: true }, junk: 'x'.repeat(3000) };
    } else {
      // 고빈도 + stale seq(증가하지 않는 seq)
      payload = { type: 'move', seq: 1, keys: { right: true } };
    }
    acks.push(await emitRawAck(socket, 'agentAction', payload));
  }
  return acks;
};

// --- 관측 패리티 단언 --------------------------------------------------------
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
};

// agentObs.state 가 humanState 와 동일 키집합·deep-equal 이고,
// self 가 state.players 의 자기 항목과 일치함을 단언.
const assertObservationParity = (agentObs, humanState) => {
  assert(agentObs && typeof agentObs === 'object', 'observation parity: agent observation missing');
  const obsState = agentObs.state;
  assert(obsState && typeof obsState === 'object', 'observation parity: observation has no state');
  assert(humanState && typeof humanState === 'object', 'observation parity: human state missing');

  const obsKeys = Object.keys(obsState).sort();
  const humanKeys = Object.keys(humanState).sort();
  assert(
    deepEqual(obsKeys, humanKeys),
    `observation parity: state key sets differ (agent=${obsKeys.join(',')} human=${humanKeys.join(',')})`
  );
  assert(deepEqual(obsState, humanState), 'observation parity: agent state is not deep-equal to human state');

  const selfId = agentObs.playerId;
  const selfFromState = statePlayer(obsState, selfId);
  assert(selfFromState, `observation parity: self id ${selfId} not present in state.players`);
  assert(
    deepEqual(agentObs.self, selfFromState),
    'observation parity: observation.self does not match state.players self entry'
  );
};

// --- BYO HTTP/세션 헬퍼(S8 통합) --------------------------------------------
// 세션 쿠키 서명: { id, provider, subject } 페이로드를 SESSION_SECRET 로 서명해
// 'byo_sess=...' Cookie 헤더 문자열을 만든다. 서버는 같은 SESSION_SECRET 로 검증한다.
const signSessionCookie = (account, secret, ttlSec = 3600) => {
  const token = createSessionToken(account, secret, ttlSec);
  return `${SESSION_COOKIE}=${token}`;
};

// 임의 메서드 JSON 요청. cookie 가 주어지면 Cookie 헤더로 실어보낸다.
// { status, body } 반환(body 는 JSON 파싱 실패 시 null).
const httpJson = async (baseUrl, pathPart, { method = 'GET', cookie, body } = {}) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${pathPart}`, { method, headers, body: payload });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

// HTTP POST /account/keys 로 키 발급. 평문 key 는 응답에서 단 1회 노출된다.
// { status, body } 반환(body.key 가 평문, body.record 가 공개 메타).
const issueKeyViaHttp = async (baseUrl, sessionCookie, label = 'integration key') =>
  httpJson(baseUrl, '/account/keys', { method: 'POST', cookie: sessionCookie, body: { label } });

// HTTP DELETE /account/keys/:id 로 폐기. { status, body } 반환(body.disconnected 포함).
const revokeKeyViaHttp = async (baseUrl, sessionCookie, keyId) =>
  httpJson(baseUrl, `/account/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', cookie: sessionCookie });

module.exports = {
  // URL/서버 수명
  resolveUrl,
  startServer,
  stopServer,
  waitForServer,
  getFreePort,
  serverLog,
  // 소켓 추적
  closeAll,
  // 단언
  assert,
  // 소켓 헬퍼
  connectSocket,
  connectHuman,
  connectAgent,
  connectAgentReady,
  connectAgentWithKey,
  expectAgentKeyRejected,
  expectAgentRejected,
  expectDisconnect,
  waitForEvent,
  emitWithAck,
  emitRawAck,
  // 방/상태 헬퍼
  agentPlayers,
  statePlayer,
  assertHumanOnlyRoom,
  assertNoRoomGrowth,
  createRoomWithAgentInvite,
  floodActions,
  assertObservationParity,
  // BYO HTTP/세션 헬퍼(S8)
  signSessionCookie,
  httpJson,
  issueKeyViaHttp,
  revokeKeyViaHttp,
};
