import { posix as pathPosix } from 'path';
import { Router } from 'express';
import Docker from 'dockerode';
import crypto from 'crypto';
import { parseStringPromise } from 'xml2js';
import { CONFIG } from '../config.js';
import {
  InstallerConflictError,
  InstallerDisabledError,
  InstallerExecutionError,
  InstallerValidationError,
  wrapRouter,
} from '../errors.js';
import {
  ensureSetupBootstrapToken,
  readInstallerState,
  writeInstallerState,
} from '../installerState.js';

const router = wrapRouter(Router());
const docker = new Docker({ socketPath: CONFIG.DOCKER_SOCKET });
const INSTALLER_NETWORK = 'arr-network';
const INSTALLER_LABEL = 'com.vibarr.managed';
const INSTALLER_STACK_LABEL = 'com.vibarr.stack';
const DEFAULT_STACK_LABEL = 'default';
const SETUP_TOKEN_ENV_NAME = 'SETUP_BOOTSTRAP_TOKEN';
const ALLOWED_SERVICES = ['radarr', 'sonarr', 'lidarr', 'prowlarr', 'qbittorrent', 'slskd'];
const LIBRARY_SERVICES = ['radarr', 'sonarr', 'lidarr'];
const QB_USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const GENERIC_USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const VALID_TIMEZONES = typeof Intl.supportedValuesOf === 'function'
  ? new Set(Intl.supportedValuesOf('timeZone'))
  : null;
const DEFAULT_PORTS = {
  radarr: 7878,
  sonarr: 8989,
  lidarr: 8686,
  prowlarr: 9696,
  qbittorrent: 8080,
  slskd: 5030,
  slskdSoulseek: 2234,
};

const DEFAULT_SETUP = {
  basePath: '/docker',
  timezone: 'Etc/UTC',
  puid: 1000,
  pgid: 1000,
  services: {
    radarr: true,
    sonarr: true,
    lidarr: true,
    prowlarr: true,
    qbittorrent: true,
    slskd: false,
  },
  qbittorrent: {
    username: 'server',
    password: '',
  },
  slskd: {
    username: '',
    password: '',
    webUsername: 'slskd',
    webPassword: '',
  },
};

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => {
    if (/pass|password|secret|token|api[_-]?key/i.test(key)) {
      return [key, '[redacted]'];
    }
    return [key, redactSecrets(nestedValue)];
  }));
}

function logInstallerEvent(level, event, fields = {}) {
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  logger(JSON.stringify({
    scope: 'installer',
    level,
    event,
    at: new Date().toISOString(),
    ...redactSecrets(fields),
  }));
}

function randomSecret(length = 20) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

function qbPasswordHash(password) {
  const salt = crypto.randomUUID({ disableEntropyCache: true });
  const saltBytes = Buffer.from(salt.replace(/-/g, ''), 'hex');
  const hash = crypto.pbkdf2Sync(Buffer.from(password, 'utf-8'), saltBytes, 100000, 64, 'sha512');
  return `${saltBytes.toString('base64')}:${hash.toString('base64')}`;
}

function sanitizeServices(input = {}) {
  const services = {};
  for (const service of ALLOWED_SERVICES) {
    services[service] = input[service] === undefined ? DEFAULT_SETUP.services[service] : input[service];
  }
  return services;
}

function safeTrimmedString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeSetupPayload(body = {}) {
  return {
    basePath: safeTrimmedString(body.basePath, DEFAULT_SETUP.basePath).replace(/\/+$/, '') || DEFAULT_SETUP.basePath,
    timezone: safeTrimmedString(body.timezone, DEFAULT_SETUP.timezone) || DEFAULT_SETUP.timezone,
    puid: body.puid === undefined || body.puid === null || body.puid === ''
      ? DEFAULT_SETUP.puid
      : Number(body.puid),
    pgid: body.pgid === undefined || body.pgid === null || body.pgid === ''
      ? DEFAULT_SETUP.pgid
      : Number(body.pgid),
    services: sanitizeServices(body.services && typeof body.services === 'object' ? body.services : {}),
    qbittorrent: {
      username: safeTrimmedString(body.qbittorrent?.username, DEFAULT_SETUP.qbittorrent.username) || DEFAULT_SETUP.qbittorrent.username,
      password: typeof body.qbittorrent?.password === 'string' ? body.qbittorrent.password : '',
    },
    slskd: {
      username: safeTrimmedString(body.slskd?.username, ''),
      password: typeof body.slskd?.password === 'string' ? body.slskd.password : '',
      webUsername: safeTrimmedString(body.slskd?.webUsername, DEFAULT_SETUP.slskd.webUsername) || DEFAULT_SETUP.slskd.webUsername,
      webPassword: typeof body.slskd?.webPassword === 'string' ? body.slskd.webPassword : '',
    },
  };
}

function assertStringWithoutControls(value, field, issues, { allowEmpty = false, maxLength = 128, pattern } = {}) {
  if (typeof value !== 'string') {
    issues.push({ field, message: 'Must be a string.' });
    return;
  }
  if (!allowEmpty && value.trim() === '') {
    issues.push({ field, message: 'Must not be empty.' });
    return;
  }
  if (value.length > maxLength) {
    issues.push({ field, message: `Must be at most ${maxLength} characters.` });
  }
  if (CONTROL_CHAR_PATTERN.test(value)) {
    issues.push({ field, message: 'Must not contain control characters.' });
    return;
  }
  if (pattern && value && !pattern.test(value)) {
    issues.push({ field, message: 'Contains unsupported characters.' });
  }
}

function validateTimezone(timezone, issues) {
  if (typeof timezone !== 'string' || timezone.trim() === '') {
    issues.push({ field: 'timezone', message: 'Timezone is required.' });
    return;
  }
  if (CONTROL_CHAR_PATTERN.test(timezone)) {
    issues.push({ field: 'timezone', message: 'Timezone must not contain control characters.' });
    return;
  }
  if (VALID_TIMEZONES && !VALID_TIMEZONES.has(timezone) && timezone !== 'Etc/UTC') {
    issues.push({ field: 'timezone', message: 'Timezone must be a valid IANA timezone.' });
    return;
  }
  if (!VALID_TIMEZONES && !/^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(timezone)) {
    issues.push({ field: 'timezone', message: 'Timezone must be a valid IANA timezone.' });
  }
}

function validateAbsoluteBasePath(basePath, issues) {
  if (typeof basePath !== 'string' || basePath.trim() === '') {
    issues.push({ field: 'basePath', message: 'Base path is required.' });
    return;
  }
  if (CONTROL_CHAR_PATTERN.test(basePath)) {
    issues.push({ field: 'basePath', message: 'Base path must not contain control characters.' });
    return;
  }
  if (!basePath.startsWith('/')) {
    issues.push({ field: 'basePath', message: 'Base path must be an absolute path.' });
    return;
  }
  const normalized = pathPosix.normalize(basePath);
  if (normalized !== basePath) {
    issues.push({ field: 'basePath', message: 'Base path must already be normalized.' });
  }
}

function validateNumericId(value, field, issues) {
  if (!Number.isInteger(value)) {
    issues.push({ field, message: 'Must be an integer.' });
    return;
  }
  if (value < 0 || value > 65535) {
    issues.push({ field, message: 'Must be between 0 and 65535.' });
  }
}

function validateServiceSelection(services, issues) {
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    issues.push({ field: 'services', message: 'Services must be an object keyed by service name.' });
    return;
  }
  for (const [service, enabled] of Object.entries(services)) {
    if (!ALLOWED_SERVICES.includes(service)) {
      issues.push({ field: `services.${service}`, message: 'Unknown service.' });
    }
  }
  for (const service of ALLOWED_SERVICES) {
    if (!(service in services)) {
      issues.push({ field: `services.${service}`, message: 'Must be provided as a boolean.' });
    } else if (typeof services[service] !== 'boolean') {
      issues.push({ field: `services.${service}`, message: 'Must be a boolean.' });
    }
  }
}

function normalizeEnabledServices(input) {
  return ALLOWED_SERVICES.filter((service) => input?.[service] === true);
}

function validateSetupPayload(body = {}) {
  const rawServices = body.services && typeof body.services === 'object' && !Array.isArray(body.services) ? body.services : {};
  const normalized = normalizeSetupPayload(body);
  normalized.services = sanitizeServices(rawServices);

  const issues = [];
  validateServiceSelection(rawServices, issues);
  validateAbsoluteBasePath(normalized.basePath, issues);
  validateTimezone(normalized.timezone, issues);
  validateNumericId(normalized.puid, 'puid', issues);
  validateNumericId(normalized.pgid, 'pgid', issues);
  assertStringWithoutControls(normalized.qbittorrent.username, 'qbittorrent.username', issues, { maxLength: 32, pattern: QB_USERNAME_PATTERN });
  assertStringWithoutControls(normalized.qbittorrent.password, 'qbittorrent.password', issues, { allowEmpty: true, maxLength: 128 });
  assertStringWithoutControls(normalized.slskd.username, 'slskd.username', issues, { allowEmpty: true, maxLength: 64, pattern: GENERIC_USERNAME_PATTERN });
  assertStringWithoutControls(normalized.slskd.password, 'slskd.password', issues, { allowEmpty: true, maxLength: 128 });
  assertStringWithoutControls(normalized.slskd.webUsername, 'slskd.webUsername', issues, { maxLength: 64, pattern: GENERIC_USERNAME_PATTERN });
  assertStringWithoutControls(normalized.slskd.webPassword, 'slskd.webPassword', issues, { allowEmpty: true, maxLength: 128 });

  if (normalized.services.qbittorrent !== true) {
    issues.push({ field: 'services.qbittorrent', message: 'qBittorrent is required for the one-click installer.' });
  }

  const requestedLibraryServices = LIBRARY_SERVICES.filter((service) => normalized.services[service]);
  if (requestedLibraryServices.length === 0) {
    issues.push({ field: 'services', message: 'Enable at least one library service: radarr, sonarr, or lidarr.' });
  }

  if (normalized.services.slskd && normalized.slskd.username && !normalized.slskd.password) {
    issues.push({ field: 'slskd.password', message: 'Soulseek password is required when a Soulseek username is supplied.' });
  }
  if (normalized.services.slskd && !normalized.slskd.username && normalized.slskd.password) {
    issues.push({ field: 'slskd.username', message: 'Soulseek username is required when a Soulseek password is supplied.' });
  }

  if (issues.length > 0) {
    throw new InstallerValidationError('Installer payload validation failed', { issues });
  }

  return normalized;
}

function serviceRuntimeConfig(keys) {
  return Object.fromEntries(Object.entries(keys).filter(([, value]) => value != null && value !== ''));
}

function containerNameFor(service) {
  return service;
}

async function inspectContainer(name) {
  try {
    return await docker.getContainer(name).inspect();
  } catch {
    return null;
  }
}

async function containerExists(name) {
  return Boolean(await inspectContainer(name));
}

async function getContainerOwnership(service) {
  const inspect = await inspectContainer(containerNameFor(service));
  if (!inspect) {
    return { exists: false, managedByInstaller: false, conflict: false, running: false };
  }
  const managedByInstaller = inspect?.Config?.Labels?.[INSTALLER_LABEL] === 'true';
  return {
    exists: true,
    managedByInstaller,
    conflict: !managedByInstaller,
    running: Boolean(inspect?.State?.Running),
  };
}

async function getExistingConflicts(selectedServices = ALLOWED_SERVICES) {
  const services = Array.isArray(selectedServices) ? selectedServices : normalizeEnabledServices(selectedServices);
  const conflicts = [];
  for (const service of services) {
    const ownership = await getContainerOwnership(service);
    if (ownership.conflict) conflicts.push(service);
  }
  return conflicts;
}

async function ensureNetwork(name) {
  try {
    await docker.getNetwork(name).inspect();
  } catch {
    await docker.createNetwork({ Name: name });
  }
}

async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {}
  const stream = await docker.pull(image);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

async function ensureContainer(spec) {
  try {
    const existing = docker.getContainer(spec.name);
    await existing.inspect();
    return existing;
  } catch {}
  return docker.createContainer({
    name: spec.name,
    Image: spec.image,
    Env: spec.env,
    ExposedPorts: spec.exposedPorts,
    Labels: {
      [INSTALLER_LABEL]: 'true',
      [INSTALLER_STACK_LABEL]: DEFAULT_STACK_LABEL,
      'com.vibarr.service': spec.service,
    },
    HostConfig: {
      Binds: spec.binds,
      PortBindings: spec.portBindings,
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [INSTALLER_NETWORK]: {
          Aliases: [spec.name],
        },
      },
    },
  });
}

async function startContainer(container) {
  const inspect = await container.inspect();
  if (!inspect.State.Running) await container.start();
}

async function restartContainer(container) {
  try {
    await container.restart();
  } catch {
    await container.stop({ t: 10 }).catch(() => {});
    await container.start();
  }
}

async function execInContainer(container, command) {
  const exec = await container.exec({
    Cmd: ['sh', '-lc', command],
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = await exec.start({ Tty: true });
  let stdout = '';
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const inspect = await exec.inspect();
  if (inspect.ExitCode !== 0) {
    throw new InstallerExecutionError(`Command failed in container ${container.id}`, {
      code: 'INSTALLER_CONTAINER_COMMAND_FAILED',
      publicMessage: 'Setup failed while preparing container configuration files.',
      logDetails: { command, output: stdout.trim(), exitCode: inspect.ExitCode, containerId: container.id },
    });
  }
  return stdout.trim();
}

async function writeContainerFile(container, filePath, content) {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  const dir = filePath.split('/').slice(0, -1).join('/') || '/';
  await execInContainer(
    container,
    `mkdir -p '${dir}' && printf '%s' '${encoded}' | base64 -d > '${filePath}'`,
  );
}

async function waitForHttp(url, { timeoutMs = 120000, stepMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.ok || response.status === 401 || response.status === 403) return;
      } finally {
        clearTimeout(timer);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new InstallerExecutionError(`Timed out waiting for ${url}`, {
    code: 'INSTALLER_WAIT_TIMEOUT',
    publicMessage: 'A setup service took too long to become reachable.',
    retryable: true,
    logDetails: { url, timeoutMs, stepMs },
  });
}

async function readArrApiKey(containerName) {
  const container = docker.getContainer(containerName);
  const xml = await execInContainer(container, 'cat /config/config.xml');
  const parsed = await parseStringPromise(xml);
  const apiKey = parsed?.Config?.ApiKey?.[0];
  if (!apiKey) {
    throw new InstallerExecutionError(`Missing API key in ${containerName} config`, {
      code: 'INSTALLER_API_KEY_MISSING',
      publicMessage: 'Setup could not read a required Arr API key from a newly started service.',
      logDetails: { containerName },
    });
  }
  return apiKey;
}

async function readArrApiKeyWhenReady(containerName, url) {
  await waitForHttp(url);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      return await readArrApiKey(containerName);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new InstallerExecutionError(`Timed out waiting for ${containerName} API key`, {
    code: 'INSTALLER_API_KEY_TIMEOUT',
    publicMessage: 'A newly started service did not finish initializing in time.',
    retryable: true,
    logDetails: { containerName, url },
  });
}

async function ensureDataDirectories(container) {
  await execInContainer(
    container,
    [
      'mkdir -p /data/movies',
      'mkdir -p /data/tv',
      'mkdir -p /data/music',
      'mkdir -p /data/downloads',
      'mkdir -p /data/downloads/incomplete',
      'mkdir -p /data/downloads/slskd',
      'mkdir -p /data/configs',
    ].join(' && '),
  );
}

async function ensureRootFolder(service, host, apiKey, targetPath) {
  const version = service === 'lidarr' ? 'v1' : 'v3';
  const rootUrl = `${host}/api/${version}/rootfolder?apikey=${apiKey}`;
  const existing = await fetch(rootUrl).then((res) => res.json());
  if (Array.isArray(existing) && existing.some((folder) => folder.path === targetPath)) return;

  let payload = { path: targetPath };
  if (service === 'lidarr') {
    const [qualityProfiles, metadataProfiles] = await Promise.all([
      fetch(`${host}/api/v1/qualityprofile?apikey=${apiKey}`).then((res) => res.json()),
      fetch(`${host}/api/v1/metadataprofile?apikey=${apiKey}`).then((res) => res.json()),
    ]);
    payload = {
      name: targetPath.split('/').filter(Boolean).pop() || 'music',
      path: targetPath,
      defaultQualityProfileId: qualityProfiles?.[0]?.id || 1,
      defaultMetadataProfileId: metadataProfiles?.[0]?.id || 1,
      defaultMonitorOption: 'all',
      defaultNewItemMonitorOption: 'all',
      defaultTags: [],
    };
  }

  const response = await fetch(rootUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new InstallerExecutionError(`${service} root folder create failed`, {
      code: 'INSTALLER_ROOT_FOLDER_FAILED',
      publicMessage: `Setup could not create the ${service} root folder.`,
      logDetails: { service, targetPath, status: response.status },
    });
  }
}

function qbitField(name, value) {
  return { name, value };
}

async function ensureDownloadClient(service, host, apiKey, qbConfig) {
  const version = service === 'lidarr' ? 'v1' : 'v3';
  const endpoint = `${host}/api/${version}/downloadclient?apikey=${apiKey}`;
  const existing = await fetch(endpoint).then((res) => res.json());
  if (Array.isArray(existing) && existing.some((client) => client.implementation === 'QBittorrent')) return;

  const categoryField =
    service === 'radarr'
      ? qbitField('movieCategory', 'radarr')
      : service === 'sonarr'
        ? qbitField('tvCategory', 'tv')
        : qbitField('musicCategory', 'lidarr');

  const importedCategoryField =
    service === 'radarr'
      ? qbitField('movieImportedCategory', '')
      : service === 'sonarr'
        ? qbitField('tvImportedCategory', '')
        : qbitField('musicImportedCategory', '');

  const payload = {
    enable: true,
    protocol: 'torrent',
    priority: 1,
    removeCompletedDownloads: true,
    removeFailedDownloads: true,
    name: 'qBittorrent',
    implementation: 'QBittorrent',
    implementationName: 'qBittorrent',
    configContract: 'QBittorrentSettings',
    tags: [],
    fields: [
      qbitField('host', 'qbittorrent'),
      qbitField('port', DEFAULT_PORTS.qbittorrent),
      qbitField('useSsl', false),
      qbitField('urlBase', ''),
      qbitField('username', qbConfig.username),
      qbitField('password', qbConfig.password),
      categoryField,
      importedCategoryField,
      qbitField(service === 'radarr' ? 'recentMoviePriority' : service === 'sonarr' ? 'recentTvPriority' : 'recentMusicPriority', 0),
      qbitField(service === 'radarr' ? 'olderMoviePriority' : service === 'sonarr' ? 'olderTvPriority' : 'olderMusicPriority', 0),
      qbitField('initialState', 0),
      qbitField('sequentialOrder', service === 'radarr'),
      qbitField('firstAndLast', service === 'radarr'),
      qbitField('contentLayout', 0),
    ],
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new InstallerExecutionError(`${service} download client create failed`, {
      code: 'INSTALLER_DOWNLOAD_CLIENT_FAILED',
      publicMessage: `Setup could not connect ${service} to qBittorrent.`,
      logDetails: { service, status: response.status },
    });
  }
}

async function configureProwlarrApplication(host, apiKey, targetService, targetApiKey, categories) {
  const endpoint = `${host}/api/v1/applications?apikey=${apiKey}`;
  const existing = await fetch(endpoint).then((res) => res.json());
  if (Array.isArray(existing) && existing.some((app) => app.implementation?.toLowerCase() === targetService)) return;

  const baseUrl = `http://${targetService}:${
    targetService === 'radarr' ? DEFAULT_PORTS.radarr :
    targetService === 'sonarr' ? DEFAULT_PORTS.sonarr :
    DEFAULT_PORTS.lidarr
  }`;
  const implementationName = targetService[0].toUpperCase() + targetService.slice(1);
  const payload = {
    syncLevel: 'fullSync',
    enable: true,
    name: implementationName,
    implementation: implementationName,
    implementationName,
    configContract: `${implementationName}Settings`,
    fields: [
      { name: 'prowlarrUrl', value: 'http://prowlarr:9696' },
      { name: 'baseUrl', value: baseUrl },
      { name: 'apiKey', value: targetApiKey },
      { name: 'syncCategories', value: categories },
    ],
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new InstallerExecutionError(`Prowlarr ${targetService} app create failed`, {
      code: 'INSTALLER_PROWLARR_WIRING_FAILED',
      publicMessage: 'Prowlarr could not finish linking one or more Arr services.',
      logDetails: { targetService, status: response.status },
    });
  }
}

function qbConfigText({ username, passwordHash }) {
  return `[BitTorrent]
Session\\AddTorrentStopped=false
Session\\DefaultSavePath=/data/downloads
Session\\Port=6881
Session\\QueueingSystemEnabled=false
Session\\RefreshInterval=1000
Session\\TempPath=/data/downloads/incomplete

[Core]
AutoDeleteAddedTorrentFile=Never

[LegalNotice]
Accepted=true

[Meta]
MigrationVersion=8

[Preferences]
Connection\\PortRangeMin=6881
Downloads\\SavePath=/data/downloads/
Downloads\\TempPath=/data/downloads/incomplete/
WebUI\\Address=*
WebUI\\LocalHostAuth=false
WebUI\\Password_PBKDF2="@ByteArray(${passwordHash})"
WebUI\\ServerDomains=*
WebUI\\Username=${username}
`;
}

function yamlString(value) {
  return JSON.stringify(typeof value === 'string' ? value : '');
}

function slskdConfigText({ soulseekUsername, soulseekPassword, webUsername, webPassword, apiKey }) {
  const lines = [
    'remote_configuration: true',
    '',
    'directories:',
    '  incomplete: /downloads/incomplete',
    '  downloads: /downloads/slskd',
    '',
    'soulseek:',
    `  username: ${yamlString(soulseekUsername)}`,
    `  password: ${yamlString(soulseekPassword)}`,
    `  listen_port: ${DEFAULT_PORTS.slskdSoulseek}`,
    '',
    'web:',
    '  authentication:',
    `    username: ${yamlString(webUsername)}`,
    `    password: ${yamlString(webPassword)}`,
    '    api_keys:',
    '      arr_dashboard:',
    `        key: ${yamlString(apiKey)}`,
    '        role: readwrite',
    '        cidr: 0.0.0.0/0,::/0',
  ];
  return `${lines.join('\n')}\n`;
}

function serviceSpec(setup, service) {
  const base = setup.basePath;
  const commonEnv = [`PUID=${setup.puid}`, `PGID=${setup.pgid}`, `TZ=${setup.timezone}`];
  switch (service) {
    case 'radarr':
      return {
        service,
        name: 'radarr',
        image: 'lscr.io/linuxserver/radarr:latest',
        env: commonEnv,
        binds: [`${base}/configs/radarr:/config`, `${base}:/data`],
        exposedPorts: { '7878/tcp': {} },
        portBindings: { '7878/tcp': [{ HostIp: '127.0.0.1', HostPort: String(DEFAULT_PORTS.radarr) }] },
      };
    case 'sonarr':
      return {
        service,
        name: 'sonarr',
        image: 'lscr.io/linuxserver/sonarr:latest',
        env: commonEnv,
        binds: [`${base}/configs/sonarr:/config`, `${base}:/data`],
        exposedPorts: { '8989/tcp': {} },
        portBindings: { '8989/tcp': [{ HostIp: '127.0.0.1', HostPort: String(DEFAULT_PORTS.sonarr) }] },
      };
    case 'lidarr':
      return {
        service,
        name: 'lidarr',
        image: 'lscr.io/linuxserver/lidarr:latest',
        env: commonEnv,
        binds: [`${base}/configs/lidarr:/config`, `${base}:/data`],
        exposedPorts: { '8686/tcp': {} },
        portBindings: { '8686/tcp': [{ HostIp: '127.0.0.1', HostPort: String(DEFAULT_PORTS.lidarr) }] },
      };
    case 'prowlarr':
      return {
        service,
        name: 'prowlarr',
        image: 'lscr.io/linuxserver/prowlarr:latest',
        env: commonEnv,
        binds: [`${base}/configs/prowlarr:/config`],
        exposedPorts: { '9696/tcp': {} },
        portBindings: { '9696/tcp': [{ HostIp: '127.0.0.1', HostPort: String(DEFAULT_PORTS.prowlarr) }] },
      };
    case 'qbittorrent':
      return {
        service,
        name: 'qbittorrent',
        image: 'lscr.io/linuxserver/qbittorrent:latest',
        env: [...commonEnv, 'WEBUI_PORT=8080', 'TORRENTING_PORT=6881'],
        binds: [`${base}/configs/qbittorrent:/config`, `${base}:/data`],
        exposedPorts: { '8080/tcp': {}, '6881/tcp': {}, '6881/udp': {} },
        portBindings: {
          '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(DEFAULT_PORTS.qbittorrent) }],
          '6881/tcp': [{ HostIp: '127.0.0.1', HostPort: '6881' }],
          '6881/udp': [{ HostIp: '127.0.0.1', HostPort: '6881' }],
        },
      };
    case 'slskd':
      return {
        service,
        name: 'slskd',
        image: 'slskd/slskd:latest',
        env: ['SLSKD_REMOTE_CONFIGURATION=true'],
        binds: [`${base}/configs/slskd:/app`, `${base}/music:/music`, `${base}/downloads:/downloads`],
        exposedPorts: { '5030/tcp': {}, '2234/tcp': {} },
        portBindings: {
          '5030/tcp': [{ HostIp: '127.0.0.1', HostPort: String(DEFAULT_PORTS.slskd) }],
          '2234/tcp': [{ HostIp: '127.0.0.1', HostPort: String(DEFAULT_PORTS.slskdSoulseek) }],
        },
      };
    default:
      throw new InstallerValidationError(`Unknown service requested: ${service}`, {
        issues: [{ field: 'services', message: `Unknown service ${service}.` }],
      });
  }
}

async function verifyQbCredentials(username, password) {
  const response = await fetch('http://qbittorrent:8080/api/v2/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'http://qbittorrent:8080',
      Referer: 'http://qbittorrent:8080',
    },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const text = await response.text();
  if (!response.ok || text.trim() !== 'Ok.') {
    throw new InstallerExecutionError('qBittorrent credential verification failed', {
      code: 'INSTALLER_QBIT_AUTH_FAILED',
      publicMessage: 'Setup could not verify the generated qBittorrent credentials.',
      logDetails: { status: response.status, responseText: text.trim() },
    });
  }
}

function toUserSafeInstallError(error, phase) {
  if (error instanceof InstallerValidationError || error instanceof InstallerConflictError || error instanceof InstallerDisabledError) {
    return {
      code: error.code,
      message: error.publicMessage,
      phase,
      at: new Date().toISOString(),
      retryable: error.retryable,
    };
  }
  if (error instanceof InstallerExecutionError) {
    return {
      code: error.code,
      message: error.publicMessage,
      phase,
      at: new Date().toISOString(),
      retryable: error.retryable,
    };
  }
  return {
    code: 'INSTALLER_FAILED',
    message: 'Setup failed before the dashboard could finish configuring services.',
    phase,
    at: new Date().toISOString(),
    retryable: false,
  };
}

function toInstallerError(error, phase, context = {}) {
  if (error instanceof InstallerValidationError || error instanceof InstallerConflictError || error instanceof InstallerDisabledError || error instanceof InstallerExecutionError) {
    return error;
  }
  return new InstallerExecutionError(error?.message || 'Unhandled installer failure', {
    code: 'INSTALLER_FAILED',
    publicMessage: 'Setup failed before the dashboard could finish configuring services.',
    cause: error,
    logDetails: { phase, ...context, stack: error?.stack },
  });
}

function buildWarning(code, message, service, phase) {
  return {
    code,
    message,
    service,
    phase,
    at: new Date().toISOString(),
  };
}

function parseRequestedServices(queryValue) {
  if (!queryValue) return [];
  const raw = Array.isArray(queryValue) ? queryValue.join(',') : String(queryValue);
  return [...new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => ALLOWED_SERVICES.includes(value)),
  )];
}

async function updateInstallerPhase(baseState, patch, logFields = null) {
  const nextState = writeInstallerState({
    ...baseState,
    ...patch,
    setupAuth: baseState.setupAuth,
  }, { includeSecrets: true });
  if (logFields) {
    logInstallerEvent('info', 'phase_changed', {
      phase: nextState.phase,
      status: nextState.status,
      selectedServices: nextState.selectedServices,
      ...logFields,
    });
  }
  return nextState;
}

async function maybePromotePhase(state) {
  if (!state.managed) return state;
  if (state.phase === 'pending_restart') {
    const restartDeadline = state.pendingRestartUntil ? Date.parse(state.pendingRestartUntil) : 0;
    if (restartDeadline && Date.now() < restartDeadline) return state;
  }
  if (!['pending_restart', 'verifying'].includes(state.phase)) return state;

  const selectedServices = state.selectedServices.length > 0 ? state.selectedServices : normalizeEnabledServices(state.services);
  let allRunning = true;
  for (const service of selectedServices) {
    const ownership = await getContainerOwnership(service);
    if (!ownership.exists || !ownership.running) {
      allRunning = false;
      break;
    }
  }

  const nextPhase = allRunning ? 'ready' : 'verifying';
  const nextStatus = allRunning ? 'ready' : 'waiting_for_services';
  if (nextPhase === state.phase && nextStatus === state.status) return state;

  return writeInstallerState({
    ...state,
    phase: nextPhase,
    status: nextStatus,
    installFinishedAt: state.installFinishedAt || new Date().toISOString(),
    pendingRestartUntil: null,
  }, { includeSecrets: true });
}

router.get('/setup/state', async (req, res) => {
  const authState = ensureSetupBootstrapToken().setupAuth;
  let state = readInstallerState({ includeSecrets: true });
  state = await maybePromotePhase(state);
  const requestedServices = parseRequestedServices(req.query.services);
  const allConflicts = await getExistingConflicts();
  const selectedServices = state.selectedServices.length > 0
    ? state.selectedServices
    : requestedServices.length > 0
      ? requestedServices
      : normalizeEnabledServices(DEFAULT_SETUP.services);
  const selectionConflicts = await getExistingConflicts(selectedServices);
  const existing = {};
  for (const service of ALLOWED_SERVICES) {
    existing[service] = await getContainerOwnership(service);
  }

  const installerEnabled = CONFIG.INSTALLER_ENABLED === true;
  const publicState = readInstallerState();

  res.json({
    managed: Boolean(publicState.managed),
    installedAt: publicState.installedAt,
    phase: publicState.phase,
    status: publicState.status,
    setup: publicState.setup,
    services: publicState.services,
    selectedServices: publicState.selectedServices,
    warnings: publicState.warnings,
    lastInstallError: publicState.lastInstallError,
    authRequired: installerEnabled,
    auth: {
      required: installerEnabled,
      tokenHeader: authState?.tokenHeader || 'X-Setup-Token',
      tokenEnvVar: authState?.tokenEnvVar || SETUP_TOKEN_ENV_NAME,
      tokenConfigured: Boolean(authState?.tokenConfigured),
      tokenSource: authState?.tokenSource || 'none',
    },
    installerEnabled,
    canBootstrap: installerEnabled && selectionConflicts.length === 0,
    conflicts: allConflicts,
    selectionConflicts,
    existing,
    defaults: DEFAULT_SETUP,
  });
});

router.post('/setup/install', async (req, res) => {
  if (!CONFIG.INSTALLER_ENABLED) {
    throw new InstallerDisabledError();
  }

  const setup = validateSetupPayload(req.body);
  const enabledServices = normalizeEnabledServices(setup.services);
  const conflicts = await getExistingConflicts(enabledServices);
  if (conflicts.length > 0) {
    logInstallerEvent('warn', 'install_rejected_conflict', { conflicts, selectedServices: enabledServices });
    throw new InstallerConflictError(conflicts);
  }

  let state = ensureSetupBootstrapToken();
  const qbPassword = setup.qbittorrent.password || randomSecret(20);
  const qbPasswordDigest = qbPasswordHash(qbPassword);
  const slskApiKey = randomSecret(32);
  const slskWebPassword = setup.slskd.webPassword || randomSecret(18);
  const warnings = [];
  let currentPhase = 'installing';

  state = await updateInstallerPhase(state, {
    managed: false,
    phase: 'installing',
    status: 'preparing',
    setup,
    services: setup.services,
    selectedServices: enabledServices,
    warnings: [],
    lastInstallError: null,
    installStartedAt: new Date().toISOString(),
    installFinishedAt: null,
    pendingRestartUntil: null,
  }, { selectedServices: enabledServices });

  logInstallerEvent('info', 'install_started', {
    selectedServices: enabledServices,
    setup,
    authRequired: true,
    tokenHeader: state.setupAuth?.tokenHeader,
  });

  try {
    await ensureNetwork(INSTALLER_NETWORK);

    for (const service of enabledServices) {
      logInstallerEvent('info', 'service_prepare_start', { service });
      const spec = serviceSpec(setup, service);
      await ensureImage(spec.image);
      const container = await ensureContainer(spec);
      await startContainer(container);
      logInstallerEvent('info', 'service_prepare_complete', { service });
    }

    const qbContainer = docker.getContainer('qbittorrent');
    await waitForHttp('http://qbittorrent:8080');
    await ensureDataDirectories(qbContainer);
    await writeContainerFile(
      qbContainer,
      '/config/qBittorrent/qBittorrent.conf',
      qbConfigText({ username: setup.qbittorrent.username, passwordHash: qbPasswordDigest }),
    );
    await restartContainer(qbContainer);
    await waitForHttp('http://qbittorrent:8080');
    await verifyQbCredentials(setup.qbittorrent.username, qbPassword);

    if (setup.services.slskd) {
      const slskdContainer = docker.getContainer('slskd');
      await waitForHttp('http://slskd:5030');
      await writeContainerFile(
        slskdContainer,
        '/app/slskd.yml',
        slskdConfigText({
          soulseekUsername: setup.slskd.username,
          soulseekPassword: setup.slskd.password,
          webUsername: setup.slskd.webUsername,
          webPassword: slskWebPassword,
          apiKey: slskApiKey,
        }),
      );
      await restartContainer(slskdContainer);
      await waitForHttp('http://slskd:5030');
    }

    state = await updateInstallerPhase(state, {
      phase: 'verifying',
      status: 'discovering_credentials',
    }, { selectedServices: enabledServices });
    currentPhase = 'verifying';

    const runtimeConfig = serviceRuntimeConfig({
      QBITTORRENT_HOST: 'http://qbittorrent:8080',
      QBITTORRENT_USER: setup.qbittorrent.username,
      QBITTORRENT_PASS: qbPassword,
    });

    const radarrApiKey = setup.services.radarr ? await readArrApiKeyWhenReady('radarr', 'http://radarr:7878') : '';
    const sonarrApiKey = setup.services.sonarr ? await readArrApiKeyWhenReady('sonarr', 'http://sonarr:8989') : '';
    const lidarrApiKey = setup.services.lidarr ? await readArrApiKeyWhenReady('lidarr', 'http://lidarr:8686') : '';
    const prowlarrApiKey = setup.services.prowlarr ? await readArrApiKeyWhenReady('prowlarr', 'http://prowlarr:9696') : '';

    if (setup.services.radarr) {
      await ensureRootFolder('radarr', 'http://radarr:7878', radarrApiKey, '/data/movies');
      await ensureDownloadClient('radarr', 'http://radarr:7878', radarrApiKey, {
        username: setup.qbittorrent.username,
        password: qbPassword,
      });
      Object.assign(runtimeConfig, {
        RADARR_HOST: 'http://radarr:7878',
        RADARR_API_KEY: radarrApiKey,
      });
    }
    if (setup.services.sonarr) {
      await ensureRootFolder('sonarr', 'http://sonarr:8989', sonarrApiKey, '/data/tv');
      await ensureDownloadClient('sonarr', 'http://sonarr:8989', sonarrApiKey, {
        username: setup.qbittorrent.username,
        password: qbPassword,
      });
      Object.assign(runtimeConfig, {
        SONARR_HOST: 'http://sonarr:8989',
        SONARR_API_KEY: sonarrApiKey,
      });
    }
    if (setup.services.lidarr) {
      await ensureRootFolder('lidarr', 'http://lidarr:8686', lidarrApiKey, '/data/music');
      await ensureDownloadClient('lidarr', 'http://lidarr:8686', lidarrApiKey, {
        username: setup.qbittorrent.username,
        password: qbPassword,
      });
      Object.assign(runtimeConfig, {
        LIDARR_HOST: 'http://lidarr:8686',
        LIDARR_API_KEY: lidarrApiKey,
      });
    }
    if (setup.services.prowlarr) {
      Object.assign(runtimeConfig, {
        PROWLARR_HOST: 'http://prowlarr:9696',
        PROWLARR_API_KEY: prowlarrApiKey,
      });
      const prowlarrTargets = [
        setup.services.radarr ? ['radarr', radarrApiKey, [2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080, 2090]] : null,
        setup.services.sonarr ? ['sonarr', sonarrApiKey, [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5060, 5070, 5080, 5090]] : null,
        setup.services.lidarr ? ['lidarr', lidarrApiKey, [3000, 3010, 3030, 3040, 3050, 3060]] : null,
      ].filter(Boolean);

      for (const [targetService, targetApiKey, categories] of prowlarrTargets) {
        try {
          await configureProwlarrApplication('http://prowlarr:9696', prowlarrApiKey, targetService, targetApiKey, categories);
        } catch (error) {
          const warning = buildWarning(
            'PROWLARR_APPLICATION_WIRING_FAILED',
            `Prowlarr could not finish linking ${targetService}. Configure that application manually after setup.`,
            targetService,
            'verifying',
          );
          warnings.push(warning);
          logInstallerEvent('warn', 'prowlarr_wiring_warning', {
            warning,
            cause: error.message,
          });
        }
      }
    }
    if (setup.services.slskd) {
      Object.assign(runtimeConfig, {
        SLSKD_HOST: 'http://slskd:5030',
        SLSKD_API_KEY: slskApiKey,
      });
    }

    state = await updateInstallerPhase(state, {
      managed: true,
      installedAt: new Date().toISOString(),
      installFinishedAt: new Date().toISOString(),
      phase: 'pending_restart',
      status: 'restart_required',
      serviceConfig: runtimeConfig,
      services: setup.services,
      selectedServices: enabledServices,
      setup,
      warnings,
      lastInstallError: null,
      pendingRestartUntil: new Date(Date.now() + 1500).toISOString(),
    }, { warningCount: warnings.length });

    res.json({
      success: true,
      restartScheduled: true,
      authRequired: true,
      auth: {
        tokenHeader: state.setupAuth?.tokenHeader || 'X-Setup-Token',
        tokenEnvVar: state.setupAuth?.tokenEnvVar || SETUP_TOKEN_ENV_NAME,
      },
      phase: state.phase,
      status: state.status,
      services: setup.services,
      selectedServices: enabledServices,
      warnings,
      credentials: {
        qbittorrent: {
          username: setup.qbittorrent.username,
          password: qbPassword,
          url: `http://localhost:${DEFAULT_PORTS.qbittorrent}`,
        },
        slskd: setup.services.slskd ? {
          username: setup.slskd.webUsername,
          password: slskWebPassword,
          apiKey: slskApiKey,
          url: `http://localhost:${DEFAULT_PORTS.slskd}`,
        } : null,
      },
    });

    logInstallerEvent('info', 'install_complete', {
      selectedServices: enabledServices,
      warnings,
      phase: state.phase,
      status: state.status,
    });

    setTimeout(() => process.exit(0), 1500);
  } catch (error) {
    const installerError = toInstallerError(error, currentPhase, { selectedServices: enabledServices });
    const lastInstallError = toUserSafeInstallError(installerError, currentPhase);
    writeInstallerState({
      ...state,
      managed: false,
      phase: 'failed',
      status: 'error',
      setup,
      services: setup.services,
      selectedServices: enabledServices,
      warnings,
      lastInstallError,
      installFinishedAt: new Date().toISOString(),
      pendingRestartUntil: null,
      setupAuth: state.setupAuth,
    }, { includeSecrets: true });

    logInstallerEvent('error', 'install_failed', {
      phase: currentPhase,
      selectedServices: enabledServices,
      error: installerError.message,
      code: installerError.code,
      details: installerError.logDetails || installerError.details,
    });

    throw installerError;
  }
});

export default router;
