'use strict';

// G002 수명주기 검증 — 다인 FFA 매치가 라운드 타임아웃에 의존하지 않고
// 참가자 이탈만으로 결정적으로 종료(gameOver)되는지 확인한다.
// 흐름: 같은 방 입장 → host startGame → gameStart → state.countdown===0 도달 →
//       한 참가자 소켓 close → 남은 참가자/관찰 소켓이 gameOver 를 결정적으로 수신.

const { test, before, after } = require('node:test');
const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectHuman,
  connectAgent,
  waitForEvent,
  statePlayer,
  createRoomWithAgentInvite,
} = require('./helpers/agent-harness');

// gameStart 후 COUNTDOWN_TICKS(90tick≈3s) 가 흘러 countdown===0 이 될 때까지
// 넉넉히 기다린다. gameOver 도 disconnect 직후 결정적으로 도착하지만
// 스케줄러 여유를 위해 같은 폭의 타임아웃을 둔다.
const COUNTDOWN_MS = 8000;
const GAMEOVER_MS = 8000;

let url;

before(async () => {
  url = resolveUrl() || (await startServer()).url;
});

after(() => {
  stopServer();
  closeAll();
});

// B9: 2인 인간 FFA — 호스트 인간 + 둘째 인간(joinRoom) 같은 방 입장.
// startGame → gameStart → countdown 0 → 둘째 인간 close → 호스트가 gameOver 수신.
// alive.length<=1 분기(game.js checkEnd)로 ROUND_TICKS 타임아웃 없이 결정적 종료.
test('B9: two-human FFA ends deterministically when a participant disconnects', async () => {
  const host = await connectHuman(url);
  host.emit('setNick', 'HostHuman');
  host.emit('createRoom', 'lifecycle-b9');
  const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'B9 room creation');

  const guest = await connectHuman(url);
  guest.emit('setNick', 'GuestHuman');
  guest.emit('joinRoom', room.id);
  await waitForEvent(guest, 'joinedRoom', (r) => r && r.id === room.id, 'B9 guest join');

  // 기본 모드는 ffa. 개인전은 2인이면 startGame 가능.
  host.emit('startGame');
  const start = await waitForEvent(
    host,
    'gameStart',
    (g) => g && Array.isArray(g.players) && g.players.length >= 2,
    'B9 gameStart'
  );
  assert(start.players.length >= 2, 'B9: match must include at least two players');

  // 매치가 실제로 활성화될 때까지(state.countdown===0) 대기.
  await waitForEvent(host, 'state', (s) => s && s.countdown === 0, 'B9 active match', COUNTDOWN_MS);

  // 한 참가자 소켓 close → 남은 1인 → checkEnd 가 즉시 gameOver 결정.
  guest.disconnect();

  const over = await waitForEvent(
    host,
    'gameOver',
    // FFA: winner 객체 존재 + winnerTeam null (타임아웃 gameOver 는 winner null 이라 매칭되지 않음).
    (o) => o && o.winner && o.winnerTeam === null,
    'B9 deterministic gameOver',
    GAMEOVER_MS
  );
  assert(over.winner && over.winner.id, 'B9: gameOver winner must carry an id');
  assert(over.winnerTeam === null, 'B9: FFA gameOver winnerTeam must be null');
});

// B10: 혼합 FFA — 사람 호스트 + 에이전트. startGame → gameStart → countdown 0 →
// 에이전트 disconnect → 사람 호스트(메인 네임스페이스 room)에서 gameOver 결정적 수신.
// 에이전트는 /agent 네임스페이스라 io.to(room.id) 브로드캐스트를 받지 못하므로
// 관찰자는 반드시 사람 호스트여야 하고, 그래서 에이전트 쪽을 이탈시킨다.
test('B10: human+agent FFA ends deterministically when the agent disconnects', async () => {
  const host = await connectHuman(url);
  const { room, invite } = await createRoomWithAgentInvite(host, {
    nick: 'MixHost',
    roomName: 'lifecycle-b10',
    invite: { nick: 'AgentBot', char: 1 },
  });
  assert(room && room.id, 'B10: host room creation failed');
  assert(invite && invite.token, 'B10: agent invite must include a token');

  // roomUpdate 리스너를 에이전트 연결 전에 걸어, 에이전트의 room.players 합류를
  // 경쟁 없이 관찰한다(서버는 합류 직후 host 에게 roomUpdate 를 브로드캐스트한다).
  const agentJoined = waitForEvent(
    host,
    'roomUpdate',
    (r) => r && Array.isArray(r.players) && r.players.some((p) => p.controller === 'agent'),
    'B10 agent joined room',
    5000
  );
  const agent = await connectAgent(url, invite.token, 'B10 agent');
  await agentJoined;

  host.emit('startGame');
  const start = await waitForEvent(
    host,
    'gameStart',
    (g) => g && Array.isArray(g.players) && g.players.length >= 2,
    'B10 gameStart'
  );
  assert(
    start.players.some((p) => p.controller === 'agent'),
    'B10: match must include an agent controller'
  );

  await waitForEvent(host, 'state', (s) => s && s.countdown === 0, 'B10 active match', COUNTDOWN_MS);

  // 에이전트 소켓 close → removeAgent → checkEnd → 남은 사람 호스트가 승자.
  const benchmarkSummary = waitForEvent(
    host,
    'agentBenchmarkSummary',
    (summary) => summary
      && summary.schema === 'crazay-arkade-agent-benchmark.v1'
      && summary.tracks
      && summary.tracks.outcome
      && summary.tracks.outcome.matches >= 1
      && summary.tracks.outcome.losses >= 1
      && summary.tracks.outcome.deathReasons.elimination >= 1,
    'B10 agent benchmark gameOver summary',
    GAMEOVER_MS
  );
  agent.disconnect();

  const [over, benchmark] = await Promise.all([waitForEvent(
    host,
    'gameOver',
    (o) => o && o.winner && o.winnerTeam === null,
    'B10 deterministic gameOver',
    GAMEOVER_MS
  ), benchmarkSummary]);
  assert(over.winner && over.winner.id, 'B10: gameOver winner must carry an id');
  assert(over.winnerTeam === null, 'B10: FFA gameOver winnerTeam must be null');
  assert(
    benchmark.tracks.outcome.survivalTickSamples === benchmark.tracks.outcome.matches,
    'B10: benchmark should record survival ticks for each agent result'
  );
});

// ---------------------------------------------------------------------------
// 생존성 레인(구현 완료): 서버 안전장치가 구현되어 blocking(required-green)으로 검증한다.
// (과거 advisory { todo:true } 명세였으나 G002에서 구현 착지 → 일반 blocking 테스트로 승격.)

// A2: 멈춤 임계 경과 후 baseline 봇 인계.
// 에이전트가 입력을 멈추면 정지 임계(AGENT_STALL_TICKS) 경과 후 baseline 봇이 슬롯을 인계해,
// 클라이언트 입력이 전혀 없어도 player.seq 가 자동으로 진행한다(server: driveStalledAgents/driveBotInput).
test('A2: baseline bot takes over a stalled agent and auto-advances its seq', async () => {
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    nick: 'A2Host',
    roomName: 'lifecycle-a2-baseline',
    invite: { nick: 'A2Agent', char: 1 },
  });
  const agent = await connectAgent(url, invite.token, 'A2 agent');
  host.emit('startGame');

  // 활성 매치의 첫 관측에서 에이전트 playerId 와 기준 seq 를 잡는다.
  const obs = await waitForEvent(
    agent,
    'agentObservation',
    (o) => o && o.playerId && o.state && o.state.countdown === 0 && statePlayer(o.state, o.playerId),
    'A2 active observation',
    COUNTDOWN_MS
  );
  const pid = obs.playerId;
  const baseSeq = statePlayer(obs.state, pid).seq;
  const runtimePolicy = waitForEvent(
    host,
    'agentPolicyUpdate',
    (policy) => policy
      && policy.source === 'fallbackBot'
      && policy.playerId === pid
      && policy.lastAction
      && typeof policy.lastAction.type === 'string'
      && Array.isArray(policy.cards)
      && policy.cards.some((card) => card.kind === 'create'),
    'A2 fallback bot runtime policy update',
    6000
  );

  // 의도적으로 어떤 agentAction 도 보내지 않는다. baseline 봇이 인계하면
  // 입력 없이도 seq 가 baseSeq 를 넘어 진행해야 한다.
  const [advanced, policy] = await Promise.all([waitForEvent(
    agent,
    'agentObservation',
    (o) => {
      const me = o && o.playerId === pid && o.state && statePlayer(o.state, pid);
      return me && typeof me.seq === 'number' && me.seq > baseSeq;
    },
    'A2 baseline bot auto-advances seq with no client input',
    6000
  ), runtimePolicy]);
  const nowSeq = statePlayer(advanced.state, pid).seq;
  assert(
    nowSeq > baseSeq,
    `baseline bot takeover unimplemented: seq stayed at ${baseSeq} with no input (no autonomous progress)`
  );
  assert(policy.cards.some((card) => card.kind === 'enforce'), 'fallback bot runtime policy should include an enforcement card');
  assert(policy.lastAction && policy.lastAction.type, 'fallback bot runtime policy should expose the latest executable action');
});

// A3: 게임 중 원에이전트 재접속 → 봇에서 슬롯 제어 회수.
// 활성 게임 중 에이전트가 끊기면 baseline 봇이 슬롯을 잡고(grace 동안 유지), 같은 토큰으로 재접속하면
// 봇으로부터 슬롯 제어를 회수해 다시 관측/조작 권한을 가진다(server: playing-only 토큰 보존 + reclaim).
test('A3: reconnecting owner-agent reclaims its in-game slot from the baseline bot', async () => {
  const host = await connectHuman(url);
  const { invite } = await createRoomWithAgentInvite(host, {
    nick: 'A3Host',
    roomName: 'lifecycle-a3-reclaim',
    invite: { nick: 'A3Agent', char: 1 },
  });
  const token = invite.token;
  const agent = await connectAgent(url, token, 'A3 agent');
  host.emit('startGame');
  await waitForEvent(host, 'gameStart', (g) => g && Array.isArray(g.players), 'A3 gameStart');
  await waitForEvent(agent, 'state', (s) => s && s.countdown === 0, 'A3 active match', COUNTDOWN_MS);

  // 게임 중 에이전트 이탈 → baseline 봇이 슬롯을 잡고 게임은 계속된다.
  agent.disconnect();

  // 같은 토큰으로 재접속 → 슬롯 제어 회수(연결 성공 + 관측 재수신).
  const reconnected = await connectAgent(url, token, 'A3 reconnect');
  const obs = await waitForEvent(
    reconnected,
    'agentObservation',
    (o) => o && o.playerId && o.state,
    'A3 reclaimed observation after reconnect',
    6000
  );
  assert(
    obs && obs.playerId,
    'in-game reconnection reclaim unimplemented: owner-agent could not reclaim its slot from the bot'
  );
});
