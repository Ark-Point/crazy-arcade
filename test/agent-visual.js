const { chromium } = require('playwright');
const { io } = require('socket.io-client');

const URL = process.argv[2] || process.env.URL || 'http://localhost:3000';
const SELECTORS = {
  panel: '[data-testid="ai-invite-panel"], #agent-invite-panel',
  create: '[data-testid="create-agent-invite"], #btn-agent-invite-create',
  token: '[data-testid="ai-invite-token"], #agent-invite-token',
  command: '#agent-command-preview',
  commandCopy: '#btn-agent-command-copy',
  revoke: '[data-testid="revoke-agent-invite"], #btn-agent-invite-revoke',
  status: '[data-testid="ai-invite-status"], #agent-invite-status',
  inviteHelp: '.agent-invite-help',
  marker: '[data-testid="ai-player-marker"], .agent-badge',
  policyPanel: '#agent-policy-panel',
  policyCard: '.agent-policy-card',
  policyBudget: '#agent-policy-budget',
};

const fail = async (browser, msg) => {
  console.error('FAIL:', msg);
  if (browser) await browser.close();
  process.exit(1);
};

const assert = async (browser, condition, msg) => {
  if (!condition) await fail(browser, msg);
};

const connectAgent = (token) => new Promise((resolve, reject) => {
  const socket = io(`${URL}/agent`, {
    auth: { token },
    reconnection: false,
    timeout: 2000,
    forceNew: true,
  });
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error('agent UI marker token connect timed out'));
  }, 3000);
  socket.once('connect', () => {
    clearTimeout(timer);
    resolve(socket);
  });
  socket.once('connect_error', (err) => {
    clearTimeout(timer);
    socket.close();
    reject(new Error(`agent UI marker connect error: ${err.message}`));
  });
});

const copiedToken = async (page) => page.evaluate(() => window.__copiedAgentToken || '');

const clickCreateInvite = async (page) => {
  await page.click(SELECTORS.create);
  await page.waitForSelector(SELECTORS.token, { state: 'visible', timeout: 3000 });
};

const tokenFromCommand = (command) => {
  const match = String(command).match(/CRAZAY_ARKADE_AGENT_TOKEN=([^\s]+)/);
  return match ? match[1] : '';
};

const copyInviteCommand = async (page) => {
  await page.click(SELECTORS.commandCopy);
  await page.waitForFunction(() => typeof window.__copiedAgentToken === 'string' && window.__copiedAgentToken.length >= 16);
  return copiedToken(page);
};

const assertRedactedDisplay = async (browser, page, token) => {
  const display = (await page.textContent(SELECTORS.token)).trim();
  await assert(browser, display.length > 0, 'invite token display was empty');
  await assert(browser, display !== token, 'invite token display exposed the raw token');
  await assert(browser, !display.includes(token), 'invite token display included the raw token');
  await assert(browser, /[*.•]/.test(display) || display.includes('...'), 'invite token display was not visibly redacted');
};

const assertNoOverflow = async (browser, page, selectors) => {
  const failures = await page.evaluate((items) => {
    return items.flatMap((selector) => {
      return [...document.querySelectorAll(selector)].flatMap((el) => {
        const rect = el.getBoundingClientRect();
        const overflowX = el.scrollWidth - el.clientWidth;
        const overflowY = el.scrollHeight - el.clientHeight;
        const horizontalOffscreen = rect.left < -1 || rect.right > window.innerWidth + 1;
        if (overflowX > 2 || overflowY > 2 || horizontalOffscreen) {
          return [`${selector} overflowX=${overflowX} overflowY=${overflowY} rect=${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}`];
        }
        return [];
      });
    });
  }, selectors);
  await assert(browser, failures.length === 0, `obvious AI UI overflow:\n${failures.join('\n')}`);
};

const gameLayoutMetrics = async (page) => page.evaluate(() => {
  const rectOf = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const policyPanel = document.querySelector('#agent-policy-panel');
  return {
    canvas: rectOf('#game-canvas'),
    sidebar: rectOf('.sidebar'),
    itemBox: rectOf('.item-box'),
    helpButton: rectOf('#btn-help'),
    policy: rectOf('#agent-policy-panel'),
    policyOpen: !!(policyPanel && policyPanel.open),
  };
});

const assertStablePolicyUpdateLayout = async (browser, before, after) => {
  await assert(browser, before.policyOpen === false, 'policy drawer should start collapsed in-game');
  await assert(browser, after.policyOpen === false, 'runtime policy update opened the drawer without user action');
  for (const key of ['canvas', 'sidebar', 'itemBox', 'helpButton']) {
    const oldRect = before[key];
    const newRect = after[key];
    await assert(browser, oldRect && newRect, `${key} layout metrics were unavailable`);
    const drift = Math.max(
      Math.abs(oldRect.top - newRect.top),
      Math.abs(oldRect.left - newRect.left),
      Math.abs(oldRect.width - newRect.width),
      Math.abs(oldRect.height - newRect.height)
    );
    await assert(browser, drift <= 2, `${key} drifted by ${drift}px after runtime policy update`);
  }
};

const emitRuntimePolicy = (agent) => new Promise((resolve, reject) => {
  agent.timeout(2000).emit('agentPolicyUpdate', {
    schema: 'crazay-arkade-agent-runtime-policy.v1',
    revision: 7,
    decisionSource: 'llm-reply',
    llmReplyId: 'reply-visual-001',
    selectedHeuristicId: 'item-value',
    decisionTick: 123,
    generatedAtTick: 123,
    overview: '테스트 에이전트가 게임 중 생성한 정책',
    cards: [
      {
        id: 'runtime-visual-route',
        kind: 'create',
        priority: 2,
        title: '테스트 런타임 카드',
        summary: '현재 관측에서 안전 경로 후보를 만들어 UI에 공개합니다.',
        signals: ['danger:low', 'route:open'],
        actions: ['move:runtimeRoute'],
      },
      {
        id: 'runtime-visual-veto',
        kind: 'enforce',
        priority: 1,
        title: '테스트 안전 집행',
        summary: '위험한 후보 행동을 먼저 차단합니다.',
        signals: ['stream:false'],
        actions: ['veto:unsafe'],
      },
    ],
  }, (err, response) => {
    if (err) {
      reject(new Error(`agentPolicyUpdate ack failed: ${err.message || err}`));
      return;
    }
    if (!response || response.ok === false) {
      reject(new Error(`agentPolicyUpdate rejected: ${response && response.error ? response.error : 'unknown error'}`));
      return;
    }
    resolve(response);
  });
});

(async () => {
  let browser = null;
  let agent = null;
  const errors = [];

  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 820 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });
    await context.addInitScript(() => {
      window.__copiedAgentToken = '';
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copiedAgentToken = String(text);
          },
          readText: async () => window.__copiedAgentToken,
        },
      });
    });

    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto(URL);
    await page.fill('#nick-input', 'AgentVisual');
    await page.click('#btn-enter');
    await page.fill('#room-name-input', 'agent visual');
    await page.click('#btn-create');
    await page.waitForSelector('#screen-room.active', { timeout: 3000 });
    await page.waitForSelector(SELECTORS.panel, { state: 'visible', timeout: 3000 });
    const inviteHelp = (await page.textContent(SELECTORS.inviteHelp)).trim();
    await assert(browser, inviteHelp.includes('초대 만들기'), 'invite help did not explain creating an invite');
    await assert(browser, inviteHelp.includes('실행 명령 복사'), 'invite help did not explain command copy');
    await assert(browser, inviteHelp.includes('코딩 세션') && inviteHelp.includes('터미널'), 'invite help did not explain where to run the command');
    await assert(browser, inviteHelp.includes('관전 슬롯'), 'invite help did not explain spectator workflow');
    await assert(browser, await page.locator('#btn-agent-invite-copy').count() === 0, 'token-only copy button should not be rendered');
    const waitingPolicyVisible = await page.locator(`${SELECTORS.policyPanel}:visible`).count();
    await assert(browser, waitingPolicyVisible === 0, 'policy UI should not be visible in the waiting room');

    await clickCreateInvite(page);
    const firstCommand = await copyInviteCommand(page);
    const firstToken = tokenFromCommand(firstCommand);
    await assert(browser, firstToken.length >= 32, 'command copy did not include a valid invite token');
    await assertRedactedDisplay(browser, page, firstToken);
    const commandPreview = (await page.textContent(SELECTORS.command)).trim();
    await assert(browser, commandPreview.includes('CRAZAY_ARKADE_AGENT_TOKEN='), 'command preview did not show the agent env var');
    await assert(browser, commandPreview.includes('examples/llm-reply-agent.js'), 'command preview did not use the LLM reply agent');
    await assert(browser, !commandPreview.includes(firstToken), 'command preview exposed the raw token');
    await assertNoOverflow(browser, page, [SELECTORS.panel, SELECTORS.token, SELECTORS.command, SELECTORS.inviteHelp, SELECTORS.policyPanel]);
    await page.screenshot({ path: 'test/agent-visual-invite.png', fullPage: true });

    await page.click(SELECTORS.revoke);
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-testid="ai-invite-status"], #agent-invite-status');
      const token = document.querySelector('[data-testid="ai-invite-token"], #agent-invite-token');
      return (status && /revoke|revoked|취소|폐기/i.test(status.textContent)) || !token;
    });
    await page.screenshot({ path: 'test/agent-visual-revoked.png', fullPage: true });

    await clickCreateInvite(page);
    const secondCommand = await copyInviteCommand(page);
    const secondToken = tokenFromCommand(secondCommand);
    await assert(browser, secondToken !== firstToken, 'new invite reused the revoked token');
    agent = await connectAgent(secondToken);
    await page.waitForSelector(SELECTORS.marker, { state: 'visible', timeout: 4000 });
    await assertNoOverflow(browser, page, ['#player-list', SELECTORS.marker]);
    await page.screenshot({ path: 'test/agent-visual-agent.png', fullPage: true });

    await page.click('#btn-start');
    await page.waitForSelector('#screen-game.active', { timeout: 8000 });
    await page.waitForSelector(`${SELECTORS.policyPanel}:visible`, { timeout: 8000 });
    const beforePolicyUpdateLayout = await gameLayoutMetrics(page);
    await emitRuntimePolicy(agent);
    await page.waitForFunction(() => {
      const panel = document.querySelector('#agent-policy-panel');
      return panel && panel.textContent.includes('테스트 런타임 카드');
    }, { timeout: 3000 });
    const afterPolicyUpdateLayout = await gameLayoutMetrics(page);
    await assertStablePolicyUpdateLayout(browser, beforePolicyUpdateLayout, afterPolicyUpdateLayout);
    await page.click(`${SELECTORS.policyPanel} summary`);
    const policyText = (await page.textContent(SELECTORS.policyPanel)).trim();
    await assert(browser, policyText.includes('게임 중 생성'), 'policy UI did not label runtime generated policy');
    await assert(browser, policyText.includes('LLM reply'), 'policy UI did not show LLM reply decision mode');
    await assert(browser, policyText.includes('휴리스틱 item-value'), 'policy UI did not show selected heuristic');
    await assert(browser, policyText.includes('판단 틱 123'), 'policy UI did not show LLM reply decision tick');
    await assert(browser, policyText.includes('테스트 런타임 카드'), 'policy UI did not show runtime generated policy in game');
    await assert(browser, policyText.includes('테스트 안전 집행'), 'policy UI did not show runtime enforcement policy in game');
    const budgetText = (await page.textContent(SELECTORS.policyBudget)).trim();
    await assert(browser, budgetText.includes('runtime revision 7'), 'policy UI did not show runtime policy revision in game');
    await assert(browser, budgetText.includes('관측 틱 123'), 'policy UI did not show runtime policy observation tick in game');
    await assertNoOverflow(browser, page, [SELECTORS.policyPanel]);
    await page.screenshot({ path: 'test/agent-visual-policy-ingame.png', fullPage: true });

    if (errors.length) await fail(browser, `page errors:\n${errors.join('\n')}`);
    agent.close();
    await browser.close();
    console.log('PASS: agent invite UI screenshots saved');
    process.exit(0);
  } catch (err) {
    if (agent) agent.close();
    await fail(browser, err.message);
  }
})();
