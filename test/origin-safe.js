const assert = require('assert');
const { Game } = require('../server/game');
const Shared = require('../public/shared');

const game = new Game(
  [
    { id: 'p1', nick: 'A' },
    { id: 'p2', nick: 'B' },
  ],
  () => {},
  () => {}
);
game.stop();
game.tick = 200; // past countdown

const p1 = game.players.get('p1'); // spawn cell (0,0)
const p2 = game.players.get('p2');

// p1 drops a balloon underfoot and stays on it; p2 stands in the arm path
game.placeBomb('p1');
const bomb = game.bombs[0];
assert(bomb && bomb.cx === 0 && bomb.cy === 0, 'bomb should sit on cell (0,0)');
assert(!Shared.boxCollides(game.world, p1, p1.x, p1.y), 'placer must not collide with their own balloon cell');
p2.x = 1 * 40 + 20;
p2.y = 20;

bomb.timer = 1;
game.step();

assert(!p1.trapped && p1.alive, 'placer standing on the bomb cell must NOT be bubbled');
assert(p2.trapped, 'player in the stream arm must be bubbled');
console.log('1. origin cell stays open, arm cell traps OK');

game.streams = [];
p2.trapped = false;
p2.trapUntil = 0;
game.streams.push({ x: 0, y: 0, until: game.tick + 10 });
game.step();
assert(p1.trapped, 'a foreign stream over the same cell must still bubble');
console.log('2. crossing stream still traps OK');

const originHit = new Game(
  [
    { id: 'owner', nick: 'Owner' },
    { id: 'agent', nick: 'Agent', controller: 'agent' },
  ],
  () => {},
  () => {}
);
originHit.stop();
originHit.tick = 200;
const owner = originHit.players.get('owner');
const agent = originHit.players.get('agent');
originHit.placeBomb('owner');
const originBomb = originHit.bombs[0];
assert(originBomb, 'origin-hit bomb should exist');
agent.x = originBomb.cx * Shared.TILE + Shared.TILE / 2;
agent.y = originBomb.cy * Shared.TILE + Shared.TILE / 2;
owner.x = 2 * Shared.TILE + Shared.TILE / 2;
owner.y = Shared.TILE / 2;
originBomb.timer = 1;
originHit.step();
assert(agent.trapped, 'agent standing on someone else’s bomb origin must be bubbled');
agent.trapUntil = originHit.tick;
originHit.step();
assert(!agent.alive, 'bubbled agent must die when trap timer expires');
console.log('3. foreign player on bomb origin traps and dies OK');

console.log('PASS');
process.exit(0);
