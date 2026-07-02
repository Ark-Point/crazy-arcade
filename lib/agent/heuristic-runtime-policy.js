'use strict';

const {
  waitAction,
  hasNumber,
  cellKey,
  actionForMove,
  moveFromAction,
} = require('./heuristic-state');

function tickOf(state) {
  if (hasNumber(state.tick)) return state.tick;
  if (hasNumber(state.t)) return state.t;
  return null;
}

function rememberRoute(memory, node, kind) {
  if (!memory || !node) return;
  memory.routeTarget = cellKey(node.x, node.y);
  memory.routeKind = kind;
  if (kind !== 'pressure') clearPendingBomb(memory);
}

function clearRoute(memory) {
  if (!memory) return;
  memory.routeTarget = null;
  memory.routeKind = null;
}

function rememberPressureRoute(memory, node, opponent, state) {
  rememberRoute(memory, node, 'pressure');
  if (!memory || !node) return;
  memory.pendingBomb = {
    kind: 'pressure',
    cell: cellKey(node.x, node.y),
    target: opponent ? cellKey(opponent.x, opponent.y) : null,
    createdAtTick: tickOf(state),
  };
}

function clearPendingBomb(memory) {
  if (!memory) return;
  memory.pendingBomb = null;
}

function routeAction(memory, reachability) {
  if (!memory || !memory.routeTarget) return null;
  const start = reachability.start;
  if (!start) return null;
  if (cellKey(start.x, start.y) === memory.routeTarget) {
    clearRoute(memory);
    return null;
  }
  const target = reachability.reachable.get(memory.routeTarget);
  if (!target || !target.safe || !target.firstMove) {
    clearRoute(memory);
    return null;
  }
  return actionForMove(target.firstMove);
}

function rememberCurrentCell(memory, cell) {
  if (!memory || !cell) return;
  const key = cellKey(cell.x, cell.y);
  if (memory.lastCell !== key) {
    memory.recentCells = Array.isArray(memory.recentCells) ? memory.recentCells : [];
    memory.recentCells.push(key);
    if (memory.recentCells.length > 8) memory.recentCells.shift();
  }
  memory.lastCell = key;
}

function finalizeAction(memory, state, action) {
  const chosen = action || waitAction();
  if (!memory) return chosen;
  const move = moveFromAction(chosen);
  if (move) memory.lastMove = move;
  if (chosen.type === 'placeBomb') {
    memory.lastBombTick = tickOf(state);
    clearPendingBomb(memory);
  }
  if (chosen.type !== 'move' && chosen.type !== 'placeBomb') memory.lastNonMove = chosen.type;
  return chosen;
}

function rememberLastAction(memory, action) {
  if (!memory || !action || typeof action !== 'object') return action;
  const snapshot = {
    type: typeof action.type === 'string' ? action.type.slice(0, 32) : 'wait',
  };
  if (Number.isSafeInteger(action.seq)) snapshot.seq = action.seq;
  if (typeof action.item === 'string') snapshot.item = action.item.slice(0, 32);
  if (action.keys && typeof action.keys === 'object') {
    const keys = {};
    for (const key of ['up', 'down', 'left', 'right']) {
      if (action.keys[key]) keys[key] = true;
    }
    if (Object.keys(keys).length) snapshot.keys = keys;
  }
  memory.lastAction = snapshot;
  if (memory.runtimePolicy) {
    memory.policyRevision = (memory.policyRevision || 0) + 1;
    memory.runtimePolicy = { ...memory.runtimePolicy, revision: memory.policyRevision };
  }
  return action;
}

function cloneCard(card) {
  return {
    id: card.id,
    kind: card.kind,
    priority: card.priority,
    title: card.title,
    summary: card.summary,
    signals: [...card.signals],
    actions: [...card.actions],
  };
}

function makeEnforceCard(self, state, reason) {
  const tick = tickOf(state);
  return {
    id: 'runtime-survival-envelope',
    kind: 'enforce',
    priority: 1,
    title: '실시간 생존 감시',
    summary: `${reason} 상황을 관측해 안전하지 않은 행동을 먼저 차단합니다.`,
    signals: [
      `tick:${tick === null ? 'unknown' : tick}`,
      `trapped:${self.trapped === true}`,
      `needles:${self.needles || 0}`,
    ],
    actions: ['veto:unsafe', 'prefer:escape-or-recover'],
  };
}

function makeRouteCard(id, title, summary, signals, actions, priority = 2) {
  return { id, kind: 'create', priority, title, summary, signals, actions };
}

function publishRuntimePolicy(memory, state, self, reason, cards) {
  if (!memory) return;
  const ordered = [makeEnforceCard(self, state, reason), ...cards].map(cloneCard);
  const signature = JSON.stringify(ordered.map((card) => ({
    id: card.id,
    signals: card.signals,
    actions: card.actions,
  })));
  if (memory.policySignature !== signature) {
    memory.policyRevision = (memory.policyRevision || 0) + 1;
    memory.policySignature = signature;
  }
  memory.runtimePolicy = {
    schema: 'crazay-arkade-agent-runtime-policy.v1',
    revision: memory.policyRevision || 1,
    generatedAtTick: tickOf(state),
    overview: '에이전트가 현재 agentObservation을 바탕으로 이번 국면에 필요한 휴리스틱 카드를 생성했습니다.',
    cards: ordered,
  };
}

function pendingPressureBombReady(memory, selfCell, bombSafety, recentlyPlaced) {
  const pending = memory && memory.pendingBomb;
  if (!pending || pending.kind !== 'pressure') return false;
  if (recentlyPlaced || !bombSafety.ok) return false;
  return pending.cell === cellKey(selfCell.x, selfCell.y);
}

module.exports = {
  clearPendingBomb,
  clearRoute,
  cloneCard,
  finalizeAction,
  makeRouteCard,
  pendingPressureBombReady,
  publishRuntimePolicy,
  rememberCurrentCell,
  rememberLastAction,
  rememberPressureRoute,
  rememberRoute,
  routeAction,
  tickOf,
};
