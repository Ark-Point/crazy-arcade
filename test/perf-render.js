const { chromium } = require('playwright');

const URL = process.env.URL || process.argv[2] || 'http://localhost:3000';
const SCREENSHOT = process.env.SCREENSHOT || 'test/perf-render.png';

const fail = async (browser, msg) => {
  console.error('FAIL:', msg);
  if (browser) await browser.close();
  process.exit(1);
};

(async () => {
  let browser = null;
  const errors = [];

  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.addInitScript(() => {
      window.__softBlockStrokeCount = 0;
      const originalStroke = CanvasRenderingContext2D.prototype.stroke;
      CanvasRenderingContext2D.prototype.stroke = function patchedStroke(...args) {
        const style = String(this.strokeStyle || '').toLowerCase();
        if (style.includes('141, 90, 36') || style.includes('8d5a24')) {
          window.__softBlockStrokeCount++;
        }
        return originalStroke.apply(this, args);
      };
    });

    await page.goto(URL);
    await page.fill('#nick-input', 'PerfA');
    await page.click('#btn-enter');
    await page.click('#btn-create');
    await page.waitForSelector('#screen-room.active', { timeout: 3000 });
    await page.click('#btn-start');
    await page.waitForSelector('#screen-game.active', { timeout: 3000 });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      window.__softBlockStrokeCount = 0;
    });
    await page.waitForTimeout(800);

    const count = await page.evaluate(() => window.__softBlockStrokeCount);
    await page.screenshot({ path: SCREENSHOT, fullPage: true });
    await browser.close();

    if (errors.length) {
      console.error('FAIL: page errors:\n' + errors.join('\n'));
      process.exit(1);
    }
    if (count > 4) {
      console.error(`FAIL: static soft blocks were redrawn ${count} times after warmup`);
      process.exit(1);
    }
    console.log(`PASS: static soft block redraw count ${count}; screenshot saved to ${SCREENSHOT}`);
    process.exit(0);
  } catch (err) {
    await fail(browser, err.message);
  }
})();
