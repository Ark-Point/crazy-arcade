#!/usr/bin/env node
'use strict';
// noqa: SIZE_OK - Standalone CLI example keeps arg parsing, socket lifecycle, and local reply provider in one runnable entrypoint.

const { io } = require('socket.io-client');
const { chooseAction, chooseActionForHeuristic, canSafelyPlaceBomb, buildDangerMap, constants, cellKey, playerCell } = require('../lib/agent/heuristics');
const { createActionPacer } = require('../lib/agent/action-pacer');
const { createLlmReplyController } = require('../lib/agent/llm-reply-controller');

function usage() {
  return [
    'Usage: CRAZAY_ARKADE_AGENT_TOKEN=<invite-token> node examples/llm-reply-agent.js --url <server>',
    '',
    'Environment:',
    '  CRAZAY_ARKADE_URL           Server URL, default http://localhost:3000',
    '  CRAZAY_ARKADE_AGENT_TOKEN   Agent invite token',
    '  CRAZAY_ARKADE_LLM_PROVIDER  openai or local, default local',
    '  CRAZAY_ARKADE_LLM_URL       OpenAI-compatible chat completions URL',
    '  CRAZAY_ARKADE_LLM_API_KEY   LLM API key for openai provider',
    '  CRAZAY_ARKADE_LLM_MODEL     LLM model for openai provider',
    '',
    'Options:',
    '  --url <server>              Base URL for the game server',
    '  --llm-provider <provider>   openai or local',
    '  --llm-url <url>             OpenAI-compatible chat completions URL',
    '  --llm-model <model>         LLM model name',
    '  --reply-delay-ms N          Local-provider reply delay, default 250',
    '  --max-actions N             Debug/test budget: exit after N accepted actions',
    '  --name <label>              Log label only',
    '  --help                      Show this help',
  ].join('\n');
}

function readArgs(argv) {
  const args = {
    url: process.env.CRAZAY_ARKADE_URL || 'http://localhost:3000',
    token: process.env.CRAZAY_ARKADE_AGENT_TOKEN || '',
    provider: process.env.CRAZAY_ARKADE_LLM_PROVIDER || 'local',
    llmUrl: process.env.CRAZAY_ARKADE_LLM_URL || '',
    llmApiKey: process.env.CRAZAY_ARKADE_LLM_API_KEY || '',
    llmModel: process.env.CRAZAY_ARKADE_LLM_MODEL || '',
    replyDelayMs: 250,
    maxActions: 0,
    name: 'llm-reply-agent',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--url') args.url = argv[++i] || '';
    else if (arg === '--llm-provider') args.provider = argv[++i] || '';
    else if (arg === '--llm-url') args.llmUrl = argv[++i] || '';
    else if (arg === '--llm-model') args.llmModel = argv[++i] || '';
    else if (arg === '--reply-delay-ms') args.replyDelayMs = Number(argv[++i] || 0);
    else if (arg === '--max-actions') args.maxActions = Number(argv[++i] || 0);
    else if (arg === '--name') args.name = argv[++i] || args.name;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.maxActions) || args.maxActions < 0) throw new Error('--max-actions must be a non-negative integer');
  if (!Number.isInteger(args.replyDelayMs) || args.replyDelayMs < 0) throw new Error('--reply-delay-ms must be a non-negative integer');
  if (!['local', 'openai'].includes(args.provider)) throw new Error('--llm-provider must be local or openai');
  if (args.provider === 'openai' && (!args.llmUrl || !args.llmApiKey || !args.llmModel)) {
    throw new Error('openai provider requires CRAZAY_ARKADE_LLM_URL, CRAZAY_ARKADE_LLM_API_KEY, and CRAZAY_ARKADE_LLM_MODEL');
  }
  return args;
}

function redactToken(token) {
  if (!token) return '<missing>';
  return `<redacted:${token.length}>`;
}

function actionName(action) {
  if (!action) return 'wait';
  if (action.type === 'move' && action.keys) {
    const key = ['up', 'down', 'left', 'right'].find((name) => action.keys[name]);
    return key ? `move:${key}` : 'move:none';
  }
  return action.type || 'unknown';
}

function statusLine(status) {
  if (!status || typeof status !== 'object') return 'status unavailable';
  const tick = Number.isFinite(status.tick) ? status.tick : '-';
  const countdown = Number.isFinite(status.countdown) ? status.countdown : '-';
  return `phase=${status.phase} canAct=${status.canAct ? 'yes' : 'no'} reason=${status.reason} next=${status.nextExpectedAction} tick=${tick} countdown=${countdown}`;
}

function statusKey(status) {
  if (!status || typeof status !== 'object') return 'missing';
  return [status.phase || 'unknown', status.canAct ? 'act' : 'hold', status.reason || 'no-reason'].join(':');
}

function localReplyProvider(delayMs) {
  let n = 0;
  return {
    async request(observation) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      n += 1;
      const heuristicId = localHeuristicId(observation);
      const tick = observation && observation.status ? observation.status.tick : null;
      return {
        id: `local-reply-${n}`,
        heuristicId,
        overview: 'local reply provider가 최신 관측을 받아 집행할 휴리스틱을 반환했습니다.',
        cards: [
          {
            id: 'llm-reply-local-heuristic',
            kind: 'create',
            priority: 2,
            title: 'LLM reply 휴리스틱 선택',
            summary: 'reply가 도착한 tick에서 집행할 휴리스틱을 고르고 executor가 실제 액션을 계산합니다.',
            signals: [`provider:local`, `tick:${tick === null ? 'unknown' : tick}`],
            actions: [`execute:${heuristicId}`],
          },
        ],
      };
    },
  };
}

function localHeuristicId(observation) {
  const status = observation && observation.status ? observation.status : {};
  const self = observation && observation.self ? observation.self : {};
  const state = observation && observation.state ? observation.state : {};
  if (self.trapped || status.reason === 'trapped_agent_can_use_escape_action') return 'survival-veto';
  if (hasUrgentSelfDanger(observation)) return 'survival-veto';
  if (Array.isArray(state.players) && state.players.some((player) => player && player.id !== self.id && player.alive !== false && player.trapped !== true)) {
    const action = chooseActionForHeuristic(observation, {}, 'pressure-trap');
    if (action.type === 'placeBomb') return 'pressure-trap';
  }
  if (canSafelyPlaceBomb(observation)) {
    const action = chooseAction(observation, {});
    if (action.type === 'placeBomb') return 'safe-bomb-farm';
  }
  if (Array.isArray(state.items) && state.items.length > 0) return 'item-value';
  if (Array.isArray(state.players) && state.players.some((player) => player && player.id !== self.id && player.alive !== false && player.trapped !== true)) return 'pressure-trap';
  return 'fallback-move';
}

function hasUrgentSelfDanger(observation) {
  if (!observation || !observation.self || !observation.state) return false;
  const selfCell = playerCell(observation.self, observation.state);
  if (!selfCell) return false;
  const danger = buildDangerMap(observation);
  const key = cellKey(selfCell.x, selfCell.y);
  const dangerAt = danger.dangerAt.get(key);
  return danger.lethalNow.has(key) || (Number.isFinite(dangerAt) && dangerAt <= constants.ESCAPE_URGENCY_TICKS);
}

function actionSchemaPrompt(observation) {
  const self = observation.self || {};
  const status = observation.status || {};
  return JSON.stringify({
    instruction: 'Return only JSON. Choose one bounded Crazay Arkade action for the freshest observation.',
    schema: {
      id: 'string reply id',
      overview: 'short Korean or English explanation',
      heuristicId: 'one of survival-veto, route-commit, item-value, safe-bomb-farm, pressure-trap, fallback-move',
      cards: '1-3 inspectable heuristic cards',
    },
    status: { tick: status.tick, reason: status.reason, allowedActions: status.allowedActions },
    self: {
      trapped: self.trapped,
      needles: self.needles,
      inventory: self.inventory,
      x: self.x,
      y: self.y,
      power: self.power,
      maxBombs: self.maxBombs,
    },
    visibleCounts: {
      bombs: Array.isArray(observation.state && observation.state.bombs) ? observation.state.bombs.length : 0,
      streams: Array.isArray(observation.state && observation.state.streams) ? observation.state.streams.length : 0,
      items: Array.isArray(observation.state && observation.state.items) ? observation.state.items.length : 0,
    },
  });
}

function openAiReplyProvider(args) {
  let n = 0;
  return {
    async request(observation) {
      n += 1;
      const response = await fetch(args.llmUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.llmApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: args.llmModel,
          messages: [
            { role: 'system', content: 'You are a bounded game agent. Return valid JSON only.' },
            { role: 'user', content: actionSchemaPrompt(observation) },
          ],
          temperature: 0.2,
        }),
      });
      if (!response.ok) throw new Error(`LLM request failed HTTP ${response.status}`);
      const payload = await response.json();
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
      const parsed = JSON.parse(content);
      if (!parsed.id) parsed.id = `openai-reply-${n}`;
      return parsed;
    },
  };
}

function makeReplyProvider(args) {
  if (args.provider === 'openai') return openAiReplyProvider(args);
  return localReplyProvider(args.replyDelayMs);
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.token) throw new Error('missing CRAZAY_ARKADE_AGENT_TOKEN');

  const socket = io(`${args.url.replace(/\/$/, '')}/agent`, {
    auth: { token: args.token },
    reconnection: false,
    timeout: 3000,
    forceNew: true,
  });
  const stats = { observations: 0, statuses: 0, replies: 0, actions: 0, errors: 0 };
  let lastStatusKey = '';
  let controller = null;

  const finish = (code) => {
    if (controller) controller.close();
    console.log(`[${args.name}] summary observations=${stats.observations} statuses=${stats.statuses} replies=${stats.replies} actions=${stats.actions} errors=${stats.errors}`);
    socket.close();
    process.exitCode = code;
    setTimeout(() => process.exit(code), 20).unref();
  };

  controller = createLlmReplyController({
    replyProvider: makeReplyProvider(args),
    pacer: createActionPacer(),
    onError(error) {
      stats.errors += 1;
      console.error(`[${args.name}] llmError ${error && error.message ? error.message : error}`);
    },
    onDecision({ action, policy, reply, observation }) {
      stats.replies += 1;
      socket.emit('agentPolicyUpdate', policy);
      socket.timeout(1000).emit('agentAction', action, (err, ack) => {
        if (err || !ack || ack.ok === false) {
          stats.errors += 1;
          if (ack && ack.status && controller) controller.observeStatus(ack.status);
          const status = ack && ack.status ? ` ${statusLine(ack.status)}` : '';
          console.error(`[${args.name}] actionError seq=${action.seq} ${err ? err.message : ack.error}${status}`);
          return;
        }
        stats.actions += 1;
        const plan = policy.sequencePlan && policy.sequencePlan.kind
          ? ` plan=${policy.sequencePlan.kind}/${policy.sequencePlan.objective || 'none'} remaining=${policy.sequencePlan.remainingMoves} horizon=${policy.sequencePlan.horizonTicks || 'na'} score=${policy.sequencePlan.score || 'na'}`
          : '';
        console.log(`[${args.name}] llmReply id=${policy.llmReplyId} heuristic=${policy.selectedHeuristicId}${plan} decisionTick=${policy.decisionTick} provider=${args.provider} type=${actionName(action)} seq=${ack.seq} observedTick=${observation.status.tick}`);
        if (args.maxActions > 0 && stats.actions >= args.maxActions) finish(0);
      });
      if (reply && reply.error) console.error(`[${args.name}] reply warning ${reply.error}`);
    },
  });

  socket.on('connect', () => {
    console.log(`[${args.name}] connected url=${args.url} token=${redactToken(args.token)} llmProvider=${args.provider}`);
  });
  socket.on('connect_error', (err) => {
    console.error(`[${args.name}] connect_error ${err.message}`);
    finish(1);
  });
  socket.on('agentReady', (payload) => {
    console.log(`[${args.name}] agentReady playerId=${payload.playerId} room=${payload.room && payload.room.id}`);
  });
  socket.on('agentStatus', (status) => {
    stats.statuses += 1;
    if (controller) controller.observeStatus(status);
    const key = statusKey(status);
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    console.log(`[${args.name}] serverStatus ${statusLine(status)}`);
  });
  socket.on('agentObservation', (observation) => {
    stats.observations += 1;
    controller.observe(observation);
  });
  socket.on('agentError', (message) => {
    stats.errors += 1;
    console.error(`[${args.name}] agentError ${message}`);
  });
  socket.on('disconnect', (reason) => {
    console.log(`[${args.name}] disconnected reason=${reason}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[llm-reply-agent] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  localHeuristicId,
  localReplyProvider,
};
