'use strict';

const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const SERVER_URL = process.argv[2] || process.env.URL || 'http://localhost:3000';
const sockets = [];

let child = null;
let serverChild = null;
let serverOutput = '';
let latestAgentPlayer = null;
let startPosition = null;
let sawAgentReady = false;
let sawAction = false;
let sawProgress = false;
let sawMovement = false;
let sawBomb = false;
let sawRuntimePolicy = false;
let runtimePolicyTitle = '';
let childOutput = '';
let inviteToken = '';

const cleanup = () => {
  if (child && !child.killed && child.exitCode === null) child.kill('SIGTERM');
  if (serverChild && !serverChild.killed && serverChild.exitCode === null) serverChild.kill('SIGTERM');
  while (sockets.length) sockets.pop().close();
};

const fail = (msg) => {
  console.error('FAIL:', msg);
  cleanup();
  process.exit(1);
};

const sanitizeOutput = (text) => {
  if (!inviteToken) return text;
  return String(text).split(inviteToken).join('<redacted-token>');
};

setTimeout(() => fail('test timed out'), 35000).unref();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForServer = async () => {
  for (let i = 0; i < 40; i++) {
    const socket = io(SERVER_URL, { reconnection: false, timeout: 500, forceNew: true });
    const connected = await new Promise((resolve) => {
      const done = () => {
        const wasConnected = socket.connected;
        socket.close();
        resolve(wasConnected);
      };
      socket.once('connect', done);
      socket.once('connect_error', () => {
        socket.close();
        resolve(false);
      });
      setTimeout(() => {
        socket.close();
        resolve(false);
      }, 650).unref();
    });
    if (connected) return;
    await delay(200);
  }
  throw new Error(`server did not become ready\n${serverOutput}`);
};

const startServerIfRequested = async () => {
  if (process.env.START_SERVER !== '1') return;
  const url = new global.URL(SERVER_URL);
  const port = process.env.PORT || url.port || '3000';
  serverChild = spawn('npm', ['start'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  serverChild.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  serverChild.once('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      serverOutput += `server exited code=${code} signal=${signal}\n`;
    }
  });
  await waitForServer();
  console.log(`server started on ${SERVER_URL}`);
};

const connectHuman = async () => {
  const socket = io(SERVER_URL, { reconnection: false, timeout: 2500, forceNew: true });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('human connect timed out')), 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`human connect error: ${err.message}`));
    });
  });
  return socket;
};

const waitForEvent = (socket, event, predicate, label, ms = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off(event, handler);
    reject(new Error(`${label} timed out waiting for ${event}`));
  }, ms);
  const handler = (payload) => {
    if (!predicate || predicate(payload)) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
  };
  socket.on(event, handler);
});

const emitWithAck = (socket, event, payload, ms = 2000) => new Promise((resolve, reject) => {
  socket.timeout(ms).emit(event, payload, (err, response) => {
    if (err) {
      reject(new Error(`${event} ack failed: ${err.message || err}`));
      return;
    }
    if (response && response.ok === false) {
      reject(new Error(`${event} rejected: ${response.error || 'unknown error'}`));
      return;
    }
    resolve(response && response.invite ? response.invite : response);
  });
});

const waitForChildExit = () => new Promise((resolve, reject) => {
  child.once('exit', (code, signal) => {
    if (code !== 0) {
      reject(new Error(`heuristic agent exited code=${code} signal=${signal}\n${sanitizeOutput(childOutput)}`));
      return;
    }
    resolve();
  });
});

(async () => {
  try {
    await startServerIfRequested();
    const host = await connectHuman();
    host.emit('setNick', 'HeuristicHost');
    host.emit('createRoom', 'heuristic live');
    const room = await waitForEvent(host, 'joinedRoom', (r) => r && r.id, 'room creation');
    const invite = await emitWithAck(host, 'createAgentInvite', { nick: 'HeuristicAI', char: 1 });
    inviteToken = invite.token;

    host.on('state', (state) => {
      if (!latestAgentPlayer) return;
      const agent = state.players.find((p) => p.id === latestAgentPlayer.id);
      if (!agent) return;
      if (!startPosition && state.countdown === 0) startPosition = { x: agent.x, y: agent.y };
      if (agent.seq > 0) sawProgress = true;
      if (startPosition && (Math.abs(agent.x - startPosition.x) > 0.1 || Math.abs(agent.y - startPosition.y) > 0.1)) {
        sawMovement = true;
      }
      if (Array.isArray(state.bombs) && state.bombs.length > 0) sawBomb = true;
    });
    host.on('agentPolicyUpdate', (policy) => {
      if (!policy || policy.schema !== 'crazay-arkade-agent-runtime-policy.v1') return;
      if (policy.decisionSource !== 'llm-reply') return;
      if (!Array.isArray(policy.cards)) return;
      const generated = policy.cards.find((card) => card && card.kind === 'create' && /^(runtime|llm-reply)-/.test(card.id || ''));
      if (!generated) return;
      sawRuntimePolicy = true;
      runtimePolicyTitle = generated.title || generated.id;
    });

    const roomWithAgentPromise = waitForEvent(
      host,
      'roomUpdate',
      (r) => r && r.players.some((p) => p.controller === 'agent'),
      'agent room update',
      5000
    );

    child = spawn(process.execPath, [
      'examples/llm-reply-agent.js',
      '--url',
      SERVER_URL,
      '--reply-delay-ms',
      '50',
      '--max-actions',
      '55',
      '--name',
      'live-llm-reply',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CRAZAY_ARKADE_AGENT_TOKEN: invite.token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      childOutput += text;
      if (text.includes('agentReady')) sawAgentReady = true;
      if (text.includes('llmReply id=')) sawAction = true;
    });
    child.stderr.on('data', (chunk) => {
      childOutput += chunk.toString();
    });

    const roomWithAgent = await roomWithAgentPromise;
    latestAgentPlayer = roomWithAgent.players.find((p) => p.controller === 'agent');
    if (!latestAgentPlayer) fail('room did not contain agent player');
    console.log(`created room ${room.id} with agent ${latestAgentPlayer.id}`);

    host.emit('startGame');
    await waitForChildExit();

    if (!sawAgentReady) fail(`bot did not log agentReady\n${sanitizeOutput(childOutput)}`);
    if (!sawAction) fail(`bot did not log LLM reply actions\n${sanitizeOutput(childOutput)}`);
    if (childOutput.includes(invite.token)) fail('bot output leaked the raw invite token');
    if (!sawProgress) fail('server state never showed agent seq progress');
    if (!sawMovement && !sawBomb) fail('server state never showed movement or bomb from agent');
    if (!sawRuntimePolicy) fail('server never relayed a runtime heuristic policy update from the agent');

    console.log(sanitizeOutput(childOutput).trim());
    console.log(`server observed: progress=${sawProgress} movement=${sawMovement} bomb=${sawBomb}`);
    console.log(`runtime policy observed: ${runtimePolicyTitle}`);
    console.log('PASS LLM reply live agent');
    cleanup();
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
})();
