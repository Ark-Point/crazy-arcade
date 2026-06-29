'use strict';

const {
  constants,
  DIRECTIONS,
  REVERSE,
  ITEM_VALUE,
  waitAction,
  hasNumber,
  cellKey,
  dimensions,
  entityCell,
  playerCell,
  normalizeObservation,
  actionForMove,
  moveFromAction,
  tileAt,
} = require('./heuristic-state');
const {
  buildDangerMap,
  buildReachabilityMap,
  blastCellsForBomb,
  findBombAt,
} = require('./heuristic-danger');

function countSoftBlocksInBlast(state, self, cell) {
  const bomb = { x: cell.x, y: cell.y, power: Math.max(1, Math.floor(hasNumber(self.power) ? self.power : 2)) };
  return blastCellsForBomb(state, bomb).filter((blast) => tileAt(state, blast.x, blast.y) === constants.TILE_SOFT).length;
}

function hasBombCapacity(state, self) {
  if (!hasNumber(self.maxBombs)) return true;
  const activeBombs = Array.isArray(state.bombs) ? state.bombs.length : 0;
  return activeBombs < self.maxBombs;
}

function canSafelyPlaceBomb(input, options) {
  const normalized = normalizeObservation(input);
  if (!normalized.ok) return details(false, 'malformed', null, options);
  const { state, self } = normalized;
  const start = playerCell(self, state);
  if (!start) return details(false, 'malformed', null, options);
  if (hasNumber(self.maxBombs) && self.maxBombs <= 0) return details(false, 'no-capacity', null, options);
  if (!hasBombCapacity(state, self)) return details(false, 'capacity', null, options);
  if (findBombAt(state, start.x, start.y)) return details(false, 'bomb-present', null, options);

  const simulatedBomb = {
    id: '__self_lookahead__',
    x: start.x,
    y: start.y,
    t: constants.BOMB_FUSE_TICKS,
    power: Math.max(1, Math.floor(hasNumber(self.power) ? self.power : 2)),
    pass: [self.id],
  };
  const simulatedState = { ...state, bombs: [...(Array.isArray(state.bombs) ? state.bombs : []), simulatedBomb] };
  const observation = { ...input, self, state: simulatedState };
  const danger = buildDangerMap(observation);
  const reachability = buildReachabilityMap(observation, danger);
  const ownBlast = new Set(blastCellsForBomb(simulatedState, simulatedBomb).map((cell) => cellKey(cell.x, cell.y)));

  let escape = null;
  for (const node of reachability.reachable.values()) {
    if (!node.safe || node.dist <= 0 || ownBlast.has(cellKey(node.x, node.y))) continue;
    if (!escape || node.dist < escape.dist) escape = node;
  }
  return details(!!escape, escape ? 'ok' : 'no-safe-exit', escape, options, danger, reachability);
}

function details(ok, reason, escape, options, danger, reachability) {
  const payload = { ok, escape, danger, reachability, reason };
  return options && options.details ? payload : payload.ok;
}

function findBestItem(state, reachability) {
  let best = null;
  for (const item of Array.isArray(state.items) ? state.items : []) {
    const cell = entityCell(item, state, false);
    if (!cell) continue;
    const node = reachability.reachable.get(cellKey(cell.x, cell.y));
    if (!node || !node.safe) continue;
    const score = (ITEM_VALUE[item.type] || 10) * 10 - node.dist * 4;
    const candidate = { item, node, score, key: cellKey(cell.x, cell.y) };
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.node.dist < best.node.dist) || (candidate.score === best.score && candidate.node.dist === best.node.dist && candidate.key < best.key)) best = candidate;
  }
  return best;
}

function rememberRoute(memory, node, kind) {
  if (!memory || !node) return;
  memory.routeTarget = cellKey(node.x, node.y);
  memory.routeKind = kind;
}

function clearRoute(memory) {
  if (!memory) return;
  memory.routeTarget = null;
  memory.routeKind = null;
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

function currentCellDanger(dangerMap, cell) {
  const key = cellKey(cell.x, cell.y);
  const at = dangerMap.dangerAt.get(key);
  if (dangerMap.lethalNow.has(key)) return 0;
  return at === undefined ? Infinity : at;
}

function adjacentSoftBlocks(state, x, y) {
  return DIRECTIONS.reduce((count, dir) => (
    tileAt(state, x + dir.dx, y + dir.dy) === constants.TILE_SOFT ? count + 1 : count
  ), 0);
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

function chooseFallbackMove(reachability, memory) {
  const start = reachability.start;
  if (!start) return null;
  const candidates = [];
  const center = { x: Math.floor(dimensions(reachability.state).width / 2), y: Math.floor(dimensions(reachability.state).height / 2) };
  const recent = new Set(memory && Array.isArray(memory.recentCells) ? memory.recentCells : []);
  for (const node of reachability.reachable.values()) {
    if (!node || !node.safe || node.dist <= 0 || !node.firstMove) continue;
    const key = cellKey(node.x, node.y);
    const reversePenalty = memory && memory.lastMove && REVERSE[memory.lastMove] === node.firstMove ? 3 : 0;
    const revisitPenalty = recent.has(key) ? 4 : 0;
    const softBonus = adjacentSoftBlocks(reachability.state, node.x, node.y) * 4;
    const centerScore = -(Math.abs(center.x - node.x) + Math.abs(center.y - node.y));
    const distancePenalty = node.dist * 1.25;
    candidates.push({
      dir: node.firstMove,
      dist: node.dist,
      score: centerScore + softBonus - distancePenalty - reversePenalty - revisitPenalty,
    });
  }
  candidates.sort((a, b) => (
    b.score - a.score
    || a.dist - b.dist
    || DIRECTIONS.findIndex((dir) => dir.name === a.dir) - DIRECTIONS.findIndex((dir) => dir.name === b.dir)
  ));
  return candidates[0] ? actionForMove(candidates[0].dir) : null;
}

function finalizeAction(memory, state, action) {
  const chosen = action || waitAction();
  if (!memory) return chosen;
  const move = moveFromAction(chosen);
  if (move) memory.lastMove = move;
  if (chosen.type === 'placeBomb') memory.lastBombTick = hasNumber(state.tick) ? state.tick : null;
  if (chosen.type !== 'move' && chosen.type !== 'placeBomb') memory.lastNonMove = chosen.type;
  return chosen;
}

function tickOf(state) {
  if (hasNumber(state.tick)) return state.tick;
  if (hasNumber(state.t)) return state.t;
  return null;
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

function chooseAction(observation, memory, options) {
  const normalized = normalizeObservation(observation);
  if (!normalized.ok) return waitAction();
  const { state, self } = normalized;
  const selfCell = playerCell(self, state);
  if (!selfCell) return waitAction();
  rememberCurrentCell(memory, selfCell);

  if (self.trapped) {
    publishRuntimePolicy(memory, state, self, '갇힘 복구', [
      makeRouteCard(
        'runtime-trap-recovery',
        '갇힘 복구 카드',
        '물방울 상태에서 바늘/산소 아이템을 우선 검토하고 없으면 구조를 기다립니다.',
        ['self.trapped', `needles:${self.needles || 0}`, `oxygen:${(self.inventory && self.inventory.oxygen) || 0}`],
        ['useNeedle', 'useItem:oxygen', 'wait']
      ),
    ]);
    if ((self.needles || 0) > 0) return finalizeAction(memory, state, { type: 'useNeedle' });
    if (self.inventory && self.inventory.oxygen > 0) return finalizeAction(memory, state, { type: 'useItem', item: 'oxygen' });
    return waitAction();
  }

  const danger = buildDangerMap(observation, options);
  const reachability = buildReachabilityMap(observation, danger, options);
  const currentDanger = currentCellDanger(danger, selfCell);
  if (currentDanger <= constants.ESCAPE_URGENCY_TICKS || danger.lethalNow.has(cellKey(selfCell.x, selfCell.y))) {
    clearRoute(memory);
    publishRuntimePolicy(memory, state, self, '긴급 탈출', [
      makeRouteCard(
        'runtime-escape-route',
        '긴급 탈출 카드',
        '현재 칸의 폭발 임박도를 보고 가장 가까운 안전 출구로 이동하는 정책을 생성합니다.',
        [`danger:${currentDanger}`, `nearestSafeExit:${!!reachability.nearestSafeExit}`],
        ['move:nearestSafeExit', 'useItem:shield', 'wait']
      ),
    ]);
    if (reachability.nearestSafeExit && reachability.nearestSafeExit.firstMove) return finalizeAction(memory, state, actionForMove(reachability.nearestSafeExit.firstMove));
    if (self.inventory && self.inventory.shield > 0) return finalizeAction(memory, state, { type: 'useItem', item: 'shield' });
    return waitAction();
  }

  const committed = routeAction(memory, reachability);
  if (committed) {
    publishRuntimePolicy(memory, state, self, '경로 유지', [
      makeRouteCard(
        'runtime-route-commit',
        '경로 유지 카드',
        '이전에 생성한 목표 경로가 아직 안전하면 같은 routeTarget으로 이동을 이어갑니다.',
        [`routeKind:${memory && memory.routeKind ? memory.routeKind : 'unknown'}`, `routeTarget:${memory && memory.routeTarget ? memory.routeTarget : 'none'}`],
        ['move:committedFirstMove', 'clearRoute:unsafe']
      ),
    ]);
    return finalizeAction(memory, state, committed);
  }

  const item = findBestItem(state, reachability);
  if (item && item.node.dist > 0 && item.node.firstMove) {
    rememberRoute(memory, item.node, 'item');
    publishRuntimePolicy(memory, state, self, '아이템 경로', [
      makeRouteCard(
        'runtime-item-route',
        '아이템 경로 카드',
        '안전하게 도달 가능한 아이템을 발견해 가치와 거리 기준으로 임시 경로를 생성합니다.',
        [`item:${item.item.type || 'unknown'}`, `dist:${item.node.dist}`, `score:${item.score}`],
        ['move:itemRoute', 'commit:routeTarget']
      ),
    ]);
    return finalizeAction(memory, state, actionForMove(item.node.firstMove));
  }

  const bombSafety = canSafelyPlaceBomb(observation, { details: true });
  const recentlyPlaced = memory && hasNumber(memory.lastBombTick) && hasNumber(state.tick)
    ? state.tick - memory.lastBombTick < constants.STREAM_TICKS
    : false;
  if (!recentlyPlaced && countSoftBlocksInBlast(state, self, selfCell) > 0 && bombSafety.ok) {
    rememberRoute(memory, bombSafety.escape, 'bomb-escape');
    publishRuntimePolicy(memory, state, self, '폭탄 파밍', [
      makeRouteCard(
        'runtime-bomb-escape',
        '폭탄 탈출 카드',
        '박스를 부술 수 있고 자폭 탈출 경로가 있을 때 폭탄 설치와 탈출 경로를 함께 생성합니다.',
        [`escape:${cellKey(bombSafety.escape.x, bombSafety.escape.y)}`, `softBlocks:${countSoftBlocksInBlast(state, self, selfCell)}`],
        ['placeBomb', 'commit:bombEscapeRoute']
      ),
    ]);
    return finalizeAction(memory, state, { type: 'placeBomb' });
  }

  publishRuntimePolicy(memory, state, self, '안전 탐색', [
    makeRouteCard(
      'runtime-safe-fallback',
      '안전 이동 카드',
      '즉시 목표가 없을 때 안전 칸 중 중앙 접근성과 직전 역방향 패널티로 이동 후보를 생성합니다.',
      [`reachable:${reachability.reachable.size}`, `lastMove:${memory && memory.lastMove ? memory.lastMove : 'none'}`],
      ['move:safeFallback', 'wait']
    ),
  ]);
  return finalizeAction(memory, state, chooseFallbackMove(reachability, memory));
}

function chooseActionForHeuristic(observation, memory, heuristicId, options) {
  const normalized = normalizeObservation(observation);
  if (!normalized.ok) return waitAction();
  const { state, self } = normalized;
  const selfCell = playerCell(self, state);
  if (!selfCell) return waitAction();
  rememberCurrentCell(memory, selfCell);

  if (self.trapped) {
    publishRuntimePolicy(memory, state, self, 'LLM 선택 이전 생존 집행', [
      makeRouteCard(
        'runtime-trap-recovery',
        '갇힘 복구 카드',
        'LLM이 고른 휴리스틱과 무관하게 물방울 상태에서는 복구 휴리스틱을 강제합니다.',
        ['override:trapped', `selected:${heuristicId || 'none'}`],
        ['useNeedle', 'useItem:oxygen', 'wait']
      ),
    ]);
    if ((self.needles || 0) > 0) return finalizeAction(memory, state, { type: 'useNeedle' });
    if (self.inventory && self.inventory.oxygen > 0) return finalizeAction(memory, state, { type: 'useItem', item: 'oxygen' });
    return waitAction();
  }

  const danger = buildDangerMap(observation, options);
  const reachability = buildReachabilityMap(observation, danger, options);
  const currentDanger = currentCellDanger(danger, selfCell);
  if (currentDanger <= constants.ESCAPE_URGENCY_TICKS || danger.lethalNow.has(cellKey(selfCell.x, selfCell.y))) {
    clearRoute(memory);
    publishRuntimePolicy(memory, state, self, 'LLM 선택 이전 긴급 탈출', [
      makeRouteCard(
        'runtime-escape-route',
        '긴급 탈출 카드',
        'LLM이 고른 휴리스틱과 무관하게 폭발 임박 상황에서는 탈출 휴리스틱을 강제합니다.',
        [`danger:${currentDanger}`, `selected:${heuristicId || 'none'}`],
        ['move:nearestSafeExit', 'useItem:shield', 'wait']
      ),
    ]);
    if (reachability.nearestSafeExit && reachability.nearestSafeExit.firstMove) return finalizeAction(memory, state, actionForMove(reachability.nearestSafeExit.firstMove));
    if (self.inventory && self.inventory.shield > 0) return finalizeAction(memory, state, { type: 'useItem', item: 'shield' });
    return waitAction();
  }

  if (heuristicId === 'route-commit') {
    const committed = routeAction(memory, reachability);
    publishRuntimePolicy(memory, state, self, 'LLM 선택: 경로 유지', [
      makeRouteCard('runtime-route-commit', '경로 유지 카드', 'LLM reply가 기존 routeTarget 집행을 선택했습니다.', [`selected:${heuristicId}`, `routeTarget:${memory && memory.routeTarget ? memory.routeTarget : 'none'}`], ['move:committedFirstMove', 'clearRoute:unsafe']),
    ]);
    return finalizeAction(memory, state, committed || chooseFallbackMove(reachability, memory));
  }

  if (heuristicId === 'item-value') {
    const item = findBestItem(state, reachability);
    if (item && item.node.dist > 0 && item.node.firstMove) {
      rememberRoute(memory, item.node, 'item');
      publishRuntimePolicy(memory, state, self, 'LLM 선택: 아이템 가치', [
        makeRouteCard('runtime-item-route', '아이템 경로 카드', 'LLM reply가 안전하게 도달 가능한 아이템 휴리스틱 집행을 선택했습니다.', [`item:${item.item.type || 'unknown'}`, `dist:${item.node.dist}`, `selected:${heuristicId}`], ['move:itemRoute', 'commit:routeTarget']),
      ]);
      return finalizeAction(memory, state, actionForMove(item.node.firstMove));
    }
  }

  if (heuristicId === 'safe-bomb-farm') {
    const bombSafety = canSafelyPlaceBomb(observation, { details: true });
    const recentlyPlaced = memory && hasNumber(memory.lastBombTick) && hasNumber(state.tick)
      ? state.tick - memory.lastBombTick < constants.STREAM_TICKS
      : false;
    if (!recentlyPlaced && countSoftBlocksInBlast(state, self, selfCell) > 0 && bombSafety.ok) {
      rememberRoute(memory, bombSafety.escape, 'bomb-escape');
      publishRuntimePolicy(memory, state, self, 'LLM 선택: 안전 폭탄 농사', [
        makeRouteCard('runtime-bomb-escape', '폭탄 탈출 카드', 'LLM reply가 박스 파밍 폭탄 휴리스틱 집행을 선택했습니다.', [`escape:${cellKey(bombSafety.escape.x, bombSafety.escape.y)}`, `selected:${heuristicId}`], ['placeBomb', 'commit:bombEscapeRoute']),
      ]);
      return finalizeAction(memory, state, { type: 'placeBomb' });
    }
  }

  publishRuntimePolicy(memory, state, self, 'LLM 선택: 기본 안전 이동', [
    makeRouteCard(
      'runtime-safe-fallback',
      '안전 이동 카드',
      'LLM reply가 선택한 휴리스틱이 실행 불가하거나 fallback-move를 선택해 안전 이동 휴리스틱을 집행합니다.',
      [`selected:${heuristicId || 'fallback-move'}`, `reachable:${reachability.reachable.size}`],
      ['move:safeFallback', 'wait']
    ),
  ]);
  return finalizeAction(memory, state, chooseFallbackMove(reachability, memory));
}

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
      return withSeq(chooseAction(observation, memory, options || {}), memory.seq);
    },
    actionWithSeq(action) {
      memory.seq += 1;
      return withSeq(action, memory.seq);
    },
    reset() {
      memory.seq = 0;
      clearRoute(memory);
      memory.lastMove = null;
      memory.lastCell = null;
      memory.recentCells = [];
      memory.lastBombTick = null;
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
        cards: memory.runtimePolicy.cards.map(cloneCard),
      };
    },
    get seq() {
      return memory.seq;
    },
    get memory() {
      return { ...memory };
    },
  };
}

module.exports = {
  createHeuristicAgent,
  chooseAction,
  chooseActionForHeuristic,
  canSafelyPlaceBomb,
};
