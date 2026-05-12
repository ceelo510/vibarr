// ─── In-Memory Application State ─────────────────────────────────────────────
// All shared state lives here with getter/setter functions.
// This avoids import circularity and gives us a single place to add locking/persistence.

import { CONFIG, TIMING } from './config.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const LOG_SECRET_KEYS = ['apikey', 'api_key', 'token', 'password', 'pass', 'cookie', 'sid', 'session'];
const persistenceHealth = {
  bandwidthSaveFailed: false,
  activitySaveFailed: false,
};

function redactQueryValue(match, prefix) {
  return `${prefix}[REDACTED]`;
}

function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  let sanitized = value
    .replace(/([?&](?:apikey|api_key|token|password|pass|cookie|sid|session)=)[^&\s]+/gi, redactQueryValue)
    .replace(/((?:apikey|api_key|token|password|pass|cookie|sid|session)=)[^\s&]+/gi, redactQueryValue)
    .replace(/\b([a-f0-9]{8})[a-f0-9]{24,56}\b/gi, '$1…');

  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    for (const key of parsed.searchParams.keys()) {
      if (LOG_SECRET_KEYS.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    sanitized = parsed.toString();
  } catch {
    // Leave non-URL strings in their sanitized text form.
  }

  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}...` : sanitized;
}

function sanitizeLogFields(value) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeLogFields(entry));
  if (value instanceof Error) return summarizeError(value);
  if (typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeLogFields(entry)]),
  );
}

export function summarizeError(error) {
  if (error instanceof Error) {
    return sanitizeLogFields({
      name: error.name,
      code: error.code || null,
      message: error.message || 'Unknown error',
    });
  }
  return sanitizeLogFields({
    name: 'Error',
    code: null,
    message: typeof error === 'string' ? error : JSON.stringify(error),
  });
}

export function logServerEvent(level, event, fields = {}) {
  const payload = sanitizeLogFields({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ─── Activity Log ───────────────────────────────────────────────────────────

const activityLog = [];
const MAX_LOG_ENTRIES = 200;

export function getActivityLog() {
  return activityLog;
}

export function logActivity(type, message, details = null, status = 'info', context = {}) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 6),
    timestamp: new Date().toISOString(),
    type, message, details, status,
    context,
    steps: [{ timestamp: new Date().toISOString(), message, status }],
  };
  activityLog.unshift(entry);
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.length = MAX_LOG_ENTRIES;
  return entry.id;
}

export function updateLogEntry(id, updates) {
  const entry = activityLog.find(e => e.id === id);
  if (!entry) return;
  Object.assign(entry, updates);
  if (updates.message || updates.status) {
    entry.steps.push({
      timestamp: new Date().toISOString(),
      message: updates.message || entry.message,
      status: updates.status || entry.status,
    });
  }
}

export function addLogStep(id, stepMessage, stepStatus) {
  const entry = activityLog.find(e => e.id === id);
  if (!entry) return;
  entry.steps.push({ timestamp: new Date().toISOString(), message: stepMessage, status: stepStatus || entry.status });
}

export function loadPersistedActivityLog() {
  try {
    if (!existsSync(CONFIG.ACTIVITY_LOG_PATH)) {
      return {
        status: 'missing',
        path: CONFIG.ACTIVITY_LOG_PATH,
        entriesLoaded: 0,
      };
    }
    const parsed = JSON.parse(readFileSync(CONFIG.ACTIVITY_LOG_PATH, 'utf-8'));
    if (!Array.isArray(parsed)) {
      return {
        status: 'invalid',
        path: CONFIG.ACTIVITY_LOG_PATH,
        entriesLoaded: 0,
      };
    }
    activityLog.length = 0;
    // Keep a deeper in-memory tail for the live UI, but cap the persisted file on disk.
    activityLog.push(...parsed.slice(0, MAX_LOG_ENTRIES));
    return {
      status: 'loaded',
      path: CONFIG.ACTIVITY_LOG_PATH,
      entriesLoaded: activityLog.length,
    };
  } catch (e) {
    return {
      status: 'error',
      path: CONFIG.ACTIVITY_LOG_PATH,
      entriesLoaded: 0,
      error: summarizeError(e),
    };
  }
}

// ─── Download Pipeline ──────────────────────────────────────────────────────

const downloadPipeline = new Map();

export function getPipeline() {
  return [...downloadPipeline.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getPipelineItem(key) {
  return downloadPipeline.get(key);
}

export function addPipelineItem(key, info) {
  const now = Date.now();
  downloadPipeline.set(key, {
    key,
    createdAt: now,
    stageStartedAt: now,
    stageChangedAt: now,
    stage: 'queued',
    error: null,
    log: [],
    ...info,
  });
}

export function advancePipeline(key, stage, extra = {}) {
  const item = downloadPipeline.get(key);
  if (!item) return;
  const now = Date.now();
  // createdAt tracks total age; stage timestamps reset on each transition.
  item.stage = stage;
  item.stageStartedAt = now;
  item.stageChangedAt = now;
  Object.assign(item, extra);
}

export function completePipeline(key) {
  const item = downloadPipeline.get(key);
  if (item) {
    const now = Date.now();
    item.stage = 'complete';
    item.stageStartedAt = now;
    item.stageChangedAt = now;
    item.completedAt = now;
  }
}

export function removePipelineItem(key) {
  downloadPipeline.delete(key);
}

export function setPipelineStuck(key, errorMsg) {
  const item = downloadPipeline.get(key);
  if (item) {
    const now = Date.now();
    item.stage = 'stuck';
    item.error = errorMsg;
    item.stageStartedAt = now;
    item.stageChangedAt = now;
  }
}

export function getPipelineSize() {
  return downloadPipeline.size;
}

// ─── Caches ─────────────────────────────────────────────────────────────────

export const metadataCache = { data: null, lastFetched: 0 };
export const itunesPosterCache = new Map();
export const fastSearchCache = new Map();
export const fakeAlertsSeen = new Set();

export let libraryCache = {
  movies: [],
  series: [],
  artists: [],
  albums: [],
  lastRefresh: null,
  serviceStates: {
    series: { status: CONFIG.SONARR_API_KEY ? 'stale' : 'unconfigured', error: null },
    movies: { status: CONFIG.RADARR_API_KEY ? 'stale' : 'unconfigured', error: null },
    artists: { status: CONFIG.LIDARR_API_KEY ? 'stale' : 'unconfigured', error: null },
  },
};

export function setLibraryCache(cache) {
  libraryCache = cache;
}

export let fakeTorrentCheckInterval = null;
export function setFakeTorrentCheckInterval(id) {
  fakeTorrentCheckInterval = id;
}
export function clearFakeTorrentCheckInterval() {
  if (fakeTorrentCheckInterval) {
    clearInterval(fakeTorrentCheckInterval);
    fakeTorrentCheckInterval = null;
  }
}

// ─── Watching / Polling State ──────────────────────────────────────────────

export const watchedCommands = new Map();
export const intervalIds = [];

export function registerInterval(id) {
  intervalIds.push(id);
}

// Shutdown walks this registry instead of relying on each caller to remember its own timer.
export function clearAllIntervals() {
  for (const id of intervalIds) {
    clearInterval(id);
  }
  intervalIds.length = 0;
}

// ─── Bandwidth Lifetime Tracking ────────────────────────────────────────────

function coerceBwLifetimeShape(raw = {}) {
  const legacyDl = Number(raw?.dl) || 0;
  const legacyUl = Number(raw?.ul) || 0;
  return {
    baseline: {
      dl: Number(raw?.baseline?.dl) || legacyDl,
      ul: Number(raw?.baseline?.ul) || legacyUl,
    },
    lastSession: {
      dl: Number(raw?.lastSession?.dl) || 0,
      ul: Number(raw?.lastSession?.ul) || 0,
    },
  };
}

let bwLifetime = coerceBwLifetimeShape();

export function getBwLifetimeState() {
  return {
    baseline: { ...bwLifetime.baseline },
    lastSession: { ...bwLifetime.lastSession },
  };
}

export function noteQbSessionTotals(sessionDl, sessionUl) {
  const normalizedDl = Number(sessionDl) || 0;
  const normalizedUl = Number(sessionUl) || 0;
  if (normalizedDl < bwLifetime.lastSession.dl || normalizedUl < bwLifetime.lastSession.ul) {
    bwLifetime.baseline.dl += bwLifetime.lastSession.dl;
    bwLifetime.baseline.ul += bwLifetime.lastSession.ul;
  }
  bwLifetime.lastSession.dl = normalizedDl;
  bwLifetime.lastSession.ul = normalizedUl;
  return getBwLifetimeState();
}

export function resetBwLifetime() {
  bwLifetime = coerceBwLifetimeShape();
}

export function loadBwLifetime() {
  try {
    if (!existsSync(CONFIG.BANDWIDTH_PATH)) {
      return {
        status: 'missing',
        path: CONFIG.BANDWIDTH_PATH,
        baseline: { ...bwLifetime.baseline },
        lastSession: { ...bwLifetime.lastSession },
      };
    }
    const parsed = JSON.parse(readFileSync(CONFIG.BANDWIDTH_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      bwLifetime = coerceBwLifetimeShape();
      return {
        status: 'invalid',
        path: CONFIG.BANDWIDTH_PATH,
        baseline: { ...bwLifetime.baseline },
        lastSession: { ...bwLifetime.lastSession },
      };
    }
    bwLifetime = coerceBwLifetimeShape(parsed);
    return {
      status: 'loaded',
      path: CONFIG.BANDWIDTH_PATH,
      baseline: { ...bwLifetime.baseline },
      lastSession: { ...bwLifetime.lastSession },
    };
  } catch (e) {
    return {
      status: 'error',
      path: CONFIG.BANDWIDTH_PATH,
      baseline: { ...bwLifetime.baseline },
      lastSession: { ...bwLifetime.lastSession },
      error: summarizeError(e),
    };
  }
}

export function saveBwLifetime() {
  try {
    writeFileSync(CONFIG.BANDWIDTH_PATH, JSON.stringify(bwLifetime));
    if (persistenceHealth.bandwidthSaveFailed) {
      persistenceHealth.bandwidthSaveFailed = false;
      logServerEvent('info', 'state.bandwidth_persist.recovered', {
        path: CONFIG.BANDWIDTH_PATH,
        baseline: { ...bwLifetime.baseline },
        lastSession: { ...bwLifetime.lastSession },
      });
    }
    return true;
  } catch (e) {
    if (!persistenceHealth.bandwidthSaveFailed) {
      logServerEvent('error', 'state.bandwidth_persist.failed', {
        path: CONFIG.BANDWIDTH_PATH,
        baseline: { ...bwLifetime.baseline },
        lastSession: { ...bwLifetime.lastSession },
        error: summarizeError(e),
      });
    }
    persistenceHealth.bandwidthSaveFailed = true;
    return false;
  }
}

// ─── Activity Log Persistence ───────────────────────────────────────────────

export function persistActivityLog() {
  try {
    writeFileSync(CONFIG.ACTIVITY_LOG_PATH, JSON.stringify(activityLog.slice(0, 100)));
    if (persistenceHealth.activitySaveFailed) {
      persistenceHealth.activitySaveFailed = false;
      logServerEvent('info', 'state.activity_log_persist.recovered', {
        path: CONFIG.ACTIVITY_LOG_PATH,
        persistedEntries: Math.min(activityLog.length, 100),
      });
    }
    return true;
  } catch (e) {
    if (!persistenceHealth.activitySaveFailed) {
      logServerEvent('error', 'state.activity_log_persist.failed', {
        path: CONFIG.ACTIVITY_LOG_PATH,
        persistedEntries: Math.min(activityLog.length, 100),
        error: summarizeError(e),
      });
    }
    persistenceHealth.activitySaveFailed = true;
    return false;
  }
}
