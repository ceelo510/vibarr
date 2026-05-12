import { Router } from 'express';
import Docker from 'dockerode';
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CONFIG } from '../config.js';
import { fetchWithTimeout } from '../utils.js';

const router = Router();
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 16, timeout: 30000 });
const keepAliveAgentHttps = new https.Agent({ keepAlive: true, maxSockets: 16, timeout: 30000 });
const execFileAsync = promisify(execFile);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

let storageCache = null;
let storageCacheTime = 0;
const STORAGE_CACHE_TTL = 60000;

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
  let aborted = false;
  req.on('close', () => { aborted = true; });
  try {
    const containers = await docker.listContainers({ all: true });
    if (aborted) return;
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
  let aborted = false;
  req.on('close', () => { aborted = true; });
  try {
    const now = Date.now();
    if (storageCache && (now - storageCacheTime) < STORAGE_CACHE_TTL) {
      return res.json(storageCache);
    }
    if (aborted) return;
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
    if (aborted) return;
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
  const services = {};
  const qbHost = CONFIG.QBITTORRENT_HOST;
  const checks = [
    { name: 'radarr', url: CONFIG.RADARR_HOST, check: async () => {
        if (!CONFIG.RADARR_API_KEY) return 'unconfigured';
        await fetchWithTimeout(`${CONFIG.RADARR_HOST}/api/v3/system/status?apikey=${CONFIG.RADARR_API_KEY}`, 2000);
        return 'up';
    }},
    { name: 'sonarr', url: CONFIG.SONARR_HOST, check: async () => {
        if (!CONFIG.SONARR_API_KEY) return 'unconfigured';
        await fetchWithTimeout(`${CONFIG.SONARR_HOST}/api/v3/system/status?apikey=${CONFIG.SONARR_API_KEY}`, 2000);
        return 'up';
    }},
    { name: 'lidarr', url: CONFIG.LIDARR_HOST, check: async () => {
        if (!CONFIG.LIDARR_API_KEY) return 'unconfigured';
        await fetchWithTimeout(`${CONFIG.LIDARR_HOST}/api/v1/system/status?apikey=${CONFIG.LIDARR_API_KEY}`, 2000);
        return 'up';
    }},
    { name: 'slskd', url: CONFIG.SLSKD_HOST, check: async () => {
        if (!CONFIG.SLSKD_API_KEY) return 'unconfigured';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const resp = await fetch(`${CONFIG.SLSKD_HOST}/api/v0/application`, {
            headers: { 'X-API-Key': CONFIG.SLSKD_API_KEY }, signal: controller.signal, agent: keepAliveAgent,
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return 'up';
        } finally { clearTimeout(timer); }
    }},
    { name: 'qbittorrent', url: qbHost, check: async () => {
        // Version stays unauthenticated, so it is the cheapest liveness check for qBittorrent.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const resp = await fetch(`${qbHost}/api/v2/app/version`, { signal: controller.signal, agent: keepAliveAgent });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return 'up';
        } finally { clearTimeout(timer); }
    }},
  ];
  await Promise.allSettled(checks.map(async ({ name, url, check }) => {
    try {
      const status = await check();
      services[name] = { status, url: (() => { try { return new URL(url).origin; } catch { return url; } })() };
    } catch (err) {
      // Missing credentials are a setup state; thrown probe errors are normalized to "down" here.
      services[name] = { status: 'down', url: (() => { try { return new URL(url).origin; } catch { return url; } })(), error: err.message };
    }
  }));
  res.json({ services, timestamp: new Date().toISOString() });
});

export default router;
