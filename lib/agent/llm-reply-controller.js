'use strict';

const { createHeuristicAgent } = require('./heuristics');
const { createMovementSequencer } = require('./movement-sequence');

function observationTick(observation) {
  const status = observation && observation.status;
  if (status && Number.isFinite(status.tick)) return status.tick;
  const state = observation && observation.state;
  if (state && Number.isFinite(state.tick)) return state.tick;
  if (state && Number.isFinite(state.t)) return state.t;
  return null;
}

const POLICY_SCHEMA_V2 = 'crazay-arkade-agent-runtime-policy.v2';
const ALLOWED_HEURISTICS = new Set(['survival-veto', 'route-commit', 'item-value', 'safe-bomb-farm', 'pressure-trap', 'fallback-move']);
const ALLOWED_PHASES = new Set(['survive', 'farm', 'contest', 'recover', 'endgame']);
const ALLOWED_RISKS = new Set(['low', 'medium', 'high']);

function heuristicFromReply(reply) {
  const value = reply && (reply.heuristicId || reply.heuristic || reply.policyId);
  if (typeof value === 'string' && ALLOWED_HEURISTICS.has(value)) return value;
  return 'fallback-move';
}

function replyId(reply, index) {
  if (reply && typeof reply.id === 'string' && reply.id.trim()) return reply.id.trim().slice(0, 64);
  return `reply-${index}`;
}

function cardsFromReply(reply, decisionTick, heuristicId) {
  if (reply && Array.isArray(reply.cards) && reply.cards.length) return reply.cards;
  return [
    {
      id: 'llm-reply-heuristic-selection',
      kind: 'create',
      priority: 2,
      title: 'LLM reply 휴리스틱 선택',
      summary: 'LLM reply가 도착한 tick에서 집행할 휴리스틱을 선택하고, deterministic executor가 실제 action을 계산합니다.',
      signals: [`tick:${decisionTick === null ? 'unknown' : decisionTick}`],
      actions: [`execute:${heuristicId}`],
    },
  ];
}

function policyFromReply(reply, revision, decisionTick, heuristicId, sequencePlan) {
  const id = replyId(reply, revision);
  const phase = reply && ALLOWED_PHASES.has(reply.phase) ? reply.phase : 'survive';
  const risk = reply && ALLOWED_RISKS.has(reply.risk) ? reply.risk : 'medium';
  const confidence = Number.isFinite(reply && reply.confidence)
    ? Math.max(0, Math.min(1, reply.confidence))
    : null;
  return {
    schema: POLICY_SCHEMA_V2,
    revision,
    decisionSource: 'llm-reply',
    llmReplyId: id,
    decisionTick,
    generatedAtTick: decisionTick,
    phase,
    intent: reply && typeof reply.intent === 'string' ? reply.intent.trim().slice(0, 80) : `execute_${heuristicId}`,
    overview: reply && typeof reply.overview === 'string' && reply.overview.trim()
      ? reply.overview.trim().slice(0, 180)
      : 'LLM reply가 도착한 tick에서 최신 관측을 보고 집행할 휴리스틱을 선택했습니다.',
    selectedHeuristicId: heuristicId,
    fallbackHeuristicId: heuristicId === 'fallback-move' ? null : 'fallback-move',
    risk,
    confidence,
    expectedHorizonTicks: Number.isFinite(reply && reply.expectedHorizonTicks)
      ? Math.max(1, Math.min(300, Math.floor(reply.expectedHorizonTicks)))
      : 30,
    constraints: Array.isArray(reply && reply.constraints) ? reply.constraints.slice(0, 6) : ['human_paced'],
    reason: reply && typeof reply.reason === 'string' ? reply.reason.trim().slice(0, 160) : '',
    sequencePlan: sequencePlan || null,
    cards: cardsFromReply(reply, decisionTick, heuristicId),
  };
}

function createLlmReplyController(options = {}) {
  if (!options.replyProvider || typeof options.replyProvider.request !== 'function') {
    throw new TypeError('replyProvider.request is required');
  }
  const planner = options.planner || createHeuristicAgent();
  const pacer = options.pacer || null;
  const movementSequencer = options.movementSequencer || createMovementSequencer();
  const onDecision = typeof options.onDecision === 'function' ? options.onDecision : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let latestObservation = null;
  let inFlight = false;
  let closed = false;
  let revision = 0;
  let activeReply = null;
  let activeHeuristicId = null;
  let lastDecisionTick = null;

  function observeStatus(status) {
    if (!status || typeof status !== 'object') return;
    if (status.canAct === false) {
      movementSequencer.reset();
      activeReply = null;
      activeHeuristicId = null;
    }
    if (latestObservation) {
      latestObservation = { ...latestObservation, status };
    } else {
      latestObservation = { status };
    }
  }

  async function requestReply(seedObservation) {
    inFlight = true;
    try {
      const reply = await options.replyProvider.request(seedObservation);
      if (closed || !latestObservation || !latestObservation.status || latestObservation.status.canAct === false) return;
      const decisionObservation = latestObservation;
      const heuristicId = heuristicFromReply(reply);
      activeReply = reply;
      activeHeuristicId = heuristicId;
      emitDecision(decisionObservation, reply, heuristicId);
    } catch (error) {
      onError(error);
    } finally {
      inFlight = false;
      if (!closed && latestObservation && latestObservation.status && latestObservation.status.canAct) {
        requestReply(latestObservation);
      }
    }
  }

  function emitDecision(observation, reply, heuristicId) {
    const decisionTick = observationTick(observation);
    if (decisionTick !== null && decisionTick === lastDecisionTick) return;
    const desired = planner.chooseActionForHeuristic(observation, heuristicId);
    const sequenced = movementSequencer.nextAction(observation, desired, heuristicId);
    const paced = pacer ? pacer.nextAction(observation, sequenced) : sequenced;
    if (!paced) return;
    const action = planner.actionWithSeq(paced);
    revision += 1;
    lastDecisionTick = decisionTick;
    const policy = policyFromReply(reply, revision, decisionTick, heuristicId, movementSequencer.currentPlan());
    onDecision({ action, policy, reply, observation });
  }

  return {
    observeStatus,
    observe(observation) {
      latestObservation = observation;
      if (!observation || !observation.status || observation.status.canAct === false) return;
      if (activeReply && activeHeuristicId) emitDecision(observation, activeReply, activeHeuristicId);
      if (!inFlight && !closed) requestReply(observation);
    },
    close() {
      closed = true;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

module.exports = {
  createLlmReplyController,
  heuristicFromReply,
  policyFromReply,
};
