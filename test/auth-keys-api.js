'use strict';

// keys-api 라우터 통합 테스트.
// 가짜 requireSession(req.account 주입) + createStore(임시파일) + 가짜 liveSocketRegistry.
// 실제 express 앱을 임의 포트로 listen 시키고 builtin fetch 로 검증한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');

const { createStore } = require('../server/auth/store');
const { createKeysRouter } = require('../server/auth/keys-api');
const session = require('../server/auth/session');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');

// 가짜 requireSession: accountId 를 고정해 req.account 를 채운다.
function fakeRequireSession(accountId) {
  return function (req, _res, next) {
    req.account = { id: accountId };
    next();
  };
}

// 가짜 라이브 소켓 레지스트리: keyId -> [socket]. disconnect 호출을 기록한다.
function makeRegistry() {
  const byKey = new Map();
  const calls = [];
  return {
    bind(keyId, socket) {
      if (!byKey.has(keyId)) byKey.set(keyId, []);
      byKey.get(keyId).push(socket);
    },
    calls,
    socketsForKey(keyId) {
      return byKey.get(keyId) || [];
    },
  };
}

function makeSocket(registry, id) {
  return {
    id,
    disconnect(force) {
      registry.calls.push({ id, force });
    },
  };
}

// 라우터를 마운트한 앱을 임의 포트로 띄운다.
function startApp(buildRouter) {
  const app = express();
  app.use(buildRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function tmpStorePath() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return path.join(ARTIFACT_DIR, `keys-${crypto.randomBytes(6).toString('hex')}.json`);
}

test('POST 발급: 평문 key 1회 + 201', async () => {
  const store = createStore(tmpStorePath());
  const account = store.upsertAccount ? await store.upsertAccount({ provider: 'test', subject: 's1' }) : null;
  const registry = makeRegistry();
  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(account.id), liveSocketRegistry: registry }),
  );
  try {
    const res = await fetch(`${app.base}/account/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'my agent' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.key, 'string');
    assert.ok(body.key.length > 0);
    assert.equal(body.record.label, 'my agent');
    // 평문은 record(공개 뷰)에 들어가지 않는다.
    assert.equal(body.record.keyHash, undefined);
    assert.ok(body.record.keyPrefix);
  } finally {
    await app.close();
  }
});

test('GET 목록: keyHash 미노출', async () => {
  const store = createStore(tmpStorePath());
  const account = await store.upsertAccount({ provider: 'test', subject: 's1' });
  await store.issueKey(account.id, 'k1');
  await store.issueKey(account.id, 'k2');
  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(account.id) }),
  );
  try {
    const res = await fetch(`${app.base}/account/keys`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.keys.length, 2);
    for (const k of body.keys) {
      assert.equal(k.keyHash, undefined);
      assert.ok(k.id);
    }
  } finally {
    await app.close();
  }
});

test('DELETE 자기키: revoked true + 라이브 소켓 disconnect(true) + findByKeyHash null', async () => {
  const store = createStore(tmpStorePath());
  const account = await store.upsertAccount({ provider: 'test', subject: 's1' });
  const issued = await store.issueKey(account.id, 'k1');
  const keyId = issued.record.id;
  const keyHash = require('../server/auth/store').hashKey(issued.key);

  // 폐기 전에는 해시 룩업이 살아있다.
  assert.ok(store.findByKeyHash(keyHash));

  const registry = makeRegistry();
  registry.bind(keyId, makeSocket(registry, 'sock-a'));
  registry.bind(keyId, makeSocket(registry, 'sock-b'));

  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(account.id), liveSocketRegistry: registry }),
  );
  try {
    const res = await fetch(`${app.base}/account/keys/${keyId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.revoked, true);
    assert.equal(body.disconnected, 2);
    // 두 소켓 모두 force=true 로 종료되었다.
    assert.equal(registry.calls.length, 2);
    for (const c of registry.calls) assert.equal(c.force, true);
    // 폐기 후 해시 룩업은 null.
    assert.equal(store.findByKeyHash(keyHash), null);
  } finally {
    await app.close();
  }
});

test('DELETE 타인키: 404', async () => {
  const store = createStore(tmpStorePath());
  const owner = await store.upsertAccount({ provider: 'test', subject: 'owner' });
  const other = await store.upsertAccount({ provider: 'test', subject: 'other' });
  const issued = await store.issueKey(owner.id, 'k1');
  const keyId = issued.record.id;

  const registry = makeRegistry();
  registry.bind(keyId, makeSocket(registry, 'sock-x'));

  // 세션은 other 계정으로. owner 의 키를 폐기 시도.
  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(other.id), liveSocketRegistry: registry }),
  );
  try {
    const res = await fetch(`${app.base}/account/keys/${keyId}`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, '키를 찾을 수 없습니다');
    // 타인 키는 폐기/종료되지 않는다.
    assert.equal(registry.calls.length, 0);
    const stillOwned = store.listKeys(owner.id).some((k) => k.id === keyId && !k.revoked);
    assert.equal(stillOwned, true);
  } finally {
    await app.close();
  }
});

test('requireSession 없으면 401 (실제 session 미들웨어)', async () => {
  const store = createStore(tmpStorePath());
  const secret = 'test-secret-1234567890';
  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: session.requireSession(secret) }),
  );
  try {
    // 쿠키 없음 -> 401.
    const res = await fetch(`${app.base}/account/keys`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);

    // 유효한 세션 토큰을 쿠키로 주면 통과(200).
    const account = await store.upsertAccount({ provider: 'test', subject: 's1' });
    const token = session.createSessionToken({ id: account.id }, secret);
    const ok = await fetch(`${app.base}/account/keys`, {
      headers: { cookie: `${session.SESSION_COOKIE}=${token}` },
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
  } finally {
    await app.close();
  }
});
