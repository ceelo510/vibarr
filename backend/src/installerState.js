import crypto from 'crypto';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { CONFIG } from './config.js';

const DEFAULT_SETUP_TOKEN_HEADER = 'X-Setup-Token';
const SETUP_TOKEN_ENV_VARS = ['SETUP_BOOTSTRAP_TOKEN', 'INSTALLER_SETUP_TOKEN', 'INSTALLER_BOOTSTRAP_TOKEN'];
const INSTALLER_PHASES = new Set(['idle', 'installing', 'pending_restart', 'verifying', 'ready', 'failed']);

function resolveInstallerStatePath() {
  const configuredPath = CONFIG.INSTALLER_STATE_PATH;
  const explicitPath = typeof process.env.INSTALLER_STATE_PATH === 'string' && process.env.INSTALLER_STATE_PATH.trim() !== '';
  if (explicitPath) return configuredPath;
  if (!configuredPath.startsWith('/app/')) return configuredPath;
  if (existsSync(dirname(configuredPath))) return configuredPath;

  const fallbackPath = resolve(process.cwd(), 'installer-state.json');
  CONFIG.INSTALLER_STATE_PATH = fallbackPath;
  process.env.INSTALLER_STATE_PATH = fallbackPath;
  console.warn(JSON.stringify({
    scope: 'installer-state',
    event: 'path_fallback',
    at: new Date().toISOString(),
    configuredPath,
    effectivePath: fallbackPath,
  }));
  return fallbackPath;
}

resolveInstallerStatePath();

function randomSecret(length = 32) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

function sanitizeSetupSecrets(setup) {
  if (!setup || typeof setup !== 'object') return setup;
  return {
    ...setup,
    qbittorrent: setup.qbittorrent && typeof setup.qbittorrent === 'object'
      ? { ...setup.qbittorrent, password: '' }
      : setup.qbittorrent,
    slskd: setup.slskd && typeof setup.slskd === 'object'
      ? { ...setup.slskd, password: '', webPassword: '' }
      : setup.slskd,
  };
}

function sanitizeAuthState(setupAuth, includeSecrets = false) {
  if (!setupAuth || typeof setupAuth !== 'object') return setupAuth;
  return {
    required: Boolean(setupAuth.required),
    tokenHeader: typeof setupAuth.tokenHeader === 'string' ? setupAuth.tokenHeader : DEFAULT_SETUP_TOKEN_HEADER,
    tokenEnvVar: typeof setupAuth.tokenEnvVar === 'string' ? setupAuth.tokenEnvVar : SETUP_TOKEN_ENV_VARS[0],
    tokenSource: typeof setupAuth.tokenSource === 'string' ? setupAuth.tokenSource : 'none',
    tokenConfigured: Boolean(setupAuth.tokenConfigured),
    generatedAt: typeof setupAuth.generatedAt === 'string' ? setupAuth.generatedAt : null,
    bootstrapToken: includeSecrets ? (typeof setupAuth.bootstrapToken === 'string' ? setupAuth.bootstrapToken : '') : undefined,
  };
}

function sanitizeWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((warning) => warning && typeof warning === 'object')
    .map((warning) => ({
      code: typeof warning.code === 'string' ? warning.code : 'INSTALLER_WARNING',
      message: typeof warning.message === 'string' ? warning.message : 'Installer reported a warning.',
      service: typeof warning.service === 'string' ? warning.service : null,
      phase: typeof warning.phase === 'string' ? warning.phase : null,
      at: typeof warning.at === 'string' ? warning.at : null,
    }));
}

function sanitizeInstallError(lastInstallError) {
  if (!lastInstallError || typeof lastInstallError !== 'object') return null;
  return {
    code: typeof lastInstallError.code === 'string' ? lastInstallError.code : 'INSTALLER_FAILED',
    message: typeof lastInstallError.message === 'string'
      ? lastInstallError.message
      : 'Setup failed before the dashboard could finish configuring services.',
    phase: typeof lastInstallError.phase === 'string' ? lastInstallError.phase : null,
    at: typeof lastInstallError.at === 'string' ? lastInstallError.at : null,
    retryable: Boolean(lastInstallError.retryable),
  };
}

function normalizeSelectedServices(selectedServices, services) {
  if (Array.isArray(selectedServices)) {
    return selectedServices.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
  }
  if (services && typeof services === 'object') {
    return Object.entries(services)
      .filter(([, enabled]) => enabled === true)
      .map(([service]) => service);
  }
  return [];
}

function readInstallerStateFile() {
  if (!existsSync(CONFIG.INSTALLER_STATE_PATH)) return {};
  const raw = readFileSync(CONFIG.INSTALLER_STATE_PATH, 'utf-8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function resolveTokenHeaderName() {
  const candidate = typeof process.env.SETUP_TOKEN_HEADER === 'string' && process.env.SETUP_TOKEN_HEADER.trim()
    ? process.env.SETUP_TOKEN_HEADER.trim()
    : typeof process.env.INSTALLER_SETUP_TOKEN_HEADER === 'string' && process.env.INSTALLER_SETUP_TOKEN_HEADER.trim()
      ? process.env.INSTALLER_SETUP_TOKEN_HEADER.trim()
      : DEFAULT_SETUP_TOKEN_HEADER;
  return /^[A-Za-z0-9-]{1,64}$/.test(candidate) ? candidate : DEFAULT_SETUP_TOKEN_HEADER;
}

function resolveEnvSetupToken() {
  for (const envName of SETUP_TOKEN_ENV_VARS) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim()) {
      return { envName, token: value.trim(), source: 'env' };
    }
  }
  return { envName: SETUP_TOKEN_ENV_VARS[0], token: '', source: 'generated' };
}

function buildDefaultState() {
  return {
    managed: false,
    installedAt: null,
    installStartedAt: null,
    installFinishedAt: null,
    phase: 'idle',
    status: 'idle',
    serviceConfig: {},
    services: {},
    selectedServices: [],
    setup: null,
    warnings: [],
    lastInstallError: null,
    lastUpdatedAt: null,
    pendingRestartUntil: null,
    setupAuth: sanitizeAuthState({
      required: CONFIG.INSTALLER_ENABLED === true,
      tokenHeader: resolveTokenHeaderName(),
      tokenEnvVar: resolveEnvSetupToken().envName,
      tokenSource: 'none',
      tokenConfigured: false,
      generatedAt: null,
      bootstrapToken: '',
    }, true),
  };
}

function normalizeInstallerState(rawState, { includeSecrets = false } = {}) {
  const defaults = buildDefaultState();
  const envToken = resolveEnvSetupToken();
  const rawAuth = rawState?.setupAuth && typeof rawState.setupAuth === 'object' ? rawState.setupAuth : {};
  const persistedToken = typeof rawAuth.bootstrapToken === 'string' ? rawAuth.bootstrapToken : '';
  const token = envToken.token || persistedToken;
  const tokenSource = envToken.token ? 'env' : persistedToken ? 'generated' : 'none';
  const phase = INSTALLER_PHASES.has(rawState?.phase) ? rawState.phase : defaults.phase;
  const services = rawState?.services && typeof rawState.services === 'object' ? rawState.services : {};

  return {
    ...defaults,
    ...(rawState && typeof rawState === 'object' ? rawState : {}),
    phase,
    status: typeof rawState?.status === 'string' && rawState.status.trim() ? rawState.status.trim() : defaults.status,
    serviceConfig: rawState?.serviceConfig && typeof rawState.serviceConfig === 'object' ? rawState.serviceConfig : {},
    services,
    selectedServices: normalizeSelectedServices(rawState?.selectedServices, services),
    setup: includeSecrets ? rawState?.setup || null : sanitizeSetupSecrets(rawState?.setup),
    warnings: sanitizeWarnings(rawState?.warnings),
    lastInstallError: sanitizeInstallError(rawState?.lastInstallError),
    lastUpdatedAt: typeof rawState?.lastUpdatedAt === 'string' ? rawState.lastUpdatedAt : null,
    pendingRestartUntil: typeof rawState?.pendingRestartUntil === 'string' ? rawState.pendingRestartUntil : null,
    setupAuth: sanitizeAuthState({
      required: CONFIG.INSTALLER_ENABLED === true,
      tokenHeader: resolveTokenHeaderName(),
      tokenEnvVar: envToken.envName,
      tokenSource,
      tokenConfigured: Boolean(token),
      generatedAt: typeof rawAuth.generatedAt === 'string' ? rawAuth.generatedAt : null,
      bootstrapToken: token,
    }, includeSecrets),
  };
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  writeFileSync(tempPath, payload);
  try {
    renameSync(tempPath, filePath);
    return;
  } catch (error) {
    if (!['EBUSY', 'EXDEV'].includes(error?.code)) {
      try {
        unlinkSync(tempPath);
      } catch {}
      throw error;
    }

    console.warn(JSON.stringify({
      scope: 'installer-state',
      event: 'atomic_write_fallback',
      at: new Date().toISOString(),
      filePath,
      tempPath,
      code: error.code,
      message: error.message,
    }));

    writeFileSync(filePath, payload);
    try {
      unlinkSync(tempPath);
    } catch {}
  }
}

export function readInstallerState(options = {}) {
  try {
    return normalizeInstallerState(readInstallerStateFile(), options);
  } catch (error) {
    console.error('Failed to read installer state:', error.message);
    return normalizeInstallerState({}, options);
  }
}

export function writeInstallerState(nextState, options = {}) {
  const includeSecrets = options.includeSecrets === true;
  const normalized = normalizeInstallerState(nextState, { includeSecrets });
  const persisted = normalizeInstallerState(nextState, { includeSecrets: true });
  const payload = {
    ...persisted,
    lastUpdatedAt: new Date().toISOString(),
  };
  atomicWriteJson(CONFIG.INSTALLER_STATE_PATH, payload);
  return normalizeInstallerState(payload, { includeSecrets });
}

export function ensureSetupBootstrapToken() {
  const current = readInstallerState({ includeSecrets: true });
  if (!CONFIG.INSTALLER_ENABLED) return current;
  if (current.setupAuth?.tokenConfigured) return current;

  const nextState = {
    ...current,
    setupAuth: {
      ...current.setupAuth,
      required: true,
      tokenHeader: resolveTokenHeaderName(),
      tokenEnvVar: resolveEnvSetupToken().envName,
      tokenSource: 'generated',
      tokenConfigured: true,
      generatedAt: new Date().toISOString(),
      bootstrapToken: randomSecret(32),
    },
  };
  const persisted = writeInstallerState(nextState, { includeSecrets: true });
  console.log(JSON.stringify({
    scope: 'installer-auth',
    event: 'bootstrap_token_generated',
    at: new Date().toISOString(),
    header: persisted.setupAuth?.tokenHeader || DEFAULT_SETUP_TOKEN_HEADER,
    envVar: persisted.setupAuth?.tokenEnvVar || SETUP_TOKEN_ENV_VARS[0],
    token: persisted.setupAuth?.bootstrapToken || '',
  }));
  return persisted;
}
