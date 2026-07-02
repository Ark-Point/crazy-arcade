'use strict';

const { waitAction } = require('./heuristic-state');
const { chooseAction } = require('./heuristic-autopilot');
const { chooseActionForHeuristic } = require('./heuristic-selected-policy');
const { canSafelyPlaceBomb } = require('./heuristic-tactics');
const {
  clearRoute,
  cloneCard,
  rememberLastAction,
} = require('./heuristic-runtime-policy');

function withSeq(action, seq) {
  return { ...(action || waitAction()), seq };
}

function createHeuristicAgent(options) {
  const memory = {
    seq: 0,
    routeTarget: null,
    routeKind: null,
    lastMove: null,
    lastCell: null,
    recentCells: [],
    lastBombTick: null,
    runtimePolicy: null,
    policyRevision: 0,
    policySignature: null,
  };
  return {
    chooseAction(observation) {
      return chooseAction(observation, memory, options || {});
    },
    chooseActionForHeuristic(observation, heuristicId) {
      return chooseActionForHeuristic(observation, memory, heuristicId, options || {});
    },
    nextAction(observation) {
      memory.seq += 1;
      return rememberLastAction(memory, withSeq(chooseAction(observation, memory, options || {}), memory.seq));
    },
    actionWithSeq(action) {
      memory.seq += 1;
      return rememberLastAction(memory, withSeq(action, memory.seq));
    },
    recordAction(action) {
      return rememberLastAction(memory, action);
    },
    reset() {
      memory.seq = 0;
      clearRoute(memory);
      memory.lastMove = null;
      memory.lastCell = null;
      memory.recentCells = [];
      memory.lastBombTick = null;
      memory.pendingBomb = null;
      memory.lastAction = null;
      memory.runtimePolicy = null;
      memory.policyRevision = 0;
      memory.policySignature = null;
    },
    policySnapshot() {
      if (!memory.runtimePolicy) {
        return {
          schema: 'crazay-arkade-agent-runtime-policy.v1',
          revision: 0,
          generatedAtTick: null,
          overview: '아직 생성된 runtime 휴리스틱이 없습니다.',
          cards: [],
        };
      }
      return {
        ...memory.runtimePolicy,
        lastAction: memory.lastAction ? { ...memory.lastAction, keys: memory.lastAction.keys ? { ...memory.lastAction.keys } : undefined } : null,
        cards: memory.runtimePolicy.cards.map(cloneCard),
      };
    },
    get seq() {
      return memory.seq;
    },
    get memory() {
      return { ...memory, pendingBomb: memory.pendingBomb ? { ...memory.pendingBomb } : null };
    },
  };
}

module.exports = {
  createHeuristicAgent,
  chooseAction,
  chooseActionForHeuristic,
  canSafelyPlaceBomb,
};
