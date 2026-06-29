'use strict';

// S1 단위테스트 — server/auth/store.js (JsonStore).
// 검증: 키 평문 미저장(해시만)·발급 1회 평문·findByKeyHash·폐기 차단·
//       인메모리 인덱스 재로드 일관성·폐기 fsync 영속. 서버 스폰 없음(순수 모듈).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { JsonStore, createStore, hashKey } = require('../server/auth/store');

function tmpStorePath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'byo-store-')),
    'store.json',
  );
}

test('issueKey 는 평문을 1회 반환하고 평문을 저장하지 않는다', async () => {
  const p = tmpStorePath();
  const store = createStore(p);
  const acc = await store.upsertAccount({ provider: 'github', subject: 'u1' });
  const { key, record } = await store.issueKey(acc.id, 'my key');

  assert.ok(typeof key === 'string' && key.length >= 40, '평문 키가 반환되어야 함');
  assert.equal(record.label, 'my key');
  assert.equal(record.revoked, false);
  assert.ok(!('keyHash' in record), '공개 뷰에 keyHash 노출 금지');

  const onDisk = fs.readFileSync(p, 'utf8');
  assert.ok(!onDisk.includes(key), '디스크에 평문 키가 저장되면 안 됨');
  assert.ok(onDisk.includes(hashKey(key)), '디스크에는 sha256 해시가 있어야 함');
});

test('findByKeyHash 는 해시로 레코드를 찾고 틀린 해시엔 null', async () => {
  const store = createStore(tmpStorePath());
  const acc = await store.upsertAccount({ provider: 'google', subject: 'g1' });
  const { key } = await store.issueKey(acc.id, 'k');

  const found = store.findByKeyHash(hashKey(key));
  assert.ok(found, '유효 해시로 레코드를 찾아야 함');
  assert.equal(found.accountId, acc.id);

  assert.equal(store.findByKeyHash(hashKey('wrong-key')), null, '틀린 해시는 null');
});

test('revokeKey 후 findByKeyHash 는 null, listKeys 는 revoked=true', async () => {
  const store = createStore(tmpStorePath());
  const acc = await store.upsertAccount({ provider: 'github', subject: 'u2' });
  const { key, record } = await store.issueKey(acc.id, 'k');

  assert.equal(await store.revokeKey(record.id), true);
  assert.equal(store.findByKeyHash(hashKey(key)), null, '폐기 후 룩업 차단');
  assert.equal(await store.revokeKey(record.id), false, '이중 폐기는 false');

  const keys = store.listKeys(acc.id);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].revoked, true);
});

test('해시는 단방향: 저장 해시로 평문 역산 불가(해시≠평문)', async () => {
  const store = createStore(tmpStorePath());
  const acc = await store.upsertAccount({ provider: 'github', subject: 'u3' });
  const { key } = await store.issueKey(acc.id, 'k');
  const h = hashKey(key);
  assert.notEqual(h, key);
  assert.equal(h.length, 64, 'sha256 hex 64자');
  assert.equal(hashKey(key), h, '동일 입력 동일 해시(결정적)');
});

test('upsertAccount 는 동일 provider+subject 에 멱등', async () => {
  const store = createStore(tmpStorePath());
  const a = await store.upsertAccount({ provider: 'github', subject: 'same' });
  const b = await store.upsertAccount({ provider: 'github', subject: 'same' });
  assert.equal(a.id, b.id, '같은 주체는 같은 계정 id');
});

test('재로드 시 인메모리 인덱스 일관성(영속+폐기 반영)', async () => {
  const p = tmpStorePath();
  const s1 = createStore(p);
  const acc = await s1.upsertAccount({ provider: 'google', subject: 'persist' });
  const live = await s1.issueKey(acc.id, 'live');
  const dead = await s1.issueKey(acc.id, 'dead');
  await s1.revokeKey(dead.record.id);

  // 동일 파일로 새 인스턴스 로드 → 영속 상태 재구성.
  const s2 = createStore(p);
  assert.ok(s2.findByKeyHash(hashKey(live.key)), '유효 키는 재로드 후에도 룩업됨');
  assert.equal(s2.findByKeyHash(hashKey(dead.key)), null, '폐기 키는 재로드 후에도 차단');
  assert.equal(s2.listKeys(acc.id).length, 2, '계정 키 2개 모두 보존');
});

test('동시 issueKey 직렬화: 모든 키가 고유하게 영속', async () => {
  const store = createStore(tmpStorePath());
  const acc = await store.upsertAccount({ provider: 'github', subject: 'concurrent' });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.issueKey(acc.id, `k${i}`)),
  );
  const ids = new Set(results.map((r) => r.record.id));
  assert.equal(ids.size, 8, '8개 키 id 가 모두 고유');
  assert.equal(store.listKeys(acc.id).length, 8, '8개 모두 영속');
  for (const r of results) {
    assert.ok(store.findByKeyHash(hashKey(r.key)), '각 키가 룩업 가능');
  }
});

test('구조 손상(비배열 accounts/keys)·미지원 버전 로드는 친절 에러로 거부', async () => {
  const bad1 = tmpStorePath();
  fs.writeFileSync(bad1, JSON.stringify({ version: 1, accounts: null, keys: [] }));
  assert.throws(() => createStore(bad1), /손상/, '비배열 accounts 거부');

  const bad2 = tmpStorePath();
  fs.writeFileSync(bad2, JSON.stringify([1, 2, 3]));
  assert.throws(() => createStore(bad2), /손상/, '최상위 배열 거부');

  const bad3 = tmpStorePath();
  fs.writeFileSync(bad3, JSON.stringify({ version: 999, accounts: [], keys: [] }));
  assert.throws(() => createStore(bad3), /버전/, '미지원 버전 거부');

  const bad4 = tmpStorePath();
  fs.writeFileSync(bad4, 'not json at all');
  assert.throws(() => createStore(bad4), /손상/, '비JSON 거부');
});
