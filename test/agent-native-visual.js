'use strict';

const { chromium } = require('playwright');
const {
  resolveUrl,
  startServer,
  stopServer,
  closeAll,
} = require('./helpers/agent-harness');

(async () => {
  const server = resolveUrl() ? null : await startServer();
  const url = resolveUrl() || server.url;
  const screenshot = process.env.SCREENSHOT || '.omo/ulw-loop/ai-native-six-priorities-20260628/evidence/agent-native-visual.png';
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(url);
    await page.fill('#nick-input', 'VisualHost');
    await page.click('#btn-enter');
    await page.fill('#room-name-input', 'visual-native-room');
    await page.click('#btn-create');
    await page.waitForSelector('#agent-invite-panel');
    const waitingPolicyVisible = await page.locator('#agent-policy-panel').isVisible();
    if (waitingPolicyVisible) throw new Error('policy panel must not be visible in waiting room');
    const roomText = await page.locator('#agent-invite-panel').innerText();
    if (!roomText.includes('AI 초대') || !roomText.includes('관전')) {
      throw new Error('waiting room should explain AI invite and spectator workflow');
    }

    await page.evaluate(() => {
      window.agentPolicy = {
        schema: 'crazay-arkade-agent-runtime-policy.v2',
        nick: 'VisualAI',
        phase: 'survive',
        intent: 'escape_immediate_blast',
        selectedHeuristicId: 'survival-veto',
        fallbackHeuristicId: 'fallback-move',
        risk: 'high',
        confidence: 0.91,
        trace: { eventId: 99 },
        actionMask: { move: ['left', 'up'], placeBomb: false, useItem: ['needle'] },
        benchmark: { legality: '1/1', recovery: 'ready' },
        cards: [
          { id: 'visual-card', kind: 'enforce', priority: 1, title: '생존 정책', summary: '폭발 회피 정책', signals: ['phase:survive'], actions: ['move:left'] },
        ],
      };
      document.querySelector('#screen-room').classList.remove('active');
      document.querySelector('#screen-game').classList.add('active');
      window.renderAgentPolicy && window.renderAgentPolicy();
    });
    await page.waitForSelector('#agent-policy-panel');
    const policyText = await page.locator('#agent-policy-panel').innerText();
    if (!policyText.includes('survival-veto') || !policyText.includes('escape_immediate_blast')) {
      throw new Error(`policy panel missing v2 fields: ${policyText}`);
    }
    if (!policyText.includes('left') || !policyText.includes('placeBomb')) {
      throw new Error(`policy panel missing action mask: ${policyText}`);
    }
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`PASS agent native visual QA screenshot=${screenshot}`);
  } finally {
    await browser.close();
    closeAll();
    stopServer();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

