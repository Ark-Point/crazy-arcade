'use strict';

const assert = require('assert');
const { Game } = require('../server/game');
const Shared = require('../public/shared');

function center(cell) {
  return cell * Shared.TILE + Shared.TILE / 2;
}

{
  const game = new Game(
    [
      { id: 'human', nick: 'Human' },
      { id: 'agent', nick: 'Agent', controller: 'agent' },
    ],
    () => {},
    () => {}
  );
  game.stop();
  game.tick = 200;

  const human = game.players.get('human');
  const agent = game.players.get('agent');
  for (const row of game.grid) row.fill(0);
  human.x = center(4);
  human.y = center(4);
  agent.x = center(5);
  agent.y = center(4);

  let overlapped = false;
  let sharedCell = false;
  for (let i = 0; i < 20; i++) {
    game.queueCmd('human', { seq: i + 1, keys: { right: true } });
    game.step();
    if (Math.abs(human.x - agent.x) < Shared.HALF * 2 && Math.abs(human.y - agent.y) < Shared.HALF * 2) {
      overlapped = true;
    }
    if (Math.floor(human.x / Shared.TILE) === Math.floor(agent.x / Shared.TILE)
      && Math.floor(human.y / Shared.TILE) === Math.floor(agent.y / Shared.TILE)) {
      sharedCell = true;
    }
  }

  assert.strictEqual(overlapped, true, 'living players should be able to overlap hitboxes while moving');
  assert.strictEqual(sharedCell, true, 'living players should be able to share the same center cell while moving');
}

{
  const game = new Game(
    [
      { id: 'human', nick: 'Human' },
      { id: 'agent', nick: 'Agent', controller: 'agent' },
    ],
    () => {},
    () => {},
    'boss'
  );
  game.stop();
  game.tick = 200;
  game.boss.attackAt = 999999;
  for (const row of game.grid) row.fill(0);
  const human = game.players.get('human');
  human.x = center(6);
  human.y = center(4);
  human.safeUntil = 0;
  game.minions.length = 0;
  game.minions.push({ id: 1, x: center(4), y: center(4), dx: 1, dy: 0, repathAt: 999999 });

  for (let i = 0; i < 80 && !human.trapped; i++) {
    game.tick++;
    game.updateMinions();
  }

  assert.strictEqual(human.trapped, true, 'live-player blocking should not stop boss minions from reaching players');
}

{
  const game = new Game(
    [
      { id: 'human', nick: 'Human' },
      { id: 'agent', nick: 'Agent', controller: 'agent' },
    ],
    () => {},
    () => {}
  );
  game.stop();
  game.tick = 200;
  const human = game.players.get('human');
  const agent = game.players.get('agent');
  for (const row of game.grid) row.fill(0);
  human.x = center(4);
  human.y = center(4);
  agent.x = center(5);
  agent.y = center(4);

  const serverPred = { ...human };
  const clientPred = { id: human.id, x: human.x, y: human.y, speed: human.speed };
  const snapshot = {
    grid: game.grid,
    players: [...game.players.values()].map((p) => ({
      id: p.id,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      alive: p.alive,
      trapped: p.trapped,
    })),
  };
  const clientWorld = {
    solid(p, cx, cy) {
      if (cx < 0 || cx >= Shared.COLS || cy < 0 || cy >= Shared.ROWS) return 1;
      const t = snapshot.grid[cy][cx];
      if (t === 1 || t === 2) return 1;
      return 0;
    },
  };

  for (let i = 0; i < 10; i++) {
    Shared.moveTick(game.world, serverPred, { right: true });
    Shared.moveTick(clientWorld, clientPred, { right: true });
  }

  assert.strictEqual(clientPred.x, serverPred.x, 'client prediction should match server live-player collision');
  assert.strictEqual(clientPred.y, serverPred.y, 'client prediction should match server live-player collision');
  assert.strictEqual(
    Math.floor(clientPred.x / Shared.TILE),
    Math.floor(agent.x / Shared.TILE),
    'client prediction should allow moving into another live player cell'
  );
}

console.log('PASS player collision tests');
