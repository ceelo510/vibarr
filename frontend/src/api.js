// In-flight GET dedup: same URL while pending returns the same promise.
const inflight = new Map();

// Per-URL failure backoff (jittered, capped at 5s).
const failureState = new Map(); // url -> { until, count }
const BACKOFF_CAP_MS = 5000;
const API_META_KEY = '__apiMeta';

function nextBackoff(count) {
  const base = Math.min(BACKOFF_CAP_MS, 250 * Math.pow(2, count));
  return base / 2 + Math.random() * (base / 2);
}

/** Returns true if an error is an aborted-fetch (caller cancelled). */
function isAbort(err) {
  return err && (err.name === 'AbortError' || err.code === 20);
}

function createClientRequestId() {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toRetryAfterMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric >= 1000 ? Math.round(numeric) : Math.round(numeric * 1000);
}

function normalizeMessage(payload, status) {
  if (typeof payload === 'string') return payload.trim() || `HTTP ${status}`;
  if (payload && typeof payload === 'object') {
    if (payload.error && typeof payload.error === 'object') {
      return String(
        firstDefined(
          payload.error.message,
          payload.error.detail,
          payload.error.details,
          payload.error.title,
          payload.error.reason,
          payload.error.code,
        ) || `HTTP ${status}`,
      );
    }
    return String(
      firstDefined(
        typeof payload.error === 'string' ? payload.error : undefined,
        payload.message,
        payload.detail,
        payload.details,
        payload.title,
        payload.reason,
      ) || `HTTP ${status}`,
    );
  }
  return `HTTP ${status}`;
}

function collectWarnings(payload) {
  const raw = firstDefined(
    payload?.warnings,
    payload?.warning,
    payload?.meta?.warnings,
    payload?.error?.warnings,
  );
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'object') {
        const message = firstDefined(item.message, item.detail, item.error, item.warning);
        const service = firstDefined(item.service, item.name);
        if (message && service) return `${service}: ${message}`;
        return message ? String(message).trim() : null;
      }
      return String(item).trim();
    })
    .filter(Boolean);
}

function parseTextBody(text) {
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function attachApiMeta(payload, meta) {
  if (!payload || (typeof payload !== 'object' && !Array.isArray(payload))) return payload;
  try {
    Object.defineProperty(payload, API_META_KEY, {
      value: meta,
      enumerable: false,
      configurable: true,
    });
  } catch {}
  return payload;
}

function buildApiMeta({ url, method, status, durationMs, attempt, clientRequestId, payload, response }) {
  const payloadMeta = payload && typeof payload === 'object'
    ? (payload.meta && typeof payload.meta === 'object' ? payload.meta : {})
    : {};
  const payloadRequest = payload && typeof payload === 'object'
    ? (payload.request && typeof payload.request === 'object' ? payload.request : {})
    : {};
  return {
    endpoint: firstDefined(
      payload?.endpoint,
      payloadMeta.endpoint,
      payloadRequest.endpoint,
      url,
    ),
    method,
    status,
    durationMs: firstDefined(
      payload?.durationMs,
      payloadMeta.durationMs,
      payloadRequest.durationMs,
      durationMs,
    ),
    attempt: firstDefined(
      payload?.attempt,
      payloadMeta.attempt,
      payloadRequest.attempt,
      attempt,
    ),
    retryAfterMs: firstDefined(
      payload?.retryAfterMs,
      payloadMeta.retryAfterMs,
      payloadRequest.retryAfterMs,
      toRetryAfterMs(response?.headers?.get('retry-after')),
      null,
    ),
    clientRequestId,
    requestId: firstDefined(
      payload?.requestId,
      payload?.request_id,
      payloadMeta.requestId,
      payloadMeta.request_id,
      payloadRequest.id,
      payloadRequest.requestId,
      payloadRequest.request_id,
      response?.headers?.get('x-request-id'),
      response?.headers?.get('x-correlation-id'),
    ),
    correlationId: firstDefined(
      payload?.correlationId,
      payload?.correlation_id,
      payloadMeta.correlationId,
      payloadMeta.correlation_id,
      payloadRequest.correlationId,
      payloadRequest.correlation_id,
      response?.headers?.get('x-correlation-id'),
    ),
    warnings: collectWarnings(payload),
  };
}

function buildApiError({ payload, status, url, method, durationMs, attempt, clientRequestId, response }) {
  const meta = buildApiMeta({
    url,
    method,
    status,
    durationMs,
    attempt,
    clientRequestId,
    payload,
    response,
  });
  const message = normalizeMessage(payload, status);
  const error = new Error(message);
  error.name = 'ApiError';
  error.status = status;
  error.endpoint = meta.endpoint;
  error.method = method;
  error.durationMs = meta.durationMs;
  error.attempt = meta.attempt;
  error.retryAfterMs = meta.retryAfterMs;
  error.clientRequestId = meta.clientRequestId;
  error.requestId = meta.requestId;
  error.correlationId = meta.correlationId;
  error.warnings = meta.warnings;
  error.response = payload;
  return error;
}

export function getApiMeta(payload) {
  return payload?.[API_META_KEY] || null;
}

export function getApiErrorDetails(error) {
  if (!error) return null;
  return {
    message: String(error.message || 'Request failed'),
    endpoint: error.endpoint || error.url || null,
    method: error.method || null,
    status: Number.isFinite(error.status) ? error.status : null,
    durationMs: Number.isFinite(error.durationMs) ? error.durationMs : null,
    attempt: Number.isFinite(error.attempt) ? error.attempt : null,
    retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null,
    clientRequestId: error.clientRequestId || null,
    requestId: error.requestId || error.correlationId || null,
    warnings: Array.isArray(error.warnings) ? error.warnings : [],
  };
}

/**
 * Thin wrapper around fetch() for JSON API calls.
 * Throws on non-2xx responses with the response body as the error message.
 * Adds: AbortController-friendly signal pass-through, GET dedup, jittered backoff
 * on repeated failures, and silent swallow of AbortError so cancellation doesn't
 * spam console as a rejection.
 * @param {string} url - API path (e.g. '/api/containers')
 * @param {RequestInit} [options] - fetch options (method, body, headers, signal)
 * @returns {Promise<any>} Parsed JSON response
 * @throws {Error} On network failure or non-2xx HTTP status (NOT on abort)
 */
export async function apiFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const isGet = method === 'GET';
  const clientRequestId = createClientRequestId();
  const queuedFailure = isGet ? failureState.get(url) : null;
  const initialAttempt = queuedFailure ? queuedFailure.count + 1 : 1;

  // Backoff: wait out the cooldown instead of surfacing a synthetic error to the UI.
  const fail = queuedFailure;
  if (fail && fail.until > Date.now()) {
    await new Promise(resolve => setTimeout(resolve, fail.until - Date.now()));
  }

  // Dedup GETs by URL (skip when caller passes a signal — they want their own lifecycle).
  if (isGet && !options.signal && inflight.has(url)) {
    return inflight.get(url);
  }

  const exec = (async () => {
    const startedAt = performance.now();
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        ...options,
        headers: {
          'X-Client-Request-Id': clientRequestId,
          ...(options.headers || {}),
        },
      });
      const durationMs = Math.round(performance.now() - startedAt);
      const contentType = res.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await res.json()
        : parseTextBody(await res.text().catch(() => ''));
      if (!res.ok) {
        throw buildApiError({
          payload,
          status: res.status,
          url,
          method,
          durationMs,
          attempt: initialAttempt,
          clientRequestId,
          response: res,
        });
      }
      failureState.delete(url);
      return attachApiMeta(payload, buildApiMeta({
        url,
        method,
        status: res.status,
        durationMs,
        attempt: initialAttempt,
        clientRequestId,
        payload,
        response: res,
      }));
    } catch (err) {
      if (isAbort(err)) {
        // Don't record abort as a failure; rethrow so caller's try/catch can ignore.
        throw err;
      }
      if (isGet) {
        const prev = failureState.get(url) || { count: 0 };
        const count = prev.count + 1;
        failureState.set(url, { count, until: Date.now() + nextBackoff(count) });
      }
      if (err && typeof err === 'object' && !err.clientRequestId) {
        err.clientRequestId = clientRequestId;
      }
      if (err && typeof err === 'object' && !err.endpoint) {
        err.endpoint = url;
      }
      if (err && typeof err === 'object' && !err.method) {
        err.method = method;
      }
      if (err && typeof err === 'object' && !Number.isFinite(err.attempt)) {
        err.attempt = initialAttempt;
      }
      throw err;
    } finally {
      if (isGet && !options.signal) inflight.delete(url);
    }
  })();

  if (isGet && !options.signal) inflight.set(url, exec);
  return exec;
}

/**
 * POST helper — sets Content-Type: application/json and serializes body.
 * @param {string} url
 * @param {Object} [data] - Request body to JSON-serialize
 * @returns {Promise<any>}
 */
export async function apiPost(url, data, options = {}) {
  return apiFetch(url, {
    ...options,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
}

/**
 * DELETE helper.
 * @param {string} url
 * @returns {Promise<any>}
 */
export async function apiDelete(url) {
  return apiFetch(url, { method: 'DELETE' });
}
