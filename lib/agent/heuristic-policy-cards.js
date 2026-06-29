'use strict';

const HEURISTIC_POLICY_OVERVIEW =
  '레퍼런스 에이전트는 agentObservation에서 위험도와 도달성 지도를 만들고, 생존 하드 베토를 먼저 통과한 뒤 아이템/폭탄/이동 카드를 고릅니다.';

const AGENT_ACTION_BUDGET_NOTE =
  '--max-actions는 examples/heuristic-agent.js가 N번 agentAction을 보낸 뒤 종료하는 디버그/테스트 예산입니다. 서버 제한이나 게임 정책이 아니며, 실제 서버 액션 제한은 /agent 소켓별 30/s 액션 봉투입니다.';

const HEURISTIC_POLICY_CARDS = Object.freeze([
  Object.freeze({
    id: 'survival-veto',
    kind: 'enforce',
    priority: 1,
    title: '생존 하드 베토',
    summary: '갇힘, 즉시 폭발, 탈출 실패 상황을 최우선으로 처리합니다.',
    signals: ['self.trapped', 'danger.lethalNow', 'nearestSafeExit'],
    actions: ['useNeedle', 'useItem:oxygen/shield', 'move:escape', 'wait'],
  }),
  Object.freeze({
    id: 'route-commit',
    kind: 'create',
    priority: 2,
    title: '경로 카드 생성',
    summary: '아이템 또는 폭탄 탈출 경로를 memory.routeKind/routeTarget으로 잠깐 고정합니다.',
    signals: ['routeTarget', 'routeKind', 'firstMove'],
    actions: ['move:firstMove', 'clearRoute'],
  }),
  Object.freeze({
    id: 'item-value',
    kind: 'create',
    priority: 3,
    title: '아이템 가치 선택',
    summary: '안전하게 도달 가능한 아이템을 가치와 거리로 점수화합니다.',
    signals: ['state.items', 'ITEM_VALUE', 'reachable.safe'],
    actions: ['move:itemRoute'],
  }),
  Object.freeze({
    id: 'safe-bomb-farm',
    kind: 'create',
    priority: 4,
    title: '안전 폭탄 농사',
    summary: '폭탄 용량, 기존 폭탄, 자폭 탈출 가능성을 통과해야 박스 파밍 폭탄을 놓습니다.',
    signals: ['maxBombs', 'bomb-present', 'safe-exit', 'softBlocksInBlast'],
    actions: ['placeBomb', 'routeKind:bomb-escape'],
  }),
  Object.freeze({
    id: 'pressure-trap',
    kind: 'create',
    priority: 5,
    title: '상대 압박 시퀀스',
    summary: '가까운 상대의 탈출 칸 옆으로 이동해 물풍선 압박과 도주 차단을 준비합니다.',
    signals: ['state.players', 'opponentReachability', 'escapeLanes'],
    actions: ['move:pressureRoute', 'placeBomb:onlyWithEscape'],
  }),
  Object.freeze({
    id: 'fallback-move',
    kind: 'create',
    priority: 6,
    title: '기본 이동 선택',
    summary: '할 일이 없으면 안전 칸 중 중앙 접근성과 직전 역방향 패널티로 이동을 고릅니다.',
    signals: ['reachable.safe', 'centerDistance', 'lastMove'],
    actions: ['move:safeFallback', 'wait'],
  }),
  Object.freeze({
    id: 'action-envelope',
    kind: 'enforce',
    priority: 7,
    title: '서버 액션 봉투',
    summary: '서버는 정책 코드를 실행하지 않고 seq, payload 크기, 초당 액션 수, 허용 액션만 검증합니다.',
    signals: ['seq', 'payload-size', '30/s rate cap'],
    actions: ['accept', 'reject:invalid action', 'agentFlagged:timing'],
  }),
]);

module.exports = {
  HEURISTIC_POLICY_OVERVIEW,
  AGENT_ACTION_BUDGET_NOTE,
  HEURISTIC_POLICY_CARDS,
};
