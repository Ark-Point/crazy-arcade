// Deterministic unit test for the new boss mechanics, driving the Game
// simulation directly (no sockets): freeze->kick->damage, lane charge,
// angel-coin revival.
const assert = require('assert');
const { Game } = require('../server/game');

const events = [];
const game = new Game(
  [
    { id: 'p1', nick: 'A' },
    { id: 'p2', nick: 'B' },
  ],
  (ev, data) => events.push([ev, data]),
  () => {},
  'boss'
);
game.stop(); // drive ticks manually
game.tick = 200; // past countdown
game.boss.attackAt = 999999; // keep the boss quiet unless asked

const p1 = game.players.get('p1');
const p2 = game.players.get('p2');

// --- 1) stream freezes a minion ---
game.minions.push({ id: 1, x: 300, y: 180, dx: 0, dy: 0, repathAt: 0, frozenUntil: 0 });
game.streams.push({ x: 7, y: 4, until: game.tick + 10 });
game.updateMinions();
const m = game.minions[0];
assert(m.frozenUntil > game.tick, 'minion should be frozen by the stream');
console.log('1. stream froze the minion OK');

// --- 2) pushing the frozen minion sends it flying into the boss for 3 damage ---
game.streams = [];
p1.x = 300;
p1.y = 158; // just above the minion -> kick downward toward the boss (300,260)
game.updateMinions();
assert(m.flying && m.fdy === 1, 'frozen minion should fly downward when pushed');
const hpBefore = game.boss.hp;
for (let i = 0; i < 20 && game.minions.length; i++) game.updateMinions();
assert.strictEqual(game.minions.length, 0, 'flying minion should be consumed');
assert.strictEqual(game.boss.hp, hpBefore - 3, 'boss should take 3 kick damage');
console.log('2. kicked minion hit the boss for 3 OK');

// --- 3) lane charge: telegraph -> dash -> long groggy ---
p1.x = p1.spawnX;
p1.y = p1.spawnY;
game.startCharge();
assert(game.boss.attack && game.boss.attack.type === 'charge', 'charge should start');
assert(game.telegraphs.length >= 3, 'charge lane should be telegraphed');
game.tick = game.boss.attack.until; // skip the telegraph
game.updateBoss();
assert.strictEqual(game.boss.attack.phase, 'dash', 'charge should enter dash');
assert.strictEqual(game.telegraphs.length, 0, 'telegraph should clear on dash');
let guard = 0;
while (game.boss.attack && guard++ < 200) {
  game.tick++;
  game.updateBoss();
}
assert(!game.boss.attack, 'dash should finish');
assert(game.boss.groggyUntil > game.tick, 'boss should be groggy after the charge');
console.log('3. lane charge telegraph/dash/groggy OK');

// --- 4) death drops an angel coin; picking it revives the ally ---
game.boss.groggyUntil = 0;
game.boss.x = 300; // keep the boss centered; coins never spawn within 100px of it
game.boss.y = 260;
game.boss.target = { x: 300, y: 260 }; // and keep it parked there
game.boss.attackAt = 999999;
p2.trapped = true;
p2.trapUntil = game.tick; // trap timer expired
game.step();
assert(!p2.alive, 'p2 should die when the bubble timer expires');
const coin = game.items.find((it) => it.type === 'angel');
assert(coin, 'an angel coin should drop after a death in boss mode');
// p1 walks onto the coin
p1.x = coin.x * 40 + 20;
p1.y = coin.y * 40 + 20;
game.step();
assert(p2.alive, 'p2 should be revived by the angel coin');
assert(!game.items.some((it) => it.type === 'angel'), 'coin should be consumed');
console.log('4. angel coin revive OK');

console.log('PASS');
process.exit(0);
