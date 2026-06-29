'use strict';

const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
  assert,
  connectSocket,
  waitForEvent,
  emitWithAck,
  agentPlayers,
} = require('./helpers/agent-harness');

const cleanup = () => {
  closeAll();
  stopServer();
};

const fail = (msg) => {
  console.error('FAIL:', msg);
  cleanup();
  process.exit(1);
};

(async () => {
  setTimeout(() => fail('test timed out'), 22000).unref();

  try {
    const URL = resolveUrl() || (await startServer()).url;
    const host = await connectSocket(URL, 'host');
    let latestRoom = null;
    host.on('roomUpdate', (room) => {
      latestRoom = room;
    });
    host.emit('setNick', 'LlmReplyHost');
    host.emit('createRoom', 'llm reply policy');
    const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'room creation');
    latestRoom = room;

    const invite = await emitWithAck(host, 'createAgentInvite', { nick: 'ReplyAgent', char: 1 });
    const agent = await connectSocket(`${URL}/agent`, 'agent', { auth: { token: invite.token } });
    const roomWithAgent = latestRoom && agentPlayers(latestRoom).length === 1
      ? latestRoom
      : await waitForEvent(host, 'roomUpdate', (r) => r && agentPlayers(r).length === 1, 'agent room update');
    const agentPlayer = agentPlayers(roomWithAgent)[0];
    assert(agentPlayer, 'agent player did not join');

    host.emit('startGame');
    const observation = await waitForEvent(
      agent,
      'agentObservation',
      (payload) => payload && payload.status && payload.status.canAct === true,
      'playable agent observation',
      8000
    );
    const decisionTick = observation.status.tick;
    const received = waitForEvent(
      host,
      'agentPolicyUpdate',
      (policy) => policy && policy.decisionSource === 'llm-reply',
      'llm reply policy update',
      3000
    );

    const ack = await emitWithAck(agent, 'agentPolicyUpdate', {
      schema: 'crazay-arkade-agent-runtime-policy.v1',
      revision: 11,
      decisionSource: 'llm-reply',
      llmReplyId: 'reply-test-001',
      selectedHeuristicId: 'item-value',
      decisionTick,
      generatedAtTick: decisionTick,
      overview: 'LLM reply가 도착한 tick에서 바로 판단한 정책',
      cards: [
        {
          id: 'llm-reply-decision',
          kind: 'create',
          priority: 2,
          title: 'LLM reply 판단',
          summary: '최신 관측을 보관하다가 LLM reply를 받은 tick에서 행동 후보를 확정합니다.',
          signals: [`reply:reply-test-001`, `tick:${decisionTick}`],
          actions: ['decide:on-llm-reply', 'agentAction:bounded'],
        },
      ],
    });
    assert(ack && ack.ok === true, 'agentPolicyUpdate should accept llm reply metadata');
    const policy = await received;
    assert(policy.llmReplyId === 'reply-test-001', `llmReplyId was not preserved: ${policy.llmReplyId}`);
    assert(policy.selectedHeuristicId === 'item-value', `selectedHeuristicId was not preserved: ${policy.selectedHeuristicId}`);
    assert(policy.decisionTick === decisionTick, `decisionTick was not preserved: ${policy.decisionTick}`);
    assert(policy.generatedAtTick === decisionTick, `generatedAtTick mismatch: ${policy.generatedAtTick}`);
    console.log('PASS agent LLM reply policy tests');
    cleanup();
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
})();
