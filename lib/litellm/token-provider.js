'use strict';

const DEFAULT_REFRESH_MARGIN_MS = 60000;
const DEFAULT_GRACE_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MIN_TTL_MS = 5000;

class LiteLlmTokenRefreshError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LiteLlmTokenRefreshError';
    this.status = options.status || null;
    this.cause = options.cause || null;
  }
}

function nowMs() {
  return Date.now();
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bearerHeader(token) {
  return `Bearer ${token}`;
}

function parseTokenPayload(payload, requestedAt, fallbackTtlMs) {
  if (!payload || typeof payload !== 'object') {
    throw new LiteLlmTokenRefreshError('token endpoint returned a non-object payload');
  }
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    throw new LiteLlmTokenRefreshError('token endpoint did not return access_token');
  }
  const ttlMs = positiveNumber(payload.expires_in, fallbackTtlMs / 1000) * 1000;
  return {
    accessToken,
    tokenType: typeof payload.token_type === 'string' && payload.token_type ? payload.token_type : 'Bearer',
    expiresAtMs: requestedAt + ttlMs,
  };
}

function isUsableToken(token, atMs, graceMs) {
  return !!(token && token.accessToken && atMs < token.expiresAtMs + graceMs);
}

function shouldRefresh(token, atMs, refreshMarginMs) {
  return !token || atMs >= token.expiresAtMs - refreshMarginMs;
}

class LiteLlmTokenProvider {
  constructor(options) {
    if (!options || typeof options !== 'object') throw new TypeError('options are required');
    if (!options.tokenUrl) throw new TypeError('tokenUrl is required');
    if (typeof options.clientId !== 'string' || !options.clientId) throw new TypeError('clientId is required');
    if (typeof options.clientSecret !== 'string' || !options.clientSecret) throw new TypeError('clientSecret is required');
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scope = options.scope || '';
    this.audience = options.audience || '';
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.refreshMarginMs = positiveNumber(options.refreshMarginMs, DEFAULT_REFRESH_MARGIN_MS);
    this.graceMs = positiveNumber(options.graceMs, DEFAULT_GRACE_MS);
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.fallbackTtlMs = positiveNumber(options.fallbackTtlMs, DEFAULT_MIN_TTL_MS);
    this.current = null;
    this.inFlight = null;
  }

  async getToken() {
    const atMs = nowMs();
    if (!shouldRefresh(this.current, atMs, this.refreshMarginMs)) return this.current.accessToken;
    if (isUsableToken(this.current, atMs, this.graceMs)) {
      this.refresh().catch(() => {});
      return this.current.accessToken;
    }
    const refreshed = await this.refresh();
    return refreshed.accessToken;
  }

  async getAuthorizationHeader() {
    const token = await this.getToken();
    return bearerHeader(token);
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async fetchToken() {
    const requestedAt = nowMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
      if (this.scope) body.set('scope', this.scope);
      if (this.audience) body.set('audience', this.audience);
      const response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!response || !response.ok) {
        throw new LiteLlmTokenRefreshError('token endpoint rejected refresh', { status: response && response.status });
      }
      const payload = await response.json();
      const token = parseTokenPayload(payload, requestedAt, this.fallbackTtlMs);
      this.current = token;
      return token;
    } catch (error) {
      if (isUsableToken(this.current, nowMs(), this.graceMs)) return this.current;
      if (error instanceof LiteLlmTokenRefreshError) throw error;
      throw new LiteLlmTokenRefreshError('token refresh failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  LiteLlmTokenProvider,
  LiteLlmTokenRefreshError,
};
