'use strict';

const DEFAULT_DECISION_TICKS = 6;
const DEFAULT_TRAP_REACTION_TICKS = 9;
const DEFAULT_HELD_MOVE_TICKS = 2;

function observationTick(observation) {
  const status = observation && observation.status;
  if (status && Number.isFinite(status.tick)) return status.tick;
  const state = observation && observation.state;
  if (state && Number.isFinite(state.tick)) return state.tick;
  if (state && Number.isFinite(state.t)) return state.t;
  return null;
}

function isTrapRecovery(observation) {
  const status = observation && observation.status;
  return !!status && status.reason === 'trapped_agent_can_use_escape_action';
}

function createActionPacer(options = {}) {
  const decisionTicks = positiveInteger(options.decisionTicks, DEFAULT_DECISION_TICKS);
  const trapReactionTicks = positiveInteger(options.trapReactionTicks, DEFAULT_TRAP_REACTION_TICKS);
  const heldMoveTicks = positiveInteger(options.heldMoveTicks, DEFAULT_HELD_MOVE_TICKS);
  let nextDecisionTick = null;
  let nextHeldMoveTick = null;
  let trappedSinceTick = null;
  let heldAction = null;

  return {
    nextAction(observation, desiredAction) {
      const desired = desiredAction || { type: 'wait' };
      const status = observation && observation.status;
      if (status && status.canAct === false) return null;
      const tick = observationTick(observation);
      if (tick === null) {
        heldAction = desired;
        return desired;
      }

      if (isTrapRecovery(observation)) {
        if (trappedSinceTick === null) trappedSinceTick = tick;
        if (desired.type === 'wait') return null;
        if (tick - trappedSinceTick < trapReactionTicks) return null;
        if (nextDecisionTick !== null && tick < nextDecisionTick) return null;
        heldAction = null;
        nextDecisionTick = tick + trapReactionTicks;
        return desired;
      }

      trappedSinceTick = null;
      if (isSameMove(heldAction, desired)) return emitHeldMove(tick);
      if (nextDecisionTick !== null && tick < nextDecisionTick) return emitHeldMove(tick);
      heldAction = desired;
      nextDecisionTick = tick + decisionTicks;
      nextHeldMoveTick = isMove(desired) ? tick + heldMoveTicks : null;
      return desired;
    },

    reset() {
      nextDecisionTick = null;
      nextHeldMoveTick = null;
      trappedSinceTick = null;
      heldAction = null;
    },
  };

  function emitHeldMove(tick) {
    if (!isMove(heldAction)) return null;
    if (nextHeldMoveTick !== null && tick < nextHeldMoveTick) return null;
    nextHeldMoveTick = tick + heldMoveTicks;
    return heldAction;
  }
}

function isMove(action) {
  return !!action && action.type === 'move' && action.keys && typeof action.keys === 'object';
}

function isSameMove(left, right) {
  if (!isMove(left) || !isMove(right)) return false;
  return ['up', 'down', 'left', 'right'].every((key) => left.keys[key] === right.keys[key]);
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

module.exports = { createActionPacer };
