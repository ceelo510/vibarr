import express from 'express';
import {
  bodyLimitMiddleware,
  corsMiddleware,
  noCacheMiddleware,
  rateLimitMiddleware,
  errorHandler,
  setupGracefulShutdown,
} from './src/middleware.js';
import { loadBwLifetime, loadPersistedActivityLog, logServerEvent } from './src/state.js';
import mountRoutes from './src/routes/index.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.set('etag', false);
// Trust the first proxy so req.ip stays useful behind nginx/container hops.
app.set('trust proxy', 1);
bodyLimitMiddleware(app);
corsMiddleware(app);
noCacheMiddleware(app);
app.use(rateLimitMiddleware);

// Restore persisted counters before requests begin mutating in-memory state.
const bandwidthRestore = loadBwLifetime();
const activityRestore = loadPersistedActivityLog();
const restoreFailed = [bandwidthRestore, activityRestore].some((restore) => restore?.status === 'error' || restore?.status === 'invalid');
logServerEvent(restoreFailed ? 'error' : 'info', 'backend.boot.state_restore', {
  bandwidth: bandwidthRestore,
  activityLog: activityRestore,
});

app.use('/api', mountRoutes);

// Keep the JSON error envelope last so route/middleware failures converge here.
app.use(errorHandler);

const server = app.listen(PORT, '0.0.0.0', () => {
  logServerEvent('info', 'backend.boot.ready', {
    port: Number(PORT),
    environment: process.env.NODE_ENV || 'development',
    trustProxy: app.get('trust proxy'),
  });
});

setupGracefulShutdown(server);
