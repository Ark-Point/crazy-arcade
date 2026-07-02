const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = process.env.URL || process.argv[2] || 'http://localhost:3000';
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join('test', 'artifacts', 'chat-browser');

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.scrollingElement.scrollWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.innerWidth,
    `${label} overflowed horizontally: ${JSON.stringify(metrics)}`
  );
  return metrics;
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const actions = [];
  const errors = [];
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  async function makePlayer(nick) {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`${nick} pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`${nick} console: ${message.text()}`);
    });
    await page.goto(URL);
    await page.fill('#nick-input', nick);
    await page.click('#btn-enter');
    await page.waitForSelector('#screen-lobby.active');
    actions.push(`${nick}: entered lobby`);
    console.log(`${nick}: entered lobby`);
    return page;
  }

  const a = await makePlayer('ChatA');
  const b = await makePlayer('ChatB');

  await a.fill('#room-name-input', '채팅방');
  await a.click('#btn-create');
  await a.waitForSelector('#screen-room.active');
  actions.push('ChatA: created room');
  console.log('ChatA: created room');

  await b.waitForSelector('.room-item');
  await b.click('.room-item');
  await b.waitForSelector('#screen-room.active');
  await b.waitForFunction(() => document.querySelector('#player-list')?.textContent.includes('ChatB'));
  actions.push('ChatB: joined room');
  console.log('ChatB: joined room');

  await a.fill('#room-chat-input', '대기실 안녕');
  await a.click('#room-chat-send');
  await b.waitForFunction(() => {
    const text = document.querySelector('#room-chat-feed')?.textContent || '';
    return text.includes('ChatA') && text.includes('대기실 안녕');
  });
  actions.push('ChatA -> room chat: 대기실 안녕');
  console.log('ChatA -> room chat: 대기실 안녕');

  await a.fill('#room-chat-input', '빠른 첫 메시지');
  await a.click('#room-chat-send');
  await a.fill('#room-chat-input', '다음 초안');
  await a.waitForTimeout(300);
  assert.strictEqual(await a.inputValue('#room-chat-input'), '다음 초안', 'stale chat ack should not clear the next draft');
  await a.click('#room-chat-send');
  await b.waitForFunction(() => {
    const text = document.querySelector('#room-chat-feed')?.textContent || '';
    return text.includes('ChatA') && text.includes('다음 초안');
  });
  actions.push('room chat stale ack preserved next draft');
  console.log('room chat stale ack preserved next draft');

  await a.waitForTimeout(1100);
  await a.fill('#room-chat-input', '<img data-chat-edge="x">');
  await a.click('#room-chat-send');
  try {
    await b.waitForFunction(() => {
      const text = document.querySelector('#room-chat-feed')?.textContent || '';
      return text.includes('<img data-chat-edge');
    }, null, { timeout: 3000 });
  } catch (error) {
    const debug = {
      a: await a.evaluate(() => ({
        input: document.querySelector('#room-chat-input')?.value || '',
        feed: document.querySelector('#room-chat-feed')?.textContent || '',
        toast: document.querySelector('#toast:not(.hidden)')?.textContent || '',
      })),
      b: await b.evaluate(() => ({
        feed: document.querySelector('#room-chat-feed')?.textContent || '',
        toast: document.querySelector('#toast:not(.hidden)')?.textContent || '',
      })),
    };
    throw new Error(`HTML-like room chat did not render: ${JSON.stringify(debug)}`);
  }
  const roomSafety = await b.evaluate(() => ({
    text: document.querySelector('#room-chat-feed')?.textContent || '',
    injected: document.querySelectorAll('#room-chat-feed img,#room-chat-feed script').length,
  }));
  assert.strictEqual(roomSafety.injected, 0, 'HTML-like room chat inserted DOM nodes');
  actions.push('room chat HTML-like text rendered inertly');
  console.log('room chat HTML-like text rendered inertly');
  await b.screenshot({ path: path.join(EVIDENCE_DIR, 'room-chat.png'), fullPage: true });

  const roomResponsive = [];
  for (const viewport of [
    { label: 'room-desktop', width: 1280, height: 720 },
    { label: 'room-tablet', width: 768, height: 780 },
    { label: 'room-mobile', width: 375, height: 780 },
  ]) {
    await b.setViewportSize({ width: viewport.width, height: viewport.height });
    await b.waitForTimeout(150);
    const overflow = await assertNoHorizontalOverflow(b, viewport.label);
    const screenshot = `${viewport.label}.png`;
    await b.screenshot({ path: path.join(EVIDENCE_DIR, screenshot), fullPage: true });
    roomResponsive.push({ ...viewport, overflow, screenshot });
  }
  await b.setViewportSize({ width: 1280, height: 720 });

  await a.click('#btn-start');
  await a.waitForSelector('#screen-game.active', { timeout: 8000 });
  await b.waitForSelector('#screen-game.active', { timeout: 8000 });
  actions.push('game started');
  console.log('game started');

  await b.fill('#game-chat-input', '포커스');
  await b.focus('#game-chat-input');
  await b.keyboard.press('Space');
  await b.keyboard.type('방어');
  const focusedValue = await b.inputValue('#game-chat-input');
  assert.strictEqual(focusedValue, '포커스 방어', 'focused game chat should receive Space/text input');

  await b.fill('#game-chat-input', '게임 고고');
  await b.click('#game-chat-send');
  await a.waitForFunction(() => {
    const text = document.querySelector('#game-chat-feed')?.textContent || '';
    return text.includes('ChatB') && text.includes('게임 고고');
  });
  actions.push('ChatB -> game chat: 게임 고고');
  console.log('ChatB -> game chat: 게임 고고');

  const gameMetrics = await a.evaluate(() => {
    const rectOf = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return {
      gameText: document.querySelector('#game-chat-feed')?.textContent || '',
      canvas: rectOf('#game-canvas'),
      sidebar: rectOf('.sidebar'),
      chat: rectOf('.game-chat'),
      itemBox: rectOf('.item-box'),
      helpButton: rectOf('#btn-help'),
    };
  });
  await a.screenshot({ path: path.join(EVIDENCE_DIR, 'happy.png'), fullPage: true });

  const responsive = [];
  for (const viewport of [
    { label: 'desktop', width: 1280, height: 720 },
    { label: 'tablet', width: 768, height: 780 },
    { label: 'mobile', width: 375, height: 780 },
  ]) {
    await a.setViewportSize({ width: viewport.width, height: viewport.height });
    await a.waitForTimeout(150);
    const overflow = await assertNoHorizontalOverflow(a, viewport.label);
    const screenshot = `${viewport.label}.png`;
    await a.screenshot({ path: path.join(EVIDENCE_DIR, screenshot), fullPage: true });
    responsive.push({ ...viewport, overflow, screenshot });
  }

  const result = {
    ok: true,
    url: URL,
    roomSafety,
    focusedValue,
    gameMetrics,
    roomResponsive,
    responsive,
    actions,
    screenshots: [
      'room-chat.png',
      'room-desktop.png',
      'room-tablet.png',
      'room-mobile.png',
      'happy.png',
      'desktop.png',
      'tablet.png',
      'mobile.png',
    ],
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'action-log.json'), JSON.stringify(result, null, 2));

  await browser.close();
  if (errors.length) {
    throw new Error(`Browser errors:\n${errors.join('\n')}`);
  }
  console.log('PASS: browser waiting-room and in-game chat');
}

main().catch((error) => {
  console.error('FAIL:', error.stack || error.message);
  process.exit(1);
});
