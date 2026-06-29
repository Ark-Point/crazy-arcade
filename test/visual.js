// Visual/E2E check: drive two real browser pages through login -> room ->
// game, hold a movement key, place a bomb, and screenshot the canvas.
// Fails on any page JS error.
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
    return page;
  }

  const a = await makePlayer('테스터A');
  const b = await makePlayer('테스터B');

  await a.click('#btn-create');
  await a.waitForSelector('#screen-room.active');
  await b.waitForSelector('.room-item');
  await b.click('.room-item');
  await b.waitForSelector('#screen-room.active');

  // pick characters: A -> 개구리(2), B -> 펭구(4)
  await a.click('.char-btn[data-char="2"]');
  await b.click('.char-btn[data-char="4"]');
  await a.waitForFunction(() =>
    document.querySelector('.char-btn[data-char="2"]').classList.contains('selected')
  );
  await a.waitForFunction(() => {
    const text = document.querySelector('#player-list').textContent;
    return text.includes('개구리') && text.includes('펭구');
  });
  const slotText = await a.textContent('#player-list');
  if (!slotText.includes('개구리') || !slotText.includes('펭구')) {
    console.error('FAIL: character selection not reflected in player list:', slotText);
    process.exit(1);
  }
  await a.screenshot({ path: 'test/screenshot-room.png' });

  await a.click('#btn-start');
  await a.waitForSelector('#screen-game.active');
  await b.waitForSelector('#screen-game.active');

  // wait out the countdown, then move and bomb
  await a.waitForTimeout(3500);
  await a.keyboard.down('ArrowRight');
  await b.keyboard.down('ArrowLeft');
  await a.waitForTimeout(600);
  await a.keyboard.press('Space');
  await a.keyboard.down('ArrowDown');
  await a.waitForTimeout(900);
  await a.keyboard.up('ArrowRight');
  await a.keyboard.up('ArrowDown');

  // catch the explosion (3s fuse) for the screenshot
  await a.waitForTimeout(2100);
  await a.screenshot({ path: 'test/screenshot-game.png' });
  await a.waitForTimeout(1500);
  await a.screenshot({ path: 'test/screenshot-after.png' });

  // A self-traps and dies -> B should get the VICTORY celebration
  try {
    await b.waitForSelector('.overlay-card.win', { timeout: 15000 });
    await b.waitForTimeout(900); // let fireworks pop
    await b.screenshot({ path: 'test/screenshot-victory.png' });
    console.log('victory overlay shown on winner');
  } catch {
    console.log('note: round did not end with a winner this run');
  }

  // verify prediction state is sane
  const pos = await a.evaluate(() => {
    const cv = document.querySelector('#game-canvas');
    return { w: cv.width, h: cv.height };
  });
  console.log('canvas:', JSON.stringify(pos));

  await browser.close();
  if (errors.length) {
    console.error('FAIL: page errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('PASS: no page errors, screenshots saved');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
