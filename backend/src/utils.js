import { TIMING, CONFIG } from './config.js';

export function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export async function fetchWithTimeout(url, timeoutMs = 5000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTextWithTimeout(url, timeoutMs = 5000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function arrFetch(url, apiKey, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'X-Api-Key': apiKey },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export function arrPost(url, apiKey, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(body),
  });
}

export function arrPut(url, apiKey, body) {
  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(body),
  });
}

export function arrDelete(url, apiKey) {
  return fetch(url, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } });
}

export function pickImageUrl(images, coverType) {
  const img = images?.find(i => i.coverType === coverType);
  if (!img) return null;
  if (img.remoteUrl && /^https?:\/\//i.test(img.remoteUrl)) return img.remoteUrl;
  if (img.url && /^https?:\/\//i.test(img.url)) return img.url;
  return null;
}

export function pickArrImageUrl(images, coverType, service) {
  const img = images?.find(i => i.coverType === coverType);
  if (!img) return null;
  if (img.remoteUrl && img.remoteUrl.startsWith('http')) return img.remoteUrl;
  if (img.url) return '/api/arr-image/' + service + img.url;
  return null;
}

export function parseArrError(text, status) {
  try {
    const json = JSON.parse(text);
    return json.message || json.errorMessage || json[0]?.errorMessage || 'HTTP ' + status;
  } catch {
    return text?.substring(0, 120) || 'HTTP ' + status;
  }
}

export function normalizeForMatch(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function normalizeServiceUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function hasQbittorrentCredentials() {
  return hasText(CONFIG.QBITTORRENT_USER) && hasText(CONFIG.QBITTORRENT_PASS);
}

export async function probeQbittorrentVersion(timeoutMs = 5000) {
  if (!hasText(CONFIG.QBITTORRENT_HOST)) {
    throw new Error('qBittorrent host is not configured');
  }
  const version = await fetchTextWithTimeout(`${CONFIG.QBITTORRENT_HOST}/api/v2/app/version`, timeoutMs);
  return version.trim();
}

// ─── qBittorrent session cache ──────────────────────────────────────────────

let QB_CACHE = { cookie: null, qbHost: null, expiresAt: 0, inflight: null };

export async function qbittorrentLogin(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && QB_CACHE.cookie && QB_CACHE.expiresAt > now) {
    return { qbHost: QB_CACHE.qbHost, cookie: QB_CACHE.cookie };
  }
  if (QB_CACHE.inflight) return QB_CACHE.inflight;
  const qbHost = CONFIG.QBITTORRENT_HOST?.trim();
  const qbUser = CONFIG.QBITTORRENT_USER?.trim();
  const qbPass = CONFIG.QBITTORRENT_PASS?.trim();
  if (!hasText(qbHost)) {
    throw new Error('qBittorrent host is not configured. Set QBITTORRENT_HOST.');
  }
  if (!hasText(qbUser) || !hasText(qbPass)) {
    throw new Error('qBittorrent credentials are not configured. Set QBITTORRENT_USER and QBITTORRENT_PASS.');
  }
  QB_CACHE.inflight = (async () => {
    const loginResponse = await fetch(qbHost + '/api/v2/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${qbHost}/`,
        'Origin': qbHost,
      },
      body: 'username=' + encodeURIComponent(qbUser) + '&password=' + encodeURIComponent(qbPass)
    });
    const loginBody = await loginResponse.text();
    const loginText = loginBody.trim();
    if (!loginResponse.ok) {
      throw new Error('qBittorrent returned HTTP ' + loginResponse.status + ' - is ' + qbHost + ' reachable?');
    }
    if (loginResponse.status === 204 ? loginText !== '' : loginText !== 'Ok.') {
      throw new Error('Authentication rejected by qBittorrent (user: ' + qbUser + '). Check QBITTORRENT_USER and QBITTORRENT_PASS.');
    }
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')?.[0]?.trim();
    if (!cookie) {
      throw new Error('qBittorrent login succeeded but no session cookie returned');
    }
    QB_CACHE = { cookie, qbHost, expiresAt: Date.now() + TIMING.QB_SESSION_TTL_MS, inflight: null };
    return { qbHost, cookie };
  })();
  try {
    return await QB_CACHE.inflight;
  } catch (e) {
    QB_CACHE.inflight = null;
    throw e;
  }
}

export function invalidateQbSession() {
  QB_CACHE.cookie = null;
  QB_CACHE.expiresAt = 0;
}

async function qbRequest(path, options = {}, forceRefresh = false) {
  const { timeoutMs = 5000, headers = {}, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { qbHost, cookie } = await qbittorrentLogin(forceRefresh);
    const resp = await fetch(qbHost + path, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        Cookie: cookie,
        Referer: `${qbHost}/`,
        ...headers,
      },
    });
    if ((resp.status === 401 || resp.status === 403) && !forceRefresh) {
      invalidateQbSession();
      return qbRequest(path, options, true);
    }
    if (!resp.ok) {
      throw new Error(`qBittorrent ${path} HTTP ${resp.status}`);
    }
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export async function qbFetchJson(path, options = {}) {
  const resp = await qbRequest(path, options);
  return resp.json();
}

export async function qbFetchText(path, options = {}) {
  const resp = await qbRequest(path, options);
  return resp.text();
}

export async function qbAction(hash, action, extra) {
  const body = 'hashes=' + encodeURIComponent(hash) + (extra ? '&' + extra : '');
  await qbRequest('/api/v2/torrents/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}
