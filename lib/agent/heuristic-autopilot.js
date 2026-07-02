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

function chooseAction(observation, memory, options) {
  const normalized = normalizeObservation(observation);
  if (!normalized.ok) return waitAction();
  const { state, self } = normalized;
  const selfCell = playerCell(self, state);
  if (!selfCell) return waitAction();
  rememberCurrentCell(memory, selfCell);

  if (self.trapped) {
    clearPendingBomb(memory);
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
    clearPendingBomb(memory);
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

  const bombSafety = canSafelyPlaceBomb(observation, { details: true });
  const tick = tickOf(state);
  const recentlyPlaced = memory && hasNumber(memory.lastBombTick) && hasNumber(tick)
    ? tick - memory.lastBombTick < constants.STREAM_TICKS
    : false;
  const pressuredOpponents = opponentsInBlast(state, self, selfCell);
  if (pendingPressureBombReady(memory, selfCell, bombSafety, recentlyPlaced)) {
    const pendingTarget = memory.pendingBomb.target || 'unknown';
    rememberRoute(memory, bombSafety.escape, 'pressure-escape');
    publishRuntimePolicy(memory, state, self, '상대 압박 폭탄', [
      makeRouteCard(
        'runtime-pressure-bomb',
        '상대 압박 폭탄 카드',
        '이전 압박 경로에서 예약한 target-adjacent fire 지점에 도달해 폭탄 압박을 집행합니다.',
        [`pendingTarget:${pendingTarget}`, `escape:${cellKey(bombSafety.escape.x, bombSafety.escape.y)}`],
        ['placeBomb', 'commit:pressureEscapeRoute'],
        2
      ),
    ]);
    return finalizeAction(memory, state, { type: 'placeBomb' });
  }

  if (memory && memory.routeKind === 'pressure' && !recentlyPlaced && pressuredOpponents > 0 && bombSafety.ok) {
    rememberRoute(memory, bombSafety.escape, 'pressure-escape');
    publishRuntimePolicy(memory, state, self, '상대 압박 폭탄', [
      makeRouteCard(
        'runtime-pressure-bomb',
        '상대 압박 폭탄 카드',
        '압박 경로 이동 중 상대가 물줄기 범위에 들어오면 경로 유지를 중단하고 폭탄 압박을 집행합니다.',
        [`opponentsInBlast:${pressuredOpponents}`, `escape:${cellKey(bombSafety.escape.x, bombSafety.escape.y)}`],
        ['placeBomb', 'commit:pressureEscapeRoute'],
        2
      ),
    ]);
    return finalizeAction(memory, state, { type: 'placeBomb' });
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

  if (!recentlyPlaced && pressuredOpponents > 0 && bombSafety.ok) {
    rememberRoute(memory, bombSafety.escape, 'pressure-escape');
    publishRuntimePolicy(memory, state, self, '상대 압박 폭탄', [
      makeRouteCard(
        'runtime-pressure-bomb',
        '상대 압박 폭탄 카드',
        '상대가 현재 물줄기 범위 안에 있고 탈출 경로가 있으면 아이템보다 폭탄 압박을 우선 집행합니다.',
        [`opponentsInBlast:${pressuredOpponents}`, `escape:${cellKey(bombSafety.escape.x, bombSafety.escape.y)}`],
        ['placeBomb', 'commit:pressureEscapeRoute'],
        2
      ),
    ]);
    return finalizeAction(memory, state, { type: 'placeBomb' });
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

  const pressure = findPressureNode(state, self, reachability);
  if (pressure && pressure.node.firstMove) {
    rememberPressureRoute(memory, pressure.node, pressure.opponent, state);
    publishRuntimePolicy(memory, state, self, '상대 압박 경로', [
      makeRouteCard(
        'runtime-pressure-route',
        '상대 압박 경로 카드',
        '즉시 폭탄 각이 없을 때 상대의 행/열과 가까운 안전 칸으로 접근해 다음 폭탄 각을 만듭니다.',
        [`target:${cellKey(pressure.opponent.x, pressure.opponent.y)}`, `dist:${pressure.node.dist}`, `score:${pressure.score}`],
        ['move:pressureRoute', 'commit:pressureTarget']
      ),
    ]);
    return finalizeAction(memory, state, actionForMove(pressure.node.firstMove));
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

module.exports = {
  chooseAction,
};
