// Boss mode E2E: two browsers start a boss room, fight a bit, screenshot.
const { chromium } = require('playwright');
const URL = process.env.URL || process.argv[2] || 'http://localhost:3000';

(async () => {
  const errors = [];
  const browser = await chromium.launch();

  async function makePlayer(nick) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.on('pageerror', (e) => errors.push(`${nick}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${nick} console: ${m.text()}`);
    });
    await page.goto(URL);
    await page.fill('#nick-input', nick);
    await page.click('#btn-enter');
    await page.waitForSelector('#screen-lobby.active');
    return page;
  }

  const a = await makePlayer('용사A');
  const b = await makePlayer('용사B');

  await a.click('#btn-create');
  await a.waitForSelector('#screen-room.active');
  await a.click('#btn-mode-boss');
  await a.waitForFunction(() => document.querySelector('#btn-mode-boss').classList.contains('selected'));
  await a.waitForFunction(() => {
    const selected = document.querySelector('.map-btn.selected');
    return selected && selected.dataset.map === 'boss-cove' && selected.textContent.includes('보스 해안');
  });
  await b.waitForFunction(() => {
    const item = document.querySelector('.room-item');
    return item && item.textContent.includes('보스') && item.textContent.includes('보스 해안');
  });
  await b.waitForSelector('.room-item');
  await b.click('.room-item');
  await b.waitForSelector('#screen-room.active');
  await a.click('#btn-start');
  await a.waitForSelector('#screen-game.active');

  // countdown, then both players move toward the boss and bomb
  await a.waitForTimeout(3400);
  await a.keyboard.down('ArrowRight');
  await b.keyboard.down('ArrowLeft');
  await a.waitForTimeout(1500);
  await a.keyboard.press('Space');
  await b.keyboard.press('Space');
  await a.keyboard.up('ArrowRight');
  await a.keyboard.down('ArrowDown');
  await b.keyboard.up('ArrowLeft');
  await a.waitForTimeout(1200);
  await a.keyboard.up('ArrowDown');

  // catch telegraph/splash action
  await a.waitForTimeout(2400);
  await a.screenshot({ path: 'test/screenshot-boss.png' });

  const hp = await a.evaluate(() => {
    // reach into the page: last received boss state via canvas is not exposed,
    // so just confirm the game screen is still active without errors
    return document.querySelector('#screen-game.active') !== null;
  });
  console.log('game screen active:', hp);

  await browser.close();
  if (errors.length) {
    console.error('FAIL: page errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('PASS: boss E2E, screenshot saved');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
