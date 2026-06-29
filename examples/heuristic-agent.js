#!/usr/bin/env node
'use strict';

const { io } = require('socket.io-client');
const { createHeuristicAgent } = require('../lib/agent/heuristics');
const { createActionPacer } = require('../lib/agent/action-pacer');

function usage() {
  return [
    'Usage: CRAZAY_ARKADE_AGENT_TOKEN=<invite-token> node examples/heuristic-agent.js --url <server> [--max-actions N]',
    '   or: CRAZAY_ARKADE_API_KEY=<api-key> node examples/heuristic-agent.js --url <server> [--max-actions N]',
    '',
    'Environment:',
    '  CRAZAY_ARKADE_URL           Server URL, default http://localhost:3000',
    '  CRAZAY_ARKADE_AGENT_TOKEN   Agent invite token (token mode, auto-joins a room)',
    '  CRAZAY_ARKADE_API_KEY       BYO agent API key (apiKey mode, creates+starts its own room)',
    '',
    'Options:',
    '  --url <server>             Base URL for the game server',
    '  --max-actions N            Debug/test budget: exit after N emitted agentAction calls; not a server policy',
    '  --reaction-ticks N         Minimum ticks between decisions, default 6 (~200ms)',
    '  --trap-reaction-ticks N    Minimum ticks before trapped recovery, default 9 (~300ms)',
    '  --name <label>             Log label only, never sent to the server',
    '  --help                     Show this help',
  ].join('\n');
}

function readArgs(argv) {
  const args = {
    url: process.env.CRAZAY_ARKADE_URL || 'http://localhost:3000',
    token: process.env.CRAZAY_ARKADE_AGENT_TOKEN || '',
    apiKey: process.env.CRAZAY_ARKADE_API_KEY || '',
    maxActions: 0,
    reactionTicks: 6,
    trapReactionTicks: 9,
    name: 'heuristic-agent',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--url') {
      args.url = argv[++i] || '';
    } else if (arg === '--max-actions') {
      args.maxActions = Number(argv[++i] || 0);
    } else if (arg === '--reaction-ticks') {
      args.reactionTicks = Number(argv[++i] || 0);
    } else if (arg === '--trap-reaction-ticks') {
      args.trapReactionTicks = Number(argv[++i] || 0);
    } else if (arg === '--name') {
      args.name = argv[++i] || args.name;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.maxActions) || args.maxActions < 0) {
    throw new Error('--max-actions must be a non-negative integer');
  }
  if (!Number.isInteger(args.reactionTicks) || args.reactionTicks <= 0) {
    throw new Error('--reaction-ticks must be a positive integer');
  }
  if (!Number.isInteger(args.trapReactionTicks) || args.trapReactionTicks <= 0) {
    throw new Error('--trap-reaction-ticks must be a positive integer');
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

function statusKey(status) {
  if (!status || typeof status !== 'object') return 'missing';
  return [
    status.phase || 'unknown',
    status.canAct ? 'act' : 'hold',
    status.reason || 'no-reason',
    status.nextExpectedAction || 'no-next',
  ].join(':');
}

function statusLine(status) {
  if (!status || typeof status !== 'object') return 'status unavailable';
  const tick = Number.isFinite(status.tick) ? status.tick : '-';
  const countdown = Number.isFinite(status.countdown) ? status.countdown : '-';
  return `phase=${status.phase} canAct=${status.canAct ? 'yes' : 'no'} reason=${status.reason} next=${status.nextExpectedAction} tick=${tick} countdown=${countdown}`;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  // 인증 모드: apiKey 우선(설정 시 로비 흐름), 없으면 기존 invite token 경로.
  const useApiKey = !!args.apiKey;
  if (!useApiKey && !args.token) {
    throw new Error('missing CRAZAY_ARKADE_API_KEY or CRAZAY_ARKADE_AGENT_TOKEN');
  }

  const agent = createHeuristicAgent();
  const pacer = createActionPacer({
    decisionTicks: args.reactionTicks,
    trapReactionTicks: args.trapReactionTicks,
  });
  const socket = io(`${args.url.replace(/\/$/, '')}/agent`, {
    auth: useApiKey ? { apiKey: args.apiKey } : { token: args.token },
    reconnection: false,
    timeout: 3000,
    forceNew: true,
  });
  const stats = {
    observations: 0,
    actions: 0,
    moves: 0,
    bombs: 0,
    errors: 0,
    statuses: 0,
  };
  let lastPolicyRevision = -1;
  let lastStatusKey = '';

  const finish = (code) => {
    console.log(`[${args.name}] summary observations=${stats.observations} statuses=${stats.statuses} actions=${stats.actions} moves=${stats.moves} bombs=${stats.bombs} errors=${stats.errors}`);
    socket.close();
    process.exitCode = code;
    setTimeout(() => process.exit(code), 20).unref();
  };

  socket.on('connect', () => {
    const cred = useApiKey ? `apiKey=${redactToken(args.apiKey)}` : `token=${redactToken(args.token)}`;
    console.log(`[${args.name}] connected url=${args.url} ${cred}`);
  });
  // apiKey 모드: 인증 직후 방 생성→게임 시작으로 관측 스트림을 연다(token 모드는 자동 입장).
  if (useApiKey) {
    socket.on('agentAuthenticated', (auth) => {
      console.log(`[${args.name}] authenticated mode=${auth && auth.mode} keyId=${auth && auth.keyId}`);
      socket.timeout(2000).emit('createRoom', { name: args.name, nick: args.name }, (cErr, cAck) => {
        if (cErr || !cAck || cAck.ok === false) {
          stats.errors += 1;
          console.error(`[${args.name}] createRoom failed ${cErr ? cErr.message : cAck && cAck.error}`);
          finish(1);
          return;
        }
        socket.timeout(2000).emit('startGame', (sErr, sAck) => {
          if (sErr || !sAck || sAck.ok === false) {
            stats.errors += 1;
            console.error(`[${args.name}] startGame failed ${sErr ? sErr.message : sAck && sAck.error}`);
            finish(1);
          }
        });
      });
    });
  }
  socket.on('connect_error', (err) => {
    console.error(`[${args.name}] connect_error ${err.message}`);
    finish(1);
  });
  socket.on('agentReady', (payload) => {
    console.log(`[${args.name}] agentReady playerId=${payload.playerId} room=${payload.room && payload.room.id}`);
  });
  socket.on('agentStatus', (status) => {
    stats.statuses += 1;
    const key = statusKey(status);
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    console.log(`[${args.name}] serverStatus ${statusLine(status)}`);
  });
  socket.on('agentError', (message) => {
    stats.errors += 1;
    console.error(`[${args.name}] agentError ${message}`);
  });
  socket.on('agentObservation', (observation) => {
    stats.observations += 1;
    if (observation && observation.status && observation.status.canAct === false) return;
    if (!observation || !observation.status) {
      console.error(`[${args.name}] missing server status in observation`);
      stats.errors += 1;
      return;
    }
    const desiredAction = agent.chooseAction(observation);
    const pacedAction = pacer.nextAction(observation, desiredAction);
    if (!pacedAction) return;
    const action = agent.actionWithSeq(pacedAction);
    const policy = agent.policySnapshot();
    if (policy.revision !== lastPolicyRevision && policy.cards.length) {
      lastPolicyRevision = policy.revision;
      socket.emit('agentPolicyUpdate', policy);
    }
    socket.timeout(1000).emit('agentAction', action, (err, ack) => {
      if (err || !ack || ack.ok === false) {
        stats.errors += 1;
        const status = ack && ack.status ? ` ${statusLine(ack.status)}` : '';
        console.error(`[${args.name}] actionError seq=${action.seq} ${err ? err.message : ack.error}${status}`);
        return;
      }
      stats.actions += 1;
      if (action.type === 'move') stats.moves += 1;
      if (action.type === 'placeBomb') stats.bombs += 1;
      console.log(`[${args.name}] action seq=${ack.seq} tick=${observation.status.tick} type=${actionName(action)}`);
      if (args.maxActions > 0 && stats.actions >= args.maxActions) finish(0);
    });
  });
  socket.on('disconnect', (reason) => {
    console.log(`[${args.name}] disconnected reason=${reason}`);
  });
}

main().catch((err) => {
  console.error(`[heuristic-agent] ${err.message}`);
  process.exit(1);
});
