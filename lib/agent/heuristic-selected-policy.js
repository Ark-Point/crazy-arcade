'use strict';

const {
  constants,
  waitAction,
  hasNumber,
  cellKey,
  playerCell,
  normalizeObservation,
  actionForMove,
} = require('./heuristic-state');
const { buildDangerMap, buildReachabilityMap } = require('./heuristic-danger');
const {
  canSafelyPlaceBomb,
  chooseFallbackMove,
  countSoftBlocksInBlast,
  currentCellDanger,
  findBestItem,
  findPressureNode,
  opponentsInBlast,
} = require('./heuristic-tactics');
const {
  clearPendingBomb,
  clearRoute,
  finalizeAction,
  makeRouteCard,
  pendingPressureBombReady,
  publishRuntimePolicy,
  rememberCurrentCell,
  rememberPressureRoute,
  rememberRoute,
  routeAction,
  tickOf,
} = require('./heuristic-runtime-policy');

function chooseActionForHeuristic(observation, memory, heuristicId, options) {
  const normalized = normalizeObservation(observation);
  if (!normalized.ok) return waitAction();
  const { state, self } = normalized;
  const selfCell = playerCell(self, state);
  if (!selfCell) return waitAction();
  rememberCurrentCell(memory, selfCell);

  if (self.trapped) {
    clearPendingBomb(memory);
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
    clearPendingBomb(memory);
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
    const bombSafety = canSafelyPlaceBomb(observation, { details: true });
    const tick = tickOf(state);
    const recentlyPlaced = memory && hasNumber(memory.lastBombTick) && hasNumber(tick)
      ? tick - memory.lastBombTick < constants.STREAM_TICKS
      : false;
    if (pendingPressureBombReady(memory, selfCell, bombSafety, recentlyPlaced)) {
      const pendingTarget = memory.pendingBomb.target || 'unknown';
      rememberRoute(memory, bombSafety.escape, 'pressure-escape');
      publishRuntimePolicy(memory, state, self, 'LLM 선택: 압박 폭탄 전환', [
        makeRouteCard('runtime-pressure-bomb', '상대 압박 폭탄 카드', 'LLM reply가 경로 유지를 선택했지만 pending pressure-bomb 지점에 도달해 폭탄을 우선 집행합니다.', [`pendingTarget:${pendingTarget}`, `selected:${heuristicId}`], ['placeBomb', 'commit:pressureEscapeRoute']),
      ]);
      return finalizeAction(memory, state, { type: 'placeBomb' });
    }
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
    const tick = tickOf(state);
    const recentlyPlaced = memory && hasNumber(memory.lastBombTick) && hasNumber(tick)
      ? tick - memory.lastBombTick < constants.STREAM_TICKS
      : false;
    if (!recentlyPlaced && countSoftBlocksInBlast(state, self, selfCell) > 0 && bombSafety.ok) {
      rememberRoute(memory, bombSafety.escape, 'bomb-escape');
      publishRuntimePolicy(memory, state, self, 'LLM 선택: 안전 폭탄 농사', [
        makeRouteCard('runtime-bomb-escape', '폭탄 탈출 카드', 'LLM reply가 박스 파밍 폭탄 휴리스틱 집행을 선택했습니다.', [`escape:${cellKey(bombSafety.escape.x, bombSafety.escape.y)}`, `selected:${heuristicId}`], ['placeBomb', 'commit:bombEscapeRoute']),
      ]);
      return finalizeAction(memory, state, { type: 'placeBomb' });
    }
  }

  if (heuristicId === 'pressure-trap') {
    const bombSafety = canSafelyPlaceBomb(observation, { details: true });
    const tick = tickOf(state);
    const recentlyPlaced = memory && hasNumber(memory.lastBombTick) && hasNumber(tick)
      ? tick - memory.lastBombTick < constants.STREAM_TICKS
      : false;
    const pressuredOpponents = opponentsInBlast(state, self, selfCell);
    if (!recentlyPlaced && pressuredOpponents > 0 && bombSafety.ok) {
      rememberRoute(memory, bombSafety.escape, 'pressure-escape');
      publishRuntimePolicy(memory, state, self, 'LLM 선택: 상대 압박 폭탄', [
        makeRouteCard('runtime-pressure-bomb', '상대 압박 폭탄 카드', 'LLM reply가 현재 물줄기 범위 안 상대를 압박하는 안전 폭탄 설치를 선택했습니다.', [`opponentsInBlast:${pressuredOpponents}`, `selected:${heuristicId}`], ['placeBomb', 'commit:pressureEscapeRoute']),
      ]);
      return finalizeAction(memory, state, { type: 'placeBomb' });
    }

    const pressure = findPressureNode(state, self, reachability);
    if (pressure && pressure.node.firstMove) {
      rememberPressureRoute(memory, pressure.node, pressure.opponent, state);
      publishRuntimePolicy(memory, state, self, 'LLM 선택: 상대 압박 경로', [
        makeRouteCard('runtime-pressure-route', '상대 압박 경로 카드', 'LLM reply가 상대의 도주로를 자르는 안전 접근 경로를 선택했습니다.', [`target:${cellKey(pressure.opponent.x, pressure.opponent.y)}`, `selected:${heuristicId}`, `score:${pressure.score}`], ['move:pressureRoute', 'commit:pressureTarget']),
      ]);
      return finalizeAction(memory, state, actionForMove(pressure.node.firstMove));
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

module.exports = {
  chooseActionForHeuristic,
};
