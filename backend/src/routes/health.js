import { Router } from 'express';
import Docker from 'dockerode';
import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CONFIG } from '../config.js';
import {
  fetchWithTimeout,
  hasQbittorrentCredentials,
  hasText,
  normalizeServiceUrl,
  probeQbittorrentVersion,
  qbFetchText,
} from '../utils.js';
import { readInstallerState } from '../installerState.js';

const router = Router();
const execFileAsync = promisify(execFile);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

let storageCache = null;
let storageCacheTime = 0;
const STORAGE_CACHE_TTL = 60000;
const LIBRARY_SERVICE_NAMES = ['radarr', 'sonarr', 'lidarr'];
const COMPLETE_SETUP_VALUES = new Set(['complete', 'completed', 'done', 'installed', 'ready', 'success']);
const IN_PROGRESS_SETUP_VALUES = new Set(['installing', 'configuring', 'starting', 'bootstrapping', 'running', 'pending']);
const FAILED_SETUP_VALUES = new Set(['failed', 'error', 'blocked']);

function readNestedValue(source, path) {
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), source);
}

function firstMatchingValue(source, paths, predicate) {
  for (const path of paths) {
    const value = readNestedValue(source, path);
    if (predicate(value)) return value;
  }
  return undefined;
}

function inferInstallerProgress(installerState) {
  const phase = firstMatchingValue(installerState, [
    'phase',
    'setupPhase',
    'setup.phase',
    'progress.phase',
    'state.phase',
  ], hasText) || null;
  const statusText = firstMatchingValue(installerState, [
    'status',
    'setup.status',
    'progress.status',
    'state.status',
  ], hasText) || null;
  const normalizedPhase = phase?.trim().toLowerCase() || null;
  const normalizedStatus = statusText?.trim().toLowerCase() || null;

  const explicitComplete = firstMatchingValue(installerState, [
    'setupComplete',
    'complete',
    'completed',
    'setup.complete',
    'setup.completed',
    'progress.complete',
    'progress.completed',
  ], value => typeof value === 'boolean');
  const explicitFailed = firstMatchingValue(installerState, [
    'failed',
    'setup.failed',
    'progress.failed',
    'hasError',
    'setup.hasError',
  ], value => typeof value === 'boolean');
  const explicitInProgress = firstMatchingValue(installerState, [
    'inProgress',
    'setup.inProgress',
    'progress.inProgress',
    'setupRunning',
  ], value => typeof value === 'boolean');

  return {
    phase: phase || statusText,
    explicitComplete: explicitComplete ?? (
      COMPLETE_SETUP_VALUES.has(normalizedPhase) || COMPLETE_SETUP_VALUES.has(normalizedStatus)
        ? true
        : undefined
    ),
    explicitFailed: explicitFailed ?? (
      FAILED_SETUP_VALUES.has(normalizedPhase) || FAILED_SETUP_VALUES.has(normalizedStatus)
        ? true
        : undefined
    ),
    explicitInProgress: explicitInProgress ?? (
      IN_PROGRESS_SETUP_VALUES.has(normalizedPhase) || IN_PROGRESS_SETUP_VALUES.has(normalizedStatus)
        ? true
        : undefined
    ),
    lastError: hasText(installerState?.lastInstallError) ? installerState.lastInstallError : null,
  };
}

function incrementSummaryBucket(bucket, status) {
  bucket[status] = (bucket[status] || 0) + 1;
}

async function resolveServiceStatus(definition) {
  const expectedBySetup = definition.expectedBySetup === true;
  const requiredForSetup = definition.requiredForSetup === true;
  const base = {
    url: normalizeServiceUrl(definition.url),
    configured: definition.configured === true,
    healthy: false,
    reachable: null,
    optional: !expectedBySetup && !requiredForSetup,
    expectedBySetup,
    requiredForSetup,
  };

  try {
    return {
      ...base,
      ...(await definition.probe()),
    };
  } catch (error) {
    return {
      ...base,
      status: 'down',
      reason: 'unreachable',
      reachable: false,
      error: error.message,
    };
  }
}

// These shell-outs hit host mounts, so a short cache keeps the dashboard from thrashing disk.
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/tailscale-ip', (req, res) => {
  const options = {
    socketPath: '/var/run/tailscale/tailscaled.sock',
    path: '/localapi/v0/status',
    method: 'GET',
    headers: { 'Sec-Tailscale': 'localapi', 'Host': 'local-tailscaled.sock' },
  };

  const tsReq = http.request(options, (tsRes) => {
    let data = '';
    tsRes.on('data', chunk => { data += chunk; });
    tsRes.on('end', () => {
      try {
        const status = JSON.parse(data);
        const ipv4 = (status.Self?.TailscaleIPs || []).find(ip => ip.includes('.'));
        if (ipv4) res.json({ ip: ipv4 });
        else res.status(404).json({ error: 'No IPv4 address found in Tailscale status' });
      } catch (e) {
        console.error('Error parsing Tailscale status:', e);
        res.status(500).json({ error: 'Failed to parse Tailscale status' });
      }
    });
  });

  tsReq.on('error', (e) => {
    console.error('Error querying Tailscale:', e);
    res.status(500).json({ error: 'Failed to connect to Tailscale socket' });
  });

  tsReq.end();
});

router.get('/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const containerInfo = await Promise.all(
      containers.map(async (container) => {
        const inspect = await docker.getContainer(container.Id).inspect();
        const ports = [];
        if (inspect.NetworkSettings?.Ports) {
          for (const [containerPort, hostBindings] of Object.entries(inspect.NetworkSettings.Ports)) {
            if (hostBindings) {
              hostBindings.forEach(binding => {
                ports.push({ container: containerPort, host: binding.HostPort });
              });
            }
          }
        }
        const startedAt = new Date(inspect.State.StartedAt);
        const uptime = inspect.State.Running ? Date.now() - startedAt.getTime() : 0;
        return {
          id: container.Id,
          name: container.Names[0].replace(/^\//, ''),
          image: container.Image,
          status: container.State,
          state: inspect.State.Status,
          running: inspect.State.Running,
          startedAt: inspect.State.StartedAt,
          uptime,
          ports,
          networks: Object.keys(inspect.NetworkSettings.Networks || {}),
        };
      })
    );
    res.json(containerInfo);
  } catch (error) {
    console.error('Error fetching containers:', error);
    res.status(500).json({ error: 'Failed to fetch containers', message: error.message });
  }
});

router.get('/containers/:id/logs', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const logs = await container.logs({ stdout: true, stderr: true, tail: 100 });
    res.json({ logs: logs.toString('utf8') });
  } catch (error) {
    console.error('Error fetching container logs:', error);
    res.status(500).json({ error: 'Failed to fetch container logs', message: error.message });
  }
});

router.get('/storage', async (req, res) => {
  try {
    const now = Date.now();
    if (storageCache && (now - storageCacheTime) < STORAGE_CACHE_TTL) {
      return res.json(storageCache);
    }
    const { stdout: dfOutput } = await execFileAsync('df', ['-B1', '/hostfs'], { timeout: 5000 });
    const dfParts = dfOutput.trim().split('\n')[1].split(/\s+/);
    const disk = {
      total: parseInt(dfParts[1]), used: parseInt(dfParts[2]),
      available: parseInt(dfParts[3]), percentUsed: parseFloat(dfParts[4]),
    };
    const dirs = [
      { name: 'TV Downloads', path: '/hostdocker/downloads/tv' },
      { name: 'TV Library', path: '/hostdocker/tv' },
      { name: 'Movies', path: '/hostdocker/movies' },
      { name: 'Configs', path: '/hostdocker/configs' },
    ];
    const breakdown = await Promise.all(dirs.map(async (d) => {
      try {
        const { stdout } = await execFileAsync('du', ['-sb', d.path], { timeout: 30000 });
        const size = parseInt(stdout.split('\t')[0], 10);
        return { name: d.name, path: d.path, size: isNaN(size) ? 0 : size };
      } catch { return { name: d.name, path: d.path, size: 0 }; }
    }));
    const result = { disk, breakdown, timestamp: new Date().toISOString() };
    storageCache = result;
    storageCacheTime = now;
    res.json(result);
  } catch (error) {
    console.error('Error fetching storage info:', error);
    res.status(500).json({ error: 'Failed to fetch storage info', message: error.message });
  }
});

router.get('/docker/status', (req, res) => res.redirect('/api/containers'));

router.get('/status', async (req, res) => {
  const installerState = readInstallerState();
  const installerProgress = inferInstallerProgress(installerState);
  const configuredLibraryServices = LIBRARY_SERVICE_NAMES.filter((name) => {
    switch (name) {
      case 'radarr':
        return hasText(CONFIG.RADARR_API_KEY);
      case 'sonarr':
        return hasText(CONFIG.SONARR_API_KEY);
      case 'lidarr':
        return hasText(CONFIG.LIDARR_API_KEY);
      default:
        return false;
    }
  });
  const installerRequestedLibraryServices = LIBRARY_SERVICE_NAMES.filter((name) => installerState?.services?.[name] === true);
  const expectedLibraryServices = installerRequestedLibraryServices.length > 0
    ? installerRequestedLibraryServices
    : configuredLibraryServices;
  const expectedServiceSet = new Set([
    ...expectedLibraryServices,
    ...['qbittorrent', 'prowlarr', 'slskd'].filter((name) => installerState?.services?.[name] === true),
  ]);

  const serviceDefinitions = [
    {
      name: 'radarr',
      url: CONFIG.RADARR_HOST,
      configured: hasText(CONFIG.RADARR_API_KEY),
      expectedBySetup: expectedServiceSet.has('radarr'),
      requiredForSetup: expectedLibraryServices.includes('radarr'),
      probe: async () => {
        if (!hasText(CONFIG.RADARR_API_KEY)) return { status: 'unconfigured', reason: 'missing_api_key' };
        await fetchWithTimeout(`${CONFIG.RADARR_HOST}/api/v3/system/status?apikey=${CONFIG.RADARR_API_KEY}`, 3000);
        return { status: 'up', reason: 'ready', reachable: true, healthy: true };
      },
    },
    {
      name: 'sonarr',
      url: CONFIG.SONARR_HOST,
      configured: hasText(CONFIG.SONARR_API_KEY),
      expectedBySetup: expectedServiceSet.has('sonarr'),
      requiredForSetup: expectedLibraryServices.includes('sonarr'),
      probe: async () => {
        if (!hasText(CONFIG.SONARR_API_KEY)) return { status: 'unconfigured', reason: 'missing_api_key' };
        await fetchWithTimeout(`${CONFIG.SONARR_HOST}/api/v3/system/status?apikey=${CONFIG.SONARR_API_KEY}`, 3000);
        return { status: 'up', reason: 'ready', reachable: true, healthy: true };
      },
    },
    {
      name: 'lidarr',
      url: CONFIG.LIDARR_HOST,
      configured: hasText(CONFIG.LIDARR_API_KEY),
      expectedBySetup: expectedServiceSet.has('lidarr'),
      requiredForSetup: expectedLibraryServices.includes('lidarr'),
      probe: async () => {
        if (!hasText(CONFIG.LIDARR_API_KEY)) return { status: 'unconfigured', reason: 'missing_api_key' };
        await fetchWithTimeout(`${CONFIG.LIDARR_HOST}/api/v1/system/status?apikey=${CONFIG.LIDARR_API_KEY}`, 3000);
        return { status: 'up', reason: 'ready', reachable: true, healthy: true };
      },
    },
    {
      name: 'prowlarr',
      url: CONFIG.PROWLARR_HOST,
      configured: hasText(CONFIG.PROWLARR_API_KEY),
      expectedBySetup: expectedServiceSet.has('prowlarr') || hasText(CONFIG.PROWLARR_API_KEY),
      requiredForSetup: false,
      probe: async () => {
        if (!hasText(CONFIG.PROWLARR_API_KEY)) return { status: 'unconfigured', reason: 'missing_api_key' };
        await fetchWithTimeout(`${CONFIG.PROWLARR_HOST}/api/v1/system/status?apikey=${CONFIG.PROWLARR_API_KEY}`, 3000);
        return { status: 'up', reason: 'ready', reachable: true, healthy: true };
      },
    },
    {
      name: 'slskd',
      url: CONFIG.SLSKD_HOST,
      configured: hasText(CONFIG.SLSKD_API_KEY),
      expectedBySetup: expectedServiceSet.has('slskd') || hasText(CONFIG.SLSKD_API_KEY),
      requiredForSetup: false,
      probe: async () => {
        if (!hasText(CONFIG.SLSKD_API_KEY)) return { status: 'unconfigured', reason: 'missing_api_key' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const resp = await fetch(`${CONFIG.SLSKD_HOST}/api/v0/application`, {
            headers: { 'X-API-Key': CONFIG.SLSKD_API_KEY },
            signal: controller.signal,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return { status: 'up', reason: 'ready', reachable: true, healthy: true };
        } finally {
          clearTimeout(timer);
        }
      },
    },
    {
      name: 'qbittorrent',
      url: CONFIG.QBITTORRENT_HOST,
      configured: hasQbittorrentCredentials(),
      expectedBySetup: expectedServiceSet.has('qbittorrent') || hasQbittorrentCredentials(),
      requiredForSetup: false,
      probe: async () => {
        if (!hasQbittorrentCredentials()) {
          try {
            const version = await probeQbittorrentVersion(3000);
            return {
              status: 'unconfigured',
              reason: 'missing_credentials',
              reachable: true,
              version,
            };
          } catch (error) {
            return {
              status: 'unconfigured',
              reason: 'missing_credentials',
              reachable: false,
              error: expectedServiceSet.has('qbittorrent') ? error.message : undefined,
            };
          }
        }

        try {
          const version = (await qbFetchText('/api/v2/app/version', { timeoutMs: 3000 })).trim();
          return { status: 'up', reason: 'ready', reachable: true, healthy: true, version };
        } catch (error) {
          try {
            const version = await probeQbittorrentVersion(3000);
            return {
              status: 'down',
              reason: 'authentication_failed',
              reachable: true,
              healthy: false,
              version,
              error: error.message,
            };
          } catch {
            throw error;
          }
        }
      },
    },
  ];

  const services = Object.fromEntries(
    await Promise.all(serviceDefinitions.map(async (definition) => (
      [definition.name, await resolveServiceStatus(definition)]
    )))
  );

  const summary = {
    up: 0,
    down: 0,
    unconfigured: 0,
    required: { up: 0, down: 0, unconfigured: 0 },
    optional: { up: 0, down: 0, unconfigured: 0 },
  };
  for (const service of Object.values(services)) {
    incrementSummaryBucket(summary, service.status);
    incrementSummaryBucket(
      service.expectedBySetup || service.requiredForSetup ? summary.required : summary.optional,
      service.status
    );
  }

  const readyLibraryServices = expectedLibraryServices.filter((name) => services[name]?.status === 'up');
  const downLibraryServices = expectedLibraryServices.filter((name) => services[name]?.status === 'down');
  const unconfiguredLibraryServices = expectedLibraryServices.filter((name) => services[name]?.status === 'unconfigured');
  const setupComplete = expectedLibraryServices.length > 0
    && readyLibraryServices.length === expectedLibraryServices.length
    && installerProgress.explicitFailed !== true
    && installerProgress.explicitInProgress !== true
    && installerProgress.explicitComplete !== false;
  const setupRequired = !setupComplete;
  const setupStatus = setupComplete
    ? 'complete'
    : installerProgress.explicitFailed === true || installerProgress.lastError
      ? 'error'
      : installerProgress.explicitInProgress === true
        ? 'in_progress'
        : expectedLibraryServices.length === 0
          ? 'unconfigured'
          : downLibraryServices.length > 0
            ? 'degraded'
            : unconfiguredLibraryServices.length > 0
              ? 'unconfigured'
              : 'waiting_for_services';
  const hasIssues = Object.values(services).some((service) => {
    if (service.status === 'down') return service.expectedBySetup || service.configured;
    if (service.status === 'unconfigured') return service.expectedBySetup || service.requiredForSetup;
    return false;
  }) || installerProgress.explicitFailed === true;

  res.json({
    services,
    summary,
    setupRequired,
    setupComplete,
    setup: {
      mode: installerState?.managed === true ? 'managed' : configuredLibraryServices.length > 0 ? 'manual' : 'unconfigured',
      managed: installerState?.managed === true,
      status: setupStatus,
      required: setupRequired,
      complete: setupComplete,
      phase: installerProgress.phase,
      installerState: {
        complete: installerProgress.explicitComplete === true,
        failed: installerProgress.explicitFailed === true,
        inProgress: installerProgress.explicitInProgress === true,
        lastError: installerProgress.lastError,
      },
      library: {
        expectedServices: expectedLibraryServices,
        configuredServices: configuredLibraryServices,
        readyServices: readyLibraryServices,
        downServices: downLibraryServices,
        unconfiguredServices: unconfiguredLibraryServices,
      },
    },
    hasIssues,
    timestamp: new Date().toISOString(),
  });
});

export default router;
