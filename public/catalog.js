(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Catalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CHARACTERS = [
    {
      id: 0,
      name: '버니',
      archetype: 'SPEED',
      color: '#f3f3f3',
      stats: { baseBombs: 1, maxBombs: 6, basePower: 1, maxPower: 7, baseSpeedLevel: 2, maxSpeedLevel: 6 },
    },
    {
      id: 1,
      name: '냥이',
      archetype: 'NORMAL',
      color: '#ffb74d',
      stats: { baseBombs: 1, maxBombs: 8, basePower: 1, maxPower: 7, baseSpeedLevel: 1, maxSpeedLevel: 5 },
    },
    {
      id: 2,
      name: '개구리',
      archetype: 'POWER',
      color: '#81c784',
      stats: { baseBombs: 1, maxBombs: 6, basePower: 2, maxPower: 8, baseSpeedLevel: 1, maxSpeedLevel: 5 },
    },
    {
      id: 3,
      name: '곰돌이',
      archetype: 'COUNT',
      color: '#bf9270',
      stats: { baseBombs: 2, maxBombs: 9, basePower: 1, maxPower: 6, baseSpeedLevel: 0, maxSpeedLevel: 4 },
    },
    {
      id: 4,
      name: '펭구',
      archetype: 'SPEED',
      color: '#607d8b',
      stats: { baseBombs: 1, maxBombs: 7, basePower: 1, maxPower: 7, baseSpeedLevel: 2, maxSpeedLevel: 6 },
    },
    {
      id: 5,
      name: '로보',
      archetype: 'COUNT',
      color: '#b0bec5',
      stats: { baseBombs: 2, maxBombs: 10, basePower: 1, maxPower: 8, baseSpeedLevel: 0, maxSpeedLevel: 4 },
    },
    {
      id: 6,
      name: '도치',
      archetype: 'POWER',
      color: '#f48fb1',
      stats: { baseBombs: 1, maxBombs: 7, basePower: 2, maxPower: 9, baseSpeedLevel: 1, maxSpeedLevel: 5 },
    },
    {
      id: 7,
      name: '우주',
      archetype: 'SPEED',
      color: '#80cbc4',
      stats: { baseBombs: 2, maxBombs: 8, basePower: 1, maxPower: 7, baseSpeedLevel: 3, maxSpeedLevel: 6 },
    },
  ];

  const ITEM_DEFS = {
    bomb: { name: '물풍선', kind: 'stat', glyph: '풍', color: '#42a5f5', icon: 'balloons.svg' },
    power: { name: '물줄기', kind: 'stat', glyph: '물', color: '#26c6da', icon: 'water-splash.svg' },
    speed: { name: '롤러', kind: 'stat', glyph: '속', color: '#ffca28', icon: 'roller-skate.svg' },
    needle: { name: '바늘', kind: 'escape', glyph: '침', color: '#90caf9', icon: 'syringe.svg' },
    shoes: { name: '킥슈즈', kind: 'passive', glyph: '킥', color: '#8d6e63', icon: 'running-shoe.svg' },
    ultra: { name: '울트라', kind: 'stat', glyph: 'U', color: '#00bcd4', icon: 'water-bolt.svg' },
    shield: { name: '실드', kind: 'active', glyph: '방', color: '#66bb6a', icon: 'energy-shield.svg' },
    glove: { name: '장갑', kind: 'active', glyph: '장', color: '#ff8a65', icon: 'boxing-glove.svg' },
    oxygen: { name: '산소통', kind: 'active', glyph: '숨', color: '#4dd0e1', icon: 'scuba-tanks.svg' },
    trap: { name: '함정', kind: 'active', glyph: '덫', color: '#ab47bc', icon: 'mantrap.svg' },
    angel: { name: '엔젤코인', kind: 'revive', glyph: '엔', color: '#ffd54f', icon: 'angel-wings.svg' },
  };

  const ACTIVE_ITEMS = ['shield', 'glove', 'oxygen', 'trap'];

  const DEFAULT_ITEM_TABLE = [
    ['bomb', 26],
    ['power', 25],
    ['speed', 20],
    ['shoes', 8],
    ['needle', 6],
    ['shield', 5],
    ['glove', 4],
    ['oxygen', 3],
    ['trap', 2],
    ['ultra', 1],
  ];

  const MAP_ORDER = ['village', 'camp', 'sea', 'pangland'];
  const MAPS = {
    village: {
      id: 'village',
      name: '빌리지',
      theme: 'village',
      icon: 'house.svg',
      description: '가장 기본적인 버블힐 마을형 대전 맵',
      layout: [
        '...++++.++++...',
        '.#.#.#.#.#.#.#.',
        '.+++.+++++.+++.',
        '.#.#.#.#.#.#.#.',
        '.++..+++++..++.',
        '.#.#.#.#.#.#.#.',
        '...++..+..++...',
        '.#.#.#.#.#.#.#.',
        '.++..+++++..++.',
        '.#.#.#.#.#.#.#.',
        '.+++.+++++.+++.',
        '.#.#.#.#.#.#.#.',
        '...++++.++++...',
      ],
      hazards: [],
      itemTable: DEFAULT_ITEM_TABLE,
    },
    camp: {
      id: 'camp',
      name: '캠프',
      theme: 'camp',
      icon: 'camping-tent.svg',
      description: '중앙 물대포가 주기적으로 라인을 쓸어내는 캠프 맵',
      layout: [
        '...++.....++...',
        '.#.#.#...#.#.#.',
        '.++..++T++..++.',
        '.#.#.#...#.#.#.',
        '.++++..+..++++.',
        '.#.#.......#.#.',
        '.....+++++.....',
        '.#.#.......#.#.',
        '.++++..+..++++.',
        '.#.#.#...#.#.#.',
        '.++..++T++..++.',
        '.#.#.#...#.#.#.',
        '...++.....++...',
      ],
      hazards: [
        { type: 'turret', x: 7, y: 2, dx: 0, dy: 1, length: 7, interval: 210, warning: 36, offset: 0 },
        { type: 'turret', x: 7, y: 10, dx: 0, dy: -1, length: 7, interval: 210, warning: 36, offset: 105 },
      ],
      itemTable: DEFAULT_ITEM_TABLE,
    },
    sea: {
      id: 'sea',
      name: '바다',
      theme: 'sea',
      icon: 'wave-crest.svg',
      description: '파도길이 이동을 밀어주는 바다 맵',
      layout: [
        '...++..+..++...',
        '.#.#.#.#.#.#.#.',
        '.++...+++...++.',
        '.#...#...#...#.',
        '.++++.....++++.',
        '.#...#...#...#.',
        '..++..+++..++..',
        '.#...#...#...#.',
        '.++++.....++++.',
        '.#...#...#...#.',
        '.++...+++...++.',
        '.#.#.#.#.#.#.#.',
        '...++..+..++...',
      ],
      hazards: [
        { type: 'current', x: 3, y: 6, dx: 1, dy: 0 },
        { type: 'current', x: 4, y: 6, dx: 1, dy: 0 },
        { type: 'current', x: 10, y: 6, dx: -1, dy: 0 },
        { type: 'current', x: 11, y: 6, dx: -1, dy: 0 },
      ],
      itemTable: DEFAULT_ITEM_TABLE,
    },
    pangland: {
      id: 'pangland',
      name: '팡랜드',
      theme: 'pangland',
      icon: 'mantrap.svg',
      description: '밟으면 물방울이 터지는 함정 놀이동산 맵',
      layout: [
        '...+++...+++...',
        '.#.#.#.#.#.#.#.',
        '.++..+++++..++.',
        '.#.#...#...#.#.',
        '.++++..+..++++.',
        '.#...#...#...#.',
        '...++..+..++...',
        '.#...#...#...#.',
        '.++++..+..++++.',
        '.#.#...#...#.#.',
        '.++..+++++..++.',
        '.#.#.#.#.#.#.#.',
        '...+++...+++...',
      ],
      hazards: [
        { type: 'bubbleTrap', x: 3, y: 3 },
        { type: 'bubbleTrap', x: 11, y: 3 },
        { type: 'bubbleTrap', x: 7, y: 6 },
        { type: 'bubbleTrap', x: 3, y: 9 },
        { type: 'bubbleTrap', x: 11, y: 9 },
      ],
      itemTable: DEFAULT_ITEM_TABLE,
    },
    'boss-cove': {
      id: 'boss-cove',
      name: '보스 해안',
      theme: 'boss',
      icon: 'trident.svg',
      description: '보스전을 위한 넓은 해안 아레나',
      layout: [
        '..+++.....+++..',
        '...............',
        '.++.........++.',
        '...............',
        '.++.........++.',
        '...............',
        '...............',
        '...............',
        '.++.........++.',
        '...............',
        '.++.........++.',
        '...............',
        '..+++.....+++..',
      ],
      hazards: [],
      itemTable: DEFAULT_ITEM_TABLE,
    },
  };

  function getCharacter(id) {
    return CHARACTERS[id] || CHARACTERS[0];
  }

  function getMap(id) {
    return MAPS[id] || MAPS.village;
  }

  function isActiveItem(type) {
    return ACTIVE_ITEMS.includes(type);
  }

  return {
    ACTIVE_ITEMS,
    CHARACTERS,
    DEFAULT_ITEM_TABLE,
    ITEM_DEFS,
    MAP_ORDER,
    MAPS,
    getCharacter,
    getMap,
    isActiveItem,
  };
});
