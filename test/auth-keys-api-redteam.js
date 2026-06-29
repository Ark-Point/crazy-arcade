'use strict';

// keys-api 라우터 적대(red-team) 테스트.
// 목표: createKeysRouter 를 깨뜨리려는 공격/오용 시나리오로 보안·라이프사이클 계약을 검증한다.
// 가짜 requireSession(req.account 주입) + createStore(임시파일) + 가짜 liveSocketRegistry 주입.
// 실제 express 앱을 임의 포트로 listen 시키고 builtin fetch 로 검증한다. 제품 코드는 수정하지 않는다.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');

const { createStore, hashKey } = require('../server/auth/store');
const { createKeysRouter } = require('../server/auth/keys-api');
const session = require('../server/auth/session');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');

// 가짜 requireSession: 고정 accountId 로 req.account 를 채운다(세션 위조 시뮬레이션).
function fakeRequireSession(accountId) {
  return function (req, _res, next) {
    req.account = { id: accountId };
    next();
  };
}

// keyId -> [socket] 매핑 + disconnect 호출 기록. socketsForKey 동작을 주입 가능.
function makeRegistry(opts = {}) {
  const byKey = new Map();
  const calls = [];
  return {
    bind(keyId, socket) {
      if (!byKey.has(keyId)) byKey.set(keyId, []);
      byKey.get(keyId).push(socket);
    },
    calls,
    socketsForKey(keyId) {
      if (opts.throwOnLookup) throw new Error('레지스트리 조회 폭발(red-team)');
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
  return path.join(ARTIFACT_DIR, `keys-rt-${crypto.randomBytes(6).toString('hex')}.json`);
}

// (1) IDOR: 계정A 세션으로 계정B 키를 조회/폐기 시도 → 404·미노출, B 키 미폐기.
test('IDOR: 타 계정 키는 DELETE 404 + 미폐기 + GET 목록 미노출', async () => {
  const store = createStore(tmpStorePath());
  const victim = await store.upsertAccount({ provider: 'test', subject: 'victim' });
  const attacker = await store.upsertAccount({ provider: 'test', subject: 'attacker' });
  const vIssued = await store.issueKey(victim.id, 'victim-key');
  const vKeyId = vIssued.record.id;
  const vHash = hashKey(vIssued.key);

  const registry = makeRegistry();
  registry.bind(vKeyId, makeSocket(registry, 'victim-sock'));

  // 세션은 attacker. victim 의 키를 노린다.
  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(attacker.id), liveSocketRegistry: registry }),
  );
  try {
    // DELETE victim 키 → 404(존재 노출 금지).
    const del = await fetch(`${app.base}/account/keys/${vKeyId}`, { method: 'DELETE' });
    assert.equal(del.status, 404);
    const delBody = await del.json();
    assert.equal(delBody.ok, false);
    assert.equal(delBody.error, '키를 찾을 수 없습니다');

    // victim 키는 폐기되지 않았고 소켓도 끊기지 않았다.
    assert.equal(registry.calls.length, 0);
    assert.ok(store.findByKeyHash(vHash), 'victim 키는 여전히 유효해야 한다');
    const stillLive = store.listKeys(victim.id).some((k) => k.id === vKeyId && !k.revoked);
    assert.equal(stillLive, true);

    // GET 목록: attacker 에게 victim 키가 노출되지 않는다.
    const list = await fetch(`${app.base}/account/keys`);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.ok(!listBody.keys.some((k) => k.id === vKeyId), 'attacker 목록에 victim 키가 보이면 안 된다');
  } finally {
    await app.close();
  }
});

// (2) 폐기 라이브소켓 격리: 폐기 시 해당 keyId 소켓만 disconnect(true), 타 keyId 소켓은 유지.
test('폐기 소켓 격리: 대상 keyId 소켓만 disconnect(true), 다른 keyId 소켓 유지', async () => {
  const store = createStore(tmpStorePath());
  const account = await store.upsertAccount({ provider: 'test', subject: 's1' });
  const target = await store.issueKey(account.id, 'target');
  const keep = await store.issueKey(account.id, 'keep');
  const targetId = target.record.id;
  const keepId = keep.record.id;

  const registry = makeRegistry();
  registry.bind(targetId, makeSocket(registry, 'target-sock-1'));
  registry.bind(targetId, makeSocket(registry, 'target-sock-2'));
  registry.bind(keepId, makeSocket(registry, 'keep-sock-1'));

  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(account.id), liveSocketRegistry: registry }),
  );
  try {
    const res = await fetch(`${app.base}/account/keys/${targetId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.revoked, true);
    assert.equal(body.disconnected, 2);

    // target 소켓 2개만 force=true 로 종료, keep 소켓은 미종료.
    assert.equal(registry.calls.length, 2);
    const ids = registry.calls.map((c) => c.id).sort();
    assert.deepEqual(ids, ['target-sock-1', 'target-sock-2']);
    for (const c of registry.calls) assert.equal(c.force, true);
    assert.ok(!registry.calls.some((c) => c.id === 'keep-sock-1'), 'keep 소켓은 끊기면 안 된다');

    // keep 키는 여전히 유효.
    const keepHash = hashKey(keep.key);
    assert.ok(store.findByKeyHash(keepHash));
  } finally {
    await app.close();
  }
});

// (3) 이중 폐기 멱등 + 존재하지 않는 :id 폐기 404.
test('이중 폐기 멱등: 2회차 revoked=false, 없는 id 는 404', async () => {
  const store = createStore(tmpStorePath());
  const account = await store.upsertAccount({ provider: 'test', subject: 's1' });
  const issued = await store.issueKey(account.id, 'k');
  const keyId = issued.record.id;
  const hash = hashKey(issued.key);

  const registry = makeRegistry();

  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(account.id), liveSocketRegistry: registry }),
  );
  try {
    // 1회차: revoked true.
    const first = await fetch(`${app.base}/account/keys/${keyId}`, { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).revoked, true);
    assert.equal(store.findByKeyHash(hash), null);

    // 2회차: 여전히 소유 키이므로 404 아님, 그러나 이미 폐기 → revoked=false(멱등).
    const second = await fetch(`${app.base}/account/keys/${keyId}`, { method: 'DELETE' });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.revoked, false, '이미 폐기된 키 재폐기는 revoked=false');

    // 존재하지 않는 id → 404.
    const ghost = await fetch(`${app.base}/account/keys/key_doesnotexist_0000`, { method: 'DELETE' });
    assert.equal(ghost.status, 404);
    assert.equal((await ghost.json()).ok, false);
  } finally {
    await app.close();
  }
});

// (4) 내결함성: 레지스트리 없음 → 폐기 성공/HTTP 200. socketsForKey throw → store 폐기는 성립.
test('내결함성: registry 없음 폐기 200, socketsForKey throw 시 store 폐기는 유지', async () => {
  // 4a) liveSocketRegistry 미주입: 폐기 성공 + disconnected 0 + HTTP 200.
  {
    const store = createStore(tmpStorePath());
    const account = await store.upsertAccount({ provider: 'test', subject: 's1' });
    const issued = await store.issueKey(account.id, 'k');
    const keyId = issued.record.id;
    const hash = hashKey(issued.key);

    const app = await startApp(() =>
      createKeysRouter({ store, requireSession: fakeRequireSession(account.id) }),
    );
    try {
      const res = await fetch(`${app.base}/account/keys/${keyId}`, { method: 'DELETE' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.revoked, true);
      assert.equal(body.disconnected, 0);
      assert.equal(store.findByKeyHash(hash), null);
    } finally {
      await app.close();
    }
  }

  // 4b) socketsForKey 가 throw: store 폐기는 이미 반영됨(내구) 그리고 디스커넥트 단계가
  //     격리되어 종료 실패와 무관하게 HTTP 200(best-effort)으로 응답한다.
  {
    const store = createStore(tmpStorePath());
    const account = await store.upsertAccount({ provider: 'test', subject: 's1' });
    const issued = await store.issueKey(account.id, 'k');
    const keyId = issued.record.id;
    const hash = hashKey(issued.key);

    const registry = makeRegistry({ throwOnLookup: true });

    const app = await startApp(() =>
      createKeysRouter({ store, requireSession: fakeRequireSession(account.id), liveSocketRegistry: registry }),
    );
    try {
      const res = await fetch(`${app.base}/account/keys/${keyId}`, { method: 'DELETE' });
      // 핵심 계약: store 수준 폐기는 throw 와 무관하게 성립해야 한다(데이터 무결성).
      assert.equal(store.findByKeyHash(hash), null, 'throw 와 무관하게 store 폐기는 성립해야 한다');
      const rec = store.listKeys(account.id).find((k) => k.id === keyId);
      assert.equal(rec.revoked, true);
      // 디스커넥트 예외는 격리되어 폐기 결과에 영향 없음 → 200, disconnected=0.
      assert.equal(res.status, 200, '디스커넥트 throw 격리 → HTTP 200(best-effort)');
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.revoked, true);
      assert.equal(body.disconnected, 0, 'throw 한 레지스트리는 종료 0');
    } finally {
      await app.close();
    }
  }
});

// (5) POST label 오용: 객체/초장문/누락 모두 방어적으로 처리(201 + 정상 record).
test('POST label 오용 방어: 객체/초장문/누락', async () => {
  const store = createStore(tmpStorePath());
  const account = await store.upsertAccount({ provider: 'test', subject: 's1' });

  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: fakeRequireSession(account.id) }),
  );
  try {
    async function post(payload) {
      const res = await fetch(`${app.base}/account/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res;
    }

    // 5a) label 이 객체 → 문자열 아님 → 기본 라벨로 폴백.
    const objRes = await post({ label: { evil: true } });
    assert.equal(objRes.status, 201);
    const objBody = await objRes.json();
    assert.equal(objBody.ok, true);
    assert.equal(objBody.record.label, 'agent key');
    assert.equal(typeof objBody.key, 'string');

    // 5b) 초장문 label(1000자) → 64자로 절단.
    const longLabel = 'A'.repeat(1000);
    const longRes = await post({ label: longLabel });
    assert.equal(longRes.status, 201);
    const longBody = await longRes.json();
    assert.equal(longBody.record.label.length, 64);

    // 5c) label 누락 → 기본 라벨.
    const noneRes = await post({});
    assert.equal(noneRes.status, 201);
    const noneBody = await noneRes.json();
    assert.equal(noneBody.record.label, 'agent key');

    // 평문은 record(공개 뷰)에 해시로 노출되지 않는다.
    for (const b of [objBody, longBody, noneBody]) {
      assert.equal(b.record.keyHash, undefined);
    }
  } finally {
    await app.close();
  }
});

// (6) 세션 없으면 GET/POST/DELETE 모두 401(실제 session 미들웨어).
test('세션 없음: GET/POST/DELETE 전부 401', async () => {
  const store = createStore(tmpStorePath());
  const secret = 'redteam-secret-1234567890';

  const app = await startApp(() =>
    createKeysRouter({ store, requireSession: session.requireSession(secret) }),
  );
  try {
    const get = await fetch(`${app.base}/account/keys`);
    assert.equal(get.status, 401);
    assert.equal((await get.json()).ok, false);

    const post = await fetch(`${app.base}/account/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    assert.equal(post.status, 401);
    assert.equal((await post.json()).ok, false);

    const del = await fetch(`${app.base}/account/keys/key_whatever`, { method: 'DELETE' });
    assert.equal(del.status, 401);
    assert.equal((await del.json()).ok, false);

    // 위조 쿠키(잘못된 서명)도 401.
    const forged = await fetch(`${app.base}/account/keys`, {
      headers: { cookie: `${session.SESSION_COOKIE}=not.a.valid.token` },
    });
    assert.equal(forged.status, 401);
  } finally {
    await app.close();
  }
});
