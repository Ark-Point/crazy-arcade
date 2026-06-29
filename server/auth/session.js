'use strict';

// 스테이트리스 세션/CSRF 토큰 + 쿠키 헬퍼.
// 서버 측 세션 저장소를 두지 않고, HMAC-SHA256(SESSION_SECRET) 으로 서명한
// 토큰을 쿠키에 담아 무결성과 만료를 검증한다(BYO-에이전트 OAuth 위임 전용).
//
// 토큰 형식: base64url(JSON payload) + '.' + base64url(HMAC-SHA256(서명대상))
//   - payload 에는 { ...데이터, exp }(exp 는 epoch 초) 가 들어간다.
//   - 서명대상은 첫 번째 base64url 세그먼트 문자열 그대로다.
//   - 검증은 서명 재계산(timingSafeEqual) → exp 만료 확인 순으로 한다.

const crypto = require('crypto');

const SESSION_COOKIE = 'byo_sess';
const STATE_COOKIE = 'byo_state';
const DEFAULT_SESSION_TTL = 86400; // 24h
const DEFAULT_STATE_TTL = 600; // 10m

// 비프로덕션에서 매번 경고가 도배되지 않도록 1회만 출력한다.
let _warnedRandomSecret = false;

// SESSION_SECRET 해석:
//   - 환경변수 우선.
//   - production 인데 미설정이면 하드 페일(throw) — silent degradation 금지.
//   - 비프로덕션 미설정이면 임의 시크릿 + 1회 경고(단일 분기).
// 모듈 로드 시점이 아니라 호출 시점에 해석해 테스트가 env 를 제어할 수 있게 한다.
function resolveSessionSecret(env = process.env) {
  const fromEnv = env.SESSION_SECRET;
  if (fromEnv) return fromEnv;
  if (env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET이 필요합니다(프로덕션)');
  }
  if (!_warnedRandomSecret) {
    _warnedRandomSecret = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[auth] SESSION_SECRET 미설정 — 임의 시크릿을 생성합니다(비프로덕션 전용, 재시작 시 세션 무효화).'
    );
  }
  return crypto.randomBytes(32).toString('hex');
}

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

// payload(객체) → 서명 토큰. exp 는 호출 시각 + ttlSec.
function signToken(payload, secret, ttlSec) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const seg = base64urlEncode(JSON.stringify(body));
  const sig = base64urlEncode(crypto.createHmac('sha256', secret).update(seg).digest());
  return `${seg}.${sig}`;
}

// 토큰 검증: 서명(timingSafeEqual) → 만료 순. 실패 시 null.
function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const seg = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected;
  try {
    expected = base64urlEncode(crypto.createHmac('sha256', secret).update(seg).digest());
  } catch {
    return null;
  }
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(seg).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) {
    return null;
  }
  return payload;
}

function createSessionToken(payload, secret, ttlSec = DEFAULT_SESSION_TTL) {
  return signToken(payload, secret, ttlSec);
}

function verifySessionToken(token, secret) {
  return verifyToken(token, secret);
}

// CSRF nonce 토큰 — 인가요청 시 발급, 콜백에서 일치+만료 검증.
function createStateToken(nonce, secret, ttlSec = DEFAULT_STATE_TTL) {
  return signToken({ nonce }, secret, ttlSec);
}

function verifyStateToken(token, secret) {
  return verifyToken(token, secret);
}

// Set-Cookie 직렬화. maxAge 는 초 단위(Max-Age).
function serializeCookie(name, value, opts = {}) {
  const { httpOnly = false, sameSite, secure = false, maxAge, path = '/' } = opts;
  const parts = [`${name}=${value}`];
  if (path) parts.push(`Path=${path}`);
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// 요청 헤더에서 쿠키 1개 값을 파싱한다(express raw req 호환).
function readCookie(req, name) {
  const header = req && req.headers && req.headers.cookie;
  if (!header || typeof header !== 'string') return null;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    if (k === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

// 세션 쿠키 검증 후 req.account 를 채우는 express 미들웨어.
// 실패 시 401 json {ok:false,error:'인증이 필요합니다'}.
function requireSession(secret) {
  return function (req, res, next) {
    const token = readCookie(req, SESSION_COOKIE);
    const payload = token ? verifySessionToken(token, secret) : null;
    if (!payload || !payload.id) {
      res.status(401).json({ ok: false, error: '인증이 필요합니다' });
      return;
    }
    req.account = payload;
    next();
  };
}

module.exports = {
  SESSION_COOKIE,
  STATE_COOKIE,
  DEFAULT_SESSION_TTL,
  DEFAULT_STATE_TTL,
  resolveSessionSecret,
  createSessionToken,
  verifySessionToken,
  createStateToken,
  verifyStateToken,
  serializeCookie,
  readCookie,
  requireSession,
};
