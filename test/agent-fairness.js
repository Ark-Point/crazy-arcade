'use strict';

// B4: 관측 패리티 — 에이전트가 받는 'agentObservation'.state 가
// 같은 방의 인간(호스트, 메인 네임스페이스)이 받는 'state'(권위 스냅샷)와
// 동일 키집합·deep-equal 이고, observation.self 가 state.players 의 자기 항목과 일치하며,
// observation 에 문서화되지 않은 추가 정보 필드가 없음을 단언.
//
// 비교 대상은 반드시 "다른 행위자"여야 진짜 패리티다: 에이전트(/agent 네임스페이스)의
// observation.state 를 인간 호스트(메인 네임스페이스) 소켓이 같은 tick 에 받은 'state' 와
// deep-equal 비교한다. 이렇게 해야 서버가 에이전트에게 인간과 다른 상태를 보내는 회귀를 잡는다.
const { test, before, after } = require('node:test');
const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  createRoomWithAgentInvite,
  waitForEvent,
  statePlayer,
  emitRawAck,
  assertObservationParity,
} = require('./helpers/agent-harness');

let url = null;
let host = null;
let agent = null;
// 인간 호스트 소켓이 받은 'state' 를 t(=tick) 키로 보관 — 패리티 비교 기준(human side).
const hostStateByTick = new Map();

before(async () => {
  url = resolveUrl() || (await startServer()).url;
  host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host);
  assert(invite && typeof invite.token === 'string', 'invite token missing');
  agent = await connectAgent(url, invite.token, 'agent');

  // 인간 호스트가 받는 권위 스냅샷('state')을 tick 으로 보관.
  host.on('state', (s) => {
    if (s && typeof s.t === 'number') hostStateByTick.set(s.t, s);
  });

  host.emit('startGame');
});

after(async () => {
  closeAll();
  stopServer();
});

test('agentObservation.state matches the human authoritative state snapshot (same tick)', async () => {
  // 활성(countdown===0) 이고 같은 t 의 인간(host) 'state' 가 도착해 있는 observation 을 기다린다.
  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (o) => o && o.state && o.state.countdown === 0 && hostStateByTick.has(o.state.t),
    'agentObservation at a tick the human host also received',
    8000
  );

  const humanState = hostStateByTick.get(obs.state.t);
  assert(humanState, `no human host state captured for tick ${obs.state.t}`);

  // 핵심: 에이전트 observation.state 가 인간 호스트가 받은 state 와 동일 키집합·deep-equal,
  // 그리고 observation.self === state.players[self].
  assertObservationParity(obs, humanState);

  // self id 가 observation.state.players 에 존재하는지(자기참조 일관성).
  const selfFromObs = statePlayer(obs.state, obs.playerId);
  assert(selfFromObs, `self id ${obs.playerId} not present in observation.state.players`);

  // observation top-level 에 문서화된 필드 외 추가 정보 필드가 없음.
  const obsKeys = Object.keys(obs).sort();
  const expectedKeys = [
    'invalid_reasons',
    'ownerId',
    'playerId',
    'policyContext',
    'resume',
    'roomId',
    'schema',
    'self',
    'state',
    'status',
    'trace',
    'valid_actions',
  ];
  assert(
    obsKeys.length === expectedKeys.length && obsKeys.every((k, i) => k === expectedKeys[i]),
    `agentObservation carries unexpected fields: ${obsKeys.join(',')}`
  );
});

// ---------------------------------------------------------------------------
// A-레인(advisory todo): 아직 서버에 미구현인 미래 동작의 명세.
// 이 todo 들은 의미있는 assertion 을 두지만 현재 구현이 없어 오늘은 실패한다.
// node:test 의 { todo:true } 가 실패를 'not ok ... # TODO' 로 표기해 스위트 실패를
// 유발하지 않는다(exit 0 유지). 구현이 착지하면 통과 todo 가 'ok ... # TODO' 로
// 표면화되고, advisory-scan 이 이를 감지해 blocking(required-green) 레인 승격을 촉구한다.

// 공용: 활성(countdown===0) 매치에 호스트+에이전트를 구성하고 에이전트 playerId 를 돌려준다.
async function setupActiveAgent(roomName, agentNick) {
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    nick: `${agentNick}Host`,
    roomName,
    invite: { nick: agentNick, char: 1 },
  });
  const agent = await connectAgent(url, invite.token, agentNick);
  host.emit('startGame');
  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (o) => o && o.playerId && o.state && o.state.countdown === 0 && Array.isArray(o.state.players),
    `${agentNick} active observation`,
    8000
  );
  return { host, agent, playerId: obs.playerId };
}

// A1: 인간 반응속도 rate-cap 강제.
// 최소 입력간격(인간 한계)보다 빠른 연속 agentAction(고유 seq) 버스트 중 일부가
// 서버에서 throttle/거부(ok===false)되어야 한다. 오늘은 rate-cap 이 없어 전부
// ok===true 로 수락되므로 rejected===0 → 실패(not ok # TODO).
// 구현 착지 시 ok # TODO 로 표면화 → advisory 승격.
test('A1: human-speed input rate-cap throttles a sub-interval action burst', async () => {
  const { agent } = await setupActiveAgent('fairness-a1-ratecap', 'A1Agent');

  // 고유 seq 40건을 await 없이 동시 발사 → 최소 입력간격보다 훨씬 빠른 버스트.
  // seq 가 모두 증가하므로 seq-dedup 가 아니라 순수 rate-cap 만 분리 검증한다.
  const N = 40;
  const acks = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      emitRawAck(agent, 'agentAction', { type: 'move', seq: i + 1, keys: { right: true } })
    )
  );
  const rejected = acks.filter((a) => a && a.ok === false).length;
  assert(
    rejected > 0,
    `human-speed rate-cap unimplemented: all ${N} sub-interval actions were accepted (expected some throttled/rejected)`
  );
});

// A5: 0분산 초인적 타이밍 패턴 탐지/플래그.
// 완벽히 일정한 간격(인간 불가능한 0분산)으로 연속 액션을 보내면 서버가 이를
// 비인간 패턴으로 감지해 'agentFlagged'(미래 이벤트)를 송신해야 한다. 오늘은
// 탐지 로직이 없어 이벤트가 오지 않고 waitForEvent 가 타임아웃→실패(not ok # TODO).
// flaky 주의: 타이밍 탐지는 본질적으로 확률적/통계적이라, 구현 후에도 임계·표본수에
// 따라 간헐적으로 흔들릴 수 있다. 구현 시 결정적 임계로 안정화하고 advisory 승격.
test('A5: zero-variance superhuman timing cadence is detected and flagged', async () => {
  const { agent } = await setupActiveAgent('fairness-a5-cadence', 'A5Agent');

  const flagged = waitForEvent(
    agent,
    'agentFlagged',
    (f) => f && (f.reason === 'timing' || /tim|cadence|variance/i.test(String(f.reason || ''))),
    'A5 zero-variance cadence flagged',
    4000
  );

  // 일정 간격(50ms)으로 고유 seq 액션을 송신 — 분산이 사실상 0.
  for (let i = 0; i < 30; i++) {
    emitRawAck(agent, 'agentAction', { type: 'move', seq: i + 1, keys: { right: i % 2 === 0 } });
    await new Promise((r) => setTimeout(r, 50));
  }

  const f = await flagged;
  assert(f && f.playerId, 'zero-variance timing detection unimplemented: no agentFlagged event received');
});
