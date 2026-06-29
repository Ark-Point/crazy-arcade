'use strict';

// S1 레드팀(적대) 테스트 — server/auth/store.js (JsonStore).
// 해피패스가 아니라 "깨뜨리기": 손상 입력·계약 위반 호출·평문 누설·경합·메타문자.
// 제품 코드는 수정하지 않는다. 순수 모듈 테스트(서버 스폰 없음).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JsonStore, createStore, hashKey } = require('../server/auth/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'byo-redteam-'));
}
function tmpStorePath() {
  return path.join(tmpDir(), 'store.json');
}

// (1) 손상 JSON 파일 로드 시 명확한 에러(조용한 크래시/무시 아님).
test('적대1: 손상 JSON 로드 시 명확한 에러를 throw(조용히 삼키지 않음)', () => {
  const p = tmpStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ this is : not valid json ]]', 'utf8');

  assert.throws(
    () => createStore(p),
    (err) =>
      err instanceof Error && /손상되었습니다/.test(err.message) && err.message.includes(p),
    '손상 파일은 명확한 메시지로 throw 해야 함',
  );

  // 완전히 깨진 변형들도 동일하게 throw.
  for (const garbage of ['', '   ', 'null\n}', '{"accounts":', '\u0000\u0001\u0002']) {
    const p2 = tmpStorePath();
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    fs.writeFileSync(p2, garbage, 'utf8');
    assert.throws(() => createStore(p2), Error, `garbage=${JSON.stringify(garbage)} 도 throw`);
  }
});

// (2) 존재하지 않는 계정으로 issueKey 호출 시 throw.
test('적대2: 알 수 없는 계정으로 issueKey 시 throw', () => {
  const store = createStore(tmpStorePath());
  assert.throws(
    () => store.issueKey('acc_does_not_exist', 'x'),
    /알 수 없는 계정/,
    '없는 계정 발급은 throw',
  );
  // null/undefined/숫자 계정 id 도 모두 거부.
  for (const bad of [null, undefined, '', 0, 12345, {}, []]) {
    assert.throws(() => store.issueKey(bad, 'x'), Error, `accountId=${JSON.stringify(bad)} 거부`);
  }
  // 부작용 없음: 아무 키도 영속되지 않음.
  assert.equal(store.keysById.size, 0, '실패한 발급은 키를 만들지 않음');
});

// (3) 폐기된 키 해시 룩업 null + 이중/삼중 폐기 false.
test('적대3: 폐기 키 해시 룩업 null, 이중 폐기 false, 없는 키 폐기 false', async () => {
  const store = createStore(tmpStorePath());
  const acc = await store.upsertAccount({ provider: 'github', subject: 'rt3' });
  const { key, record } = await store.issueKey(acc.id, 'k');

  assert.ok(store.findByKeyHash(hashKey(key)), '폐기 전엔 룩업됨');
  assert.equal(await store.revokeKey(record.id), true, '최초 폐기 true');
  assert.equal(store.findByKeyHash(hashKey(key)), null, '폐기 후 해시 룩업 null');
  assert.equal(await store.revokeKey(record.id), false, '이중 폐기 false');
  assert.equal(await store.revokeKey(record.id), false, '삼중 폐기도 false');
  assert.equal(await store.revokeKey('key_nonexistent'), false, '없는 키 폐기 false');
  assert.equal(await store.revokeKey(undefined), false, 'undefined 폐기 false');

  // 재로드 후에도 폐기 상태가 유지되고 인덱스에서 빠져 있어야 함.
  const reloaded = new JsonStore(store.filePath);
  reloaded.load();
  assert.equal(reloaded.findByKeyHash(hashKey(key)), null, '재로드 후에도 폐기 룩업 차단');
  assert.equal(reloaded.keyHashIndex.has(record.keyHash ?? hashKey(key)), false);
});

// (4) 대량 발급 후 디스크에 어느 평문 키도 존재하지 않음(전수 검사).
test('적대4: 대량 발급 후 디스크에 평문 키 0개(전수 스캔) + 해시는 존재', async () => {
  const p = tmpStorePath();
  const store = createStore(p);
  const acc = await store.upsertAccount({ provider: 'google', subject: 'rt4' });

  const N = 50;
  const plaintexts = [];
  for (let i = 0; i < N; i += 1) {
    const { key } = await store.issueKey(acc.id, `bulk-${i}`);
    plaintexts.push(key);
  }

  const onDisk = fs.readFileSync(p, 'utf8');
  for (const pt of plaintexts) {
    assert.equal(onDisk.includes(pt), false, `평문 키가 디스크에 누설됨: ${pt.slice(0, 8)}…`);
    assert.equal(onDisk.includes(hashKey(pt)), true, '해당 키의 sha256 해시는 디스크에 존재해야 함');
  }
  // 파싱된 레코드에도 평문 필드가 없어야 함.
  const parsed = JSON.parse(onDisk);
  for (const rec of parsed.keys) {
    assert.ok(!('key' in rec) && !('plaintext' in rec), '레코드에 평문 필드 금지');
    assert.equal(typeof rec.keyHash, 'string');
  }
  assert.equal(parsed.keys.length, N, '발급 수만큼 영속');
});

// (5) 동시 revoke/issue 경합 후 인메모리 인덱스와 재로드 상태 일치.
test('적대5: 동시 revoke/issue 경합 후 인메모리 인덱스 == 재로드 상태', async () => {
  const p = tmpStorePath();
  const store = createStore(p);
  const acc = await store.upsertAccount({ provider: 'github', subject: 'rt5' });

  // 선발급 키들(이 중 일부를 경합 중 폐기).
  const seed = [];
  for (let i = 0; i < 10; i += 1) {
    seed.push(await store.issueKey(acc.id, `seed-${i}`));
  }

  // 발급과 폐기를 인터리브하여 동시에 던진다(직렬화 뮤텍스 스트레스).
  const ops = [];
  for (let i = 0; i < 10; i += 1) {
    ops.push(store.issueKey(acc.id, `race-${i}`));
    ops.push(store.revokeKey(seed[i].record.id));
  }
  const settled = await Promise.allSettled(ops);
  assert.ok(settled.every((s) => s.status === 'fulfilled'), '경합 작업이 모두 정상 종료');

  // 인메모리 진실 소스 스냅샷.
  const liveHashesMem = new Set([...store.keyHashIndex.keys()]);
  const allIdsMem = new Set([...store.keysById.keys()]);
  const revokedMem = new Set(
    [...store.keysById.values()].filter((r) => r.revoked).map((r) => r.id),
  );

  // 동일 파일을 새 인스턴스로 재로드 → 디스크 진실과 비교.
  const fresh = new JsonStore(p);
  fresh.load();
  const liveHashesDisk = new Set([...fresh.keyHashIndex.keys()]);
  const allIdsDisk = new Set([...fresh.keysById.keys()]);
  const revokedDisk = new Set(
    [...fresh.keysById.values()].filter((r) => r.revoked).map((r) => r.id),
  );

  assert.deepEqual([...allIdsMem].sort(), [...allIdsDisk].sort(), '전체 키 id 집합 일치');
  assert.deepEqual([...liveHashesMem].sort(), [...liveHashesDisk].sort(), '활성 해시 인덱스 일치');
  assert.deepEqual([...revokedMem].sort(), [...revokedDisk].sort(), '폐기 키 집합 일치');

  // 폐기된 키는 어느 쪽에서도 룩업되면 안 되고, 활성 키는 양쪽에서 룩업돼야 함.
  for (const r of seed) {
    assert.equal(store.findByKeyHash(r.record.keyHash ?? hashKey(r.key)), null, '폐기 seed 룩업 null(mem)');
    assert.equal(fresh.findByKeyHash(hashKey(r.key)), null, '폐기 seed 룩업 null(disk)');
  }
  // 폐기 10 + 활성(seed 0개 잔존) → 활성 해시 수는 race 발급 10개와 일치.
  assert.equal(liveHashesMem.size, 10, '활성 해시는 race 발급 10개');
  assert.equal(allIdsMem.size, 20, '총 키 20개(seed10 + race10)');
});

// (6) findByKeyHash 에 임의 메타문자/빈문자열/undefined/타입 오용 입력 시 null.
test('적대6: findByKeyHash 악성/엣지 입력은 전부 null', async () => {
  const store = createStore(tmpStorePath());
  const acc = await store.upsertAccount({ provider: 'github', subject: 'rt6' });
  await store.issueKey(acc.id, 'k'); // 인덱스에 항목이 있어도 잘못된 입력은 null 이어야 함

  const evil = [
    undefined,
    null,
    '',
    ' ',
    '\u0000',
    '../../etc/passwd',
    '__proto__',
    'constructor',
    'prototype',
    '*',
    '.*',
    '%00',
    'a'.repeat(100000), // 초장문
    '\\x00\\xff',
    'NaN',
    JSON.stringify({ a: 1 }),
    0,
    1,
    NaN,
    {},
    [],
    Symbol.iterator, // 비문자열 키
    () => {},
    true,
    false,
  ];
  for (const v of evil) {
    let label;
    try {
      label = String(v);
    } catch {
      label = '<unstringifiable>';
    }
    assert.equal(store.findByKeyHash(v), null, `악성 입력 null 이어야 함: ${label.slice(0, 24)}`);
  }
});
