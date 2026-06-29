'use strict';

// BYO-에이전트 계정/API키 저장소 어댑터.
// 기본 구현은 JsonStore: 부팅 시 파일을 읽어 인메모리 인덱스를 만들고(읽기 O(1)),
// 쓰기(발급/폐기)는 단일 async 뮤텍스로 직렬화한 뒤 temp-write+rename 으로 원자적 영속,
// 폐기 시 fsync 로 flush 한다. node:sqlite 백엔드는 동일 인터페이스로 교체 가능하다.
//
// 인터페이스(어댑터 계약):
//   upsertAccount({ provider, subject }) -> Account
//   listKeys(accountId)                  -> ApiKey 메타[](keyHash 미노출)
//   issueKey(accountId, label, limits?)  -> { key(평문 1회), record }
//   revokeKey(keyId)                     -> boolean
//   findByKeyHash(hash)                  -> ApiKey | null (revoked 제외)
//
// 키는 평문을 저장하지 않는다: 발급 시 1회만 평문을 반환하고 sha256 해시와 prefix 만 보관한다.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const KEY_BYTES = 32;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// 키 평문 → 룩업 해시(단방향). 어댑터/미들웨어가 공유한다.
function hashKey(plaintext) {
  return sha256Hex(plaintext);
}

function accountId(provider, subject) {
  // provider+subject 로 결정적 id (동일 OAuth 주체 재로그인 시 upsert 멱등).
  return `acct_${sha256Hex(`${provider}:${subject}`).slice(0, 24)}`;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// 외부로 내보낼 때 keyHash 는 제거한다(목록/응답에 해시 노출 금지).
function publicKeyView(rec) {
  return {
    id: rec.id,
    accountId: rec.accountId,
    label: rec.label,
    issuedAt: rec.issuedAt,
    revoked: rec.revoked,
    keyPrefix: rec.keyPrefix,
    limits: rec.limits,
  };
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.accounts = new Map(); // id -> Account
    this.keysById = new Map(); // keyId -> ApiKey(내부, keyHash 포함)
    this.keyHashIndex = new Map(); // keyHash -> keyId (revoked 제외)
    this.accountKeys = new Map(); // accountId -> Set<keyId>
    this._lock = Promise.resolve(); // 쓰기 직렬화 뮤텍스
    this._loaded = false;
  }

  // 부팅 시 1회 동기 로드 후 인메모리 인덱스 구성.
  load() {
    if (this._loaded) return;
    this._loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return; // 신규 저장소
      throw err;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`byo-store 파일이 손상되었습니다: ${this.filePath}`);
    }
    // 파싱은 됐으나 구조가 손상된(객체 아님/배열 아님/버전 불일치) 입력도 동일하게 거부한다.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`byo-store 파일이 손상되었습니다(객체 아님): ${this.filePath}`);
    }
    if (data.version !== undefined && data.version !== 1) {
      throw new Error(`byo-store 버전을 지원하지 않습니다(${data.version}): ${this.filePath}`);
    }
    const accounts = data.accounts === undefined ? [] : data.accounts;
    const keys = data.keys === undefined ? [] : data.keys;
    if (!Array.isArray(accounts) || !Array.isArray(keys)) {
      throw new Error(`byo-store 파일이 손상되었습니다(accounts/keys 배열 아님): ${this.filePath}`);
    }
    for (const acc of accounts) {
      this.accounts.set(acc.id, acc);
    }
    for (const rec of keys) {
      this.keysById.set(rec.id, rec);
      if (!this.accountKeys.has(rec.accountId)) this.accountKeys.set(rec.accountId, new Set());
      this.accountKeys.get(rec.accountId).add(rec.id);
      if (!rec.revoked) this.keyHashIndex.set(rec.keyHash, rec.id);
    }
  }

  // 인메모리 상태 전체를 원자적으로 영속. flush=true 면 fsync 로 내구성 보장.
  async _persist({ flush = false } = {}) {
    const snapshot = {
      version: 1,
      accounts: [...this.accounts.values()],
      keys: [...this.keysById.values()],
    };
    const json = JSON.stringify(snapshot, null, 2);
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(json);
      if (flush) await fh.sync();
    } catch (err) {
      await fh.close().catch(() => {});
      await fsp.unlink(tmp).catch(() => {}); // 실패 시 orphan temp 정리(best-effort)
      throw err;
    }
    await fh.close();
    await fsp.rename(tmp, this.filePath);
    // rename 자체의 디렉터리 엔트리 가시성까지 보장(폐기 내구성: 전원손실 시 revoked 복귀 방지).
    if (flush) {
      const dh = await fsp.open(dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    }
  }

  // 쓰기 작업을 단일 뮤텍스 체인에 직렬화(동시 발급/폐기 경합 방지).
  _serialize(fn) {
    const run = this._lock.then(fn, fn);
    // 다음 작업이 이전 실패에 막히지 않도록 체인은 항상 resolve 로 잇는다.
    this._lock = run.then(() => undefined, () => undefined);
    return run;
  }

  upsertAccount({ provider, subject }) {
    if (!provider || !subject) throw new Error('provider 와 subject 가 필요합니다.');
    this.load();
    return this._serialize(async () => {
      const id = accountId(provider, subject);
      let acc = this.accounts.get(id);
      if (!acc) {
        acc = { id, provider, subject, createdAt: new Date().toISOString() };
        this.accounts.set(id, acc);
        await this._persist();
      }
      return acc;
    });
  }

  listKeys(accountId_) {
    this.load();
    const ids = this.accountKeys.get(accountId_);
    if (!ids) return [];
    return [...ids].map((id) => publicKeyView(this.keysById.get(id)));
  }

  issueKey(accountId_, label, limits = null) {
    this.load();
    if (!this.accounts.has(accountId_)) throw new Error('알 수 없는 계정입니다.');
    return this._serialize(async () => {
      const plaintext = crypto.randomBytes(KEY_BYTES).toString('base64url');
      const keyHash = hashKey(plaintext);
      const rec = {
        id: randomId('key'),
        accountId: accountId_,
        label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 64) : 'agent key',
        issuedAt: new Date().toISOString(),
        revoked: false,
        keyHash,
        keyPrefix: plaintext.slice(0, 8),
        limits: limits || null,
      };
      this.keysById.set(rec.id, rec);
      if (!this.accountKeys.has(accountId_)) this.accountKeys.set(accountId_, new Set());
      this.accountKeys.get(accountId_).add(rec.id);
      this.keyHashIndex.set(keyHash, rec.id);
      await this._persist();
      // 평문은 이 반환에서 단 한 번만 노출된다.
      return { key: plaintext, record: publicKeyView(rec) };
    });
  }

  revokeKey(keyId) {
    this.load();
    return this._serialize(async () => {
      const rec = this.keysById.get(keyId);
      if (!rec || rec.revoked) return false;
      rec.revoked = true;
      this.keyHashIndex.delete(rec.keyHash); // 폐기 즉시 룩업 차단
      await this._persist({ flush: true }); // 폐기는 내구성 보장(fsync)
      return true;
    });
  }

  findByKeyHash(hash) {
    this.load();
    const keyId = this.keyHashIndex.get(hash);
    if (!keyId) return null;
    const rec = this.keysById.get(keyId);
    if (!rec || rec.revoked) return null;
    return rec;
  }
}

function createStore(filePath) {
  const store = new JsonStore(filePath);
  store.load();
  return store;
}

module.exports = { JsonStore, createStore, hashKey, publicKeyView };
