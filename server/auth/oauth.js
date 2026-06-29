'use strict';

// OAuth 위임 라우터(비밀번호 미처리). 인가코드 그랜트:
//   GET  /auth/:provider          → state nonce 발급(서명 쿠키) 후 provider 로 302
//   GET  /auth/:provider/callback → state 검증 → 코드 토큰교환 → 유저조회 →
//                                    계정 upsert → 세션 쿠키 set → '/' 로 302
//   POST /auth/logout             → 세션 쿠키 만료
//
// 네트워크/IO 는 fetchImpl 과 store 로 주입해 테스트가 네트워크 없이 구동되게 한다.

const express = require('express');
const crypto = require('crypto');
const {
  SESSION_COOKIE,
  STATE_COOKIE,
  DEFAULT_SESSION_TTL,
  DEFAULT_STATE_TTL,
  createSessionToken,
  createStateToken,
  verifyStateToken,
  serializeCookie,
  readCookie,
} = require('./session');

// env 기반 기본 provider 구성. clientId/Secret 이 없는 provider 는 제외한다.
function buildDefaultProviders(env = process.env) {
  const providers = {};
  if (env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET) {
    providers.github = {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userUrl: 'https://api.github.com/user',
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
      scope: 'read:user',
      parseUser: (json) => ({ subject: json && json.id != null ? String(json.id) : null }),
    };
  }
  if (env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET) {
    providers.google = {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      clientId: env.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
      scope: 'openid email profile',
      parseUser: (json) => ({ subject: json && json.sub != null ? String(json.sub) : null }),
    };
  }
  return providers;
}

function createOAuthRouter({
  store,
  secret,
  providers = {},
  fetchImpl = globalThis.fetch,
  callbackBaseUrl,
  ttlSec = DEFAULT_SESSION_TTL,
  stateTtlSec = DEFAULT_STATE_TTL,
  secureCookies = process.env.NODE_ENV === 'production',
} = {}) {
  if (!store) throw new Error('store 가 필요합니다.');
  if (!secret) throw new Error('secret 이 필요합니다.');
  if (!callbackBaseUrl) throw new Error('callbackBaseUrl 이 필요합니다.');

  const router = express.Router();
  const base = callbackBaseUrl.replace(/\/+$/, '');

  function redirectUriFor(name) {
    return `${base}/auth/${name}/callback`;
  }

  // GET /auth/:provider — state nonce 발급 후 provider 인가 URL 로 302.
  router.get('/auth/:provider', (req, res) => {
    const name = req.params.provider;
    const provider = providers[name];
    if (!provider) {
      res.status(404).json({ ok: false, error: '지원하지 않는 provider 입니다' });
      return;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const stateToken = createStateToken(nonce, secret, stateTtlSec);
    res.append(
      'Set-Cookie',
      serializeCookie(STATE_COOKIE, stateToken, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: secureCookies,
        maxAge: stateTtlSec,
      })
    );
    const url = new URL(provider.authorizeUrl);
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', redirectUriFor(name));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', nonce);
    if (provider.scope) url.searchParams.set('scope', provider.scope);
    res.redirect(302, url.toString());
  });

  // GET /auth/:provider/callback — state 검증 → 토큰교환 → 유저조회 → 계정 upsert.
  router.get('/auth/:provider/callback', async (req, res) => {
    const name = req.params.provider;
    const provider = providers[name];
    if (!provider) {
      res.status(404).json({ ok: false, error: '지원하지 않는 provider 입니다' });
      return;
    }
    // CSRF: state 쿠키(서명·만료) 검증 + 쿼리 state 와 nonce 일치.
    const stateCookie = readCookie(req, STATE_COOKIE);
    const statePayload = stateCookie ? verifyStateToken(stateCookie, secret) : null;
    const queryState = req.query.state;
    if (!statePayload || !queryState || statePayload.nonce !== queryState) {
      res.status(400).json({ ok: false, error: 'state 검증에 실패했습니다' });
      return;
    }
    // state 쿠키는 1회용 — 즉시 만료시킨다.
    res.append(
      'Set-Cookie',
      serializeCookie(STATE_COOKIE, '', { httpOnly: true, sameSite: 'Lax', secure: secureCookies, maxAge: 0 })
    );

    const code = req.query.code;
    if (!code) {
      res.status(400).json({ ok: false, error: 'code 가 없습니다' });
      return;
    }

    let subject;
    try {
      // 1) 코드 → 액세스 토큰 교환.
      const tokenRes = await fetchImpl(provider.tokenUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(code),
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          redirect_uri: redirectUriFor(name),
        }).toString(),
      });
      if (!tokenRes || !tokenRes.ok) {
        res.status(502).json({ ok: false, error: '토큰 교환에 실패했습니다' });
        return;
      }
      const tokenJson = await tokenRes.json();
      const accessToken = tokenJson && tokenJson.access_token;
      if (!accessToken) {
        res.status(502).json({ ok: false, error: '액세스 토큰을 받지 못했습니다' });
        return;
      }
      // 2) 액세스 토큰으로 유저 정보 조회.
      const userRes = await fetchImpl(provider.userUrl, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'crazay-arkade' },
      });
      if (!userRes || !userRes.ok) {
        res.status(502).json({ ok: false, error: '유저 조회에 실패했습니다' });
        return;
      }
      const userJson = await userRes.json();
      const parsed = provider.parseUser(userJson);
      subject = parsed && parsed.subject;
      // 누락 필드가 'undefined'/'null' 문자열로 강제되어 가드를 통과하는 신원 혼동을 방지한다.
      if (!subject || subject === 'undefined' || subject === 'null') {
        res.status(502).json({ ok: false, error: '유저 식별자를 확인할 수 없습니다' });
        return;
      }
    } catch {
      res.status(502).json({ ok: false, error: 'OAuth provider 통신에 실패했습니다' });
      return;
    }

    // 3) 계정 upsert → 세션 쿠키 set.
    const account = await store.upsertAccount({ provider: name, subject: String(subject) });
    const sessionToken = createSessionToken(
      { id: account.id, provider: account.provider, subject: account.subject },
      secret,
      ttlSec
    );
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: secureCookies,
        maxAge: ttlSec,
      })
    );
    res.redirect(302, '/');
  });

  // POST /auth/logout — 세션 쿠키 만료.
  router.post('/auth/logout', (req, res) => {
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Lax', secure: secureCookies, maxAge: 0 })
    );
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createOAuthRouter, buildDefaultProviders };
