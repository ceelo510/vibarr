import { existsSync, readFileSync } from 'fs';

const INSTALLER_STATE_PATH = process.env.INSTALLER_STATE_PATH || '/app/installer-state.json';
const MANAGED_ROOT_FOLDERS = Object.freeze({
  radarr: '/data/movies',
  sonarr: '/data/tv',
  lidarr: '/data/music',
});
const LEGACY_ROOT_FOLDERS = Object.freeze({
  radarr: '/movies',
  sonarr: '/tv',
  lidarr: '/music',
});
const ROOT_FOLDER_ENV_KEYS = Object.freeze({
  radarr: 'RADARR_ROOT_FOLDER',
  sonarr: 'SONARR_ROOT_FOLDER',
  lidarr: 'LIDARR_ROOT_FOLDER',
});

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function loadInstallerStateSnapshot() {
  try {
    if (!existsSync(INSTALLER_STATE_PATH)) return {};
    const parsed = JSON.parse(readFileSync(INSTALLER_STATE_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('Failed to load installer state snapshot:', error.message);
    return {};
  }
}

function loadInstallerOverrides(stateSnapshot) {
  return stateSnapshot?.serviceConfig && typeof stateSnapshot.serviceConfig === 'object'
    ? stateSnapshot.serviceConfig
    : {};
}

function normalizeRootFolderService(serviceName) {
  switch ((serviceName || '').toString().trim().toLowerCase()) {
    case 'movie':
    case 'movies':
    case 'radarr':
      return 'radarr';
    case 'series':
    case 'tv':
    case 'sonarr':
      return 'sonarr';
    case 'music':
    case 'artist':
    case 'artists':
    case 'lidarr':
      return 'lidarr';
    default:
      return null;
  }
}

function readRootFolderOverride(stateSnapshot, serviceName) {
  const normalized = normalizeRootFolderService(serviceName);
  if (!normalized) return null;

  const envKey = ROOT_FOLDER_ENV_KEYS[normalized];
  const candidates = [
    stateSnapshot?.rootFolders?.[normalized],
    stateSnapshot?.setup?.rootFolders?.[normalized],
    stateSnapshot?.serviceConfig?.[envKey],
    process.env[envKey],
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return null;
}

const INSTALLER_STATE_SNAPSHOT = loadInstallerStateSnapshot();
const INSTALLER_OVERRIDES = loadInstallerOverrides(INSTALLER_STATE_SNAPSHOT);

export const CONFIG = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  LISTEN_HOST: '0.0.0.0',
  MAX_PEER_RETRIES: 3,
  DOCKER_SOCKET: '/var/run/docker.sock',
  TAILSCALE_SOCKET: '/var/run/tailscale/tailscaled.sock',
  INSTALLER_STATE_PATH,
  INSTALLER_ENABLED: parseBoolean(process.env.INSTALLER_ENABLED || process.env.ENABLE_INSTALLER, false),

  RADARR_HOST: INSTALLER_OVERRIDES.RADARR_HOST || process.env.RADARR_HOST || 'http://radarr:7878',
  RADARR_API_KEY: INSTALLER_OVERRIDES.RADARR_API_KEY || process.env.RADARR_API_KEY || '',
  SONARR_HOST: INSTALLER_OVERRIDES.SONARR_HOST || process.env.SONARR_HOST || 'http://sonarr:8989',
  SONARR_API_KEY: INSTALLER_OVERRIDES.SONARR_API_KEY || process.env.SONARR_API_KEY || '',
  LIDARR_HOST: INSTALLER_OVERRIDES.LIDARR_HOST || process.env.LIDARR_HOST || 'http://lidarr:8686',
  LIDARR_API_KEY: INSTALLER_OVERRIDES.LIDARR_API_KEY || process.env.LIDARR_API_KEY || '',
  SLSKD_HOST: INSTALLER_OVERRIDES.SLSKD_HOST || process.env.SLSKD_HOST || 'http://slskd:5030',
  SLSKD_API_KEY: INSTALLER_OVERRIDES.SLSKD_API_KEY || process.env.SLSKD_API_KEY || '',

  QBITTORRENT_HOST: INSTALLER_OVERRIDES.QBITTORRENT_HOST || process.env.QBITTORRENT_HOST || 'http://qbittorrent:8080',
  QBITTORRENT_USER: INSTALLER_OVERRIDES.QBITTORRENT_USER || process.env.QBITTORRENT_USER || '',
  QBITTORRENT_PASS: INSTALLER_OVERRIDES.QBITTORRENT_PASS || process.env.QBITTORRENT_PASS || '',

  PROWLARR_HOST: INSTALLER_OVERRIDES.PROWLARR_HOST || process.env.PROWLARR_HOST || 'http://prowlarr:9696',
  PROWLARR_API_KEY: INSTALLER_OVERRIDES.PROWLARR_API_KEY || process.env.PROWLARR_API_KEY || '',
  MEDIA_SORTER_HOST: process.env.MEDIA_SORTER_HOST || '',

  ACTIVITY_LOG_PATH: '/app/activity-log.json',
  BANDWIDTH_PATH: '/app/bandwidth-lifetime.json',
};

export const TIMING = {
  QB_SESSION_TTL_MS: 5 * 60 * 1000,
  PIPELINE_STUCK_TIMEOUT_MS: 10 * 60 * 1000,
  MONITOR_QUEUES_INTERVAL_MS: 15_000,
  REFRESH_CACHE_INTERVAL_MS: 60_000,
  CHECK_STUCK_INTERVAL_MS: 30_000,
  PROCESS_SLSKD_INTERVAL_MS: 30_000,
  DETECT_FAKE_TORRENTS_MS: 5 * 60 * 1000,
  METADATA_CACHE_TTL_MS: 60 * 60 * 1000,
  ITUNES_POSTER_CACHE_TTL_MS: 60 * 60 * 1000,
  FAST_SEARCH_CACHE_TTL_MS: 30 * 60 * 1000,
  POSTER_CACHE_MAX_AGE: 86_400,
  ARR_IMAGE_CACHE_MAX_AGE: 86_400,
};

export const CONSTANTS = {
  DATA_DIR: '/data',
  HOST_DOCKER_DIR: '/hostdocker',
  FALLBACK_QUALITY_PROFILE: 1,
};

export function getDefaultRootFolder(serviceName) {
  const normalized = normalizeRootFolderService(serviceName);
  if (!normalized) return null;

  const override = readRootFolderOverride(INSTALLER_STATE_SNAPSHOT, normalized);
  if (override) return override;

  const installerManaged = INSTALLER_STATE_SNAPSHOT?.managed === true;
  const installerEnabledService = INSTALLER_STATE_SNAPSHOT?.services?.[normalized] === true;

  if (installerManaged || installerEnabledService) {
    return MANAGED_ROOT_FOLDERS[normalized];
  }

  return LEGACY_ROOT_FOLDERS[normalized];
}
