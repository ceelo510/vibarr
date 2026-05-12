import express from 'express';
import { AppError } from './errors.js';
import { CONFIG } from './config.js';
import { clearAllIntervals, persistActivityLog, saveBwLifetime, clearFakeTorrentCheckInterval } from './state.js';

const DEFAULT_ALLOWED_HEADERS = ['Content-Type', 'X-Api-Key'];

function redactLogValue(value) {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => {
    if (/pass|password|secret|token|api[_-]?key|authorization/i.test(key)) {
      return [key, '[redacted]'];
    }
    return [key, redactLogValue(nestedValue)];
  }));
}

export function bodyLimitMiddleware(app) {
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
}

export function corsMiddleware(app) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', DEFAULT_ALLOWED_HEADERS.join(', '));
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

export function noCacheMiddleware(app) {
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
}

const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;

// The limiter is in-memory only, so prune idle buckets to keep the map bounded.
function pruneExpiredRateLimitEntries() {
  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip);
  }
}
setInterval(pruneExpiredRateLimitEntries, 60000);

export function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_LIMIT_WINDOW_MS; }
  entry.count++;
  requestCounts.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests', retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
  }
  next();
}

export function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details = null;
  let logDetails = null;
  let internalMessage = err?.message || 'Internal server error';

  // Normalize known app/parser/upstream failures into one JSON error shape.
  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.publicMessage || err.message;
    details = err.details;
    logDetails = err.logDetails;
    internalMessage = err.message;
  } else if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Invalid JSON in request body';
  } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
    status = 504;
    code = 'GATEWAY_TIMEOUT';
    message = 'Upstream service timed out';
  } else {
    status = err.status || err.statusCode || 500;
    message = err.message || 'Internal server error';
  }

  console.error(JSON.stringify({
    scope: 'http-error',
    method: req.method,
    path: req.path,
    status,
    code,
    message: internalMessage,
    publicMessage: message,
    details: redactLogValue(logDetails || details),
    at: new Date().toISOString(),
  }));

  const body = { error: { code, message } };
  if (details) body.error.details = details;
  if (CONFIG.NODE_ENV === 'development' && err.stack && !req.path.startsWith('/api/setup/')) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
}

export function setupGracefulShutdown(server) {
  const shutdown = async (signal) => {
    console.log(`\n[shutdown] Received ${signal}. Cleaning up...`);
    clearAllIntervals();
    clearFakeTorrentCheckInterval();
    // Flush best-effort persisted state before closing the listener.
    await Promise.allSettled([persistActivityLog(), saveBwLifetime()]);
    server.close(() => {
      console.log('[shutdown] Server closed. Goodbye.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[shutdown] Forced exit after timeout');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
