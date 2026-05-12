import { useState, useEffect, useRef, Suspense, useCallback, useMemo } from 'react';
import React from 'react';
import TorrentTableRaw from './TorrentTable';
import PipelineCardRaw from './PipelineCard';
import { SlskdCard as SlskdCardRaw } from './ActivityLog';
// App polls constantly, so keep the largest child trees behind shallow prop-based memoization.
const TorrentTable = React.memo(TorrentTableRaw);
const PipelineCard = React.memo(PipelineCardRaw);
const SlskdCard = React.memo(SlskdCardRaw);
import { formatSpeed, formatBytes, getTorrentState, cleanName, detectQualityLabel } from './utils';
import { apiFetch, apiPost, apiDelete, getApiErrorDetails } from './api';
import { BP, getServiceGradient, getServiceUrl } from './constants';
import './App.css';

// Code-split modal components
const Library = React.lazy(() => import('./Library'));
const SidePanel = React.lazy(() => import('./SidePanel'));
const ManualSearchModal = React.lazy(() => import('./ManualSearchModal'));

/**
 * Colored service chip with status indicator and optional link.
 * @param {Object} container - qBittorrent/Docker container object
 * @param {string} name - Cleaned service name (e.g. "sonarr")
 * @param {string|null} href - URL to open when chip is clicked
 */
function ContainerChip({ container, name, href }) {
  const [hovered, setHovered] = useState(false);
  const [c1, c2] = getServiceGradient(name);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', borderRadius: 20,
        fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
        cursor: container.running && href ? 'pointer' : 'default',
        border: '1px solid var(--border-subtle)',
        color: container.running ? 'var(--text-secondary)' : 'var(--text-faint)',
        opacity: container.running ? 1 : 0.38,
        background: hovered && container.running ? 'var(--surface)' : 'transparent',
        transition: 'background 0.2s',
        userSelect: 'none',
      }}
    >
      <span style={{
        width: 16, height: 16, borderRadius: 4, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 800, color: '#fff',
        background: `linear-gradient(135deg, ${c1}, ${c2})`,
      }}>
        {name[0]?.toUpperCase()}
      </span>
      {name}
      {hovered && href && (
        <span className="material-symbols-rounded" style={{
          fontSize: 11, color: 'rgba(235,235,245,0.45)',
          fontVariationSettings: "'FILL' 0",
          marginLeft: 1,
        }}>open_in_new</span>
      )}
    </div>
  );
}

/**
 * Vertical navigation rail button with active indicator and badge.
 * @param {ReactNode} icon - Icon element to display
 * @param {boolean} active - Whether this item is the current active view
 * @param {Function} onClick - Click handler
 * @param {string} title - Tooltip text
 * @param {number} [badge] - Optional badge count (shown as red pill)
 */
function RailItem({ icon, active, onClick, title, badge, disabled = false }) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      title={title}
      aria-label={title}
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) onClick(); }}
      className="rail-item"
      style={{
        width: 44, height: 44, borderRadius: 12,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', position: 'relative',
        background: active ? 'rgba(255,55,95,0.18)' : 'transparent',
        color: active ? '#FF375F' : 'rgba(235,235,245,0.50)',
        transition: 'background 0.2s, color 0.2s',
        opacity: disabled ? 0.56 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
    >
      {active && (
        <div style={{
          position: 'absolute', left: -8, top: '50%',
          transform: 'translateY(-50%)',
          width: 3, height: 20, background: '#FF375F', borderRadius: 2,
        }} />
      )}
      {icon}
      {badge > 0 && (
        <div style={{
          position: 'absolute', top: 4, right: 4,
          minWidth: 16, height: 16, borderRadius: 8,
          background: '#FF375F',
          color: '#fff',
          fontSize: 9, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 3px',
          lineHeight: 1,
          boxShadow: '0 0 0 2px var(--bg-nav)',
          pointerEvents: 'none',
        }}>
          {badge > 99 ? '99+' : badge}
        </div>
      )}
    </div>
  );
}

const LibraryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
    <rect x="3" y="3" width="7" height="7" rx="1.5"/>
    <rect x="14" y="3" width="7" height="7" rx="1.5"/>
    <rect x="3" y="14" width="7" height="7" rx="1.5"/>
    <rect x="14" y="14" width="7" height="7" rx="1.5"/>
  </svg>
);

const DownloadsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
    <path d="M12 2v13m0 0l-4-4m4 4l4-4"/>
    <path d="M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3"/>
  </svg>
);

const SettingsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
);

const DownArrowIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
    <polyline points="17 6 23 6 23 12"/>
  </svg>
);

const UpArrowIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
    <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/>
    <polyline points="17 18 23 18 23 12"/>
  </svg>
);

const SearchBarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', width: 15, height: 15, pointerEvents: 'none' }}>
    <circle cx="11" cy="11" r="7"/>
    <line x1="16.5" y1="16.5" x2="22" y2="22"/>
  </svg>
);

function LoadingSkeleton() {
  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', fontFamily: "-apple-system, 'SF Pro Display', sans-serif" }}>
      <div style={{ textAlign: 'center' }}>
        <svg viewBox="0 0 28 28" fill="none" style={{ width: 40, height: 40, margin: '0 auto 20px', display: 'block' }}>
          <path d="M14 2 L24 22 L14 18 L4 22 Z" fill="white" opacity="0.9"/>
          <path d="M14 6 L21 20 L14 16.5 L7 20 Z" fill="#FF375F" opacity="0.8"/>
        </svg>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, letterSpacing: '0.04em' }}>Loading vibarr…</p>
      </div>
    </div>
  );
}

const STATUS_COLOR = { searching: '#ff9f0a', grabbed: '#30d158', no_results: '#ff453a', error: '#ff453a' };
const STATUS_LABEL = { searching: 'Searching…', grabbed: 'Grabbed', no_results: 'No results', error: 'Error' };
const SVC_LABEL = { sonarr: 'TV', radarr: 'Movie', lidarr: 'Music' };
const ADD_SUCCESS_REFRESH_STEPS_MS = [600, 1400, 2600, 4200];
const ADD_SUCCESS_PLACEHOLDER_TTL_MS = 9000;

async function apiFetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await apiFetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}


function PendingSearchCard({ search }) {
  const [elapsed, setElapsed] = useState(() => Math.round((Date.now() - search.startedAt) / 1000));
  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.round((Date.now() - search.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [search.startedAt]);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const dot = STATUS_COLOR[search.status] || '#ff9f0a';
  const isSearching = search.status === 'searching';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
      background: 'var(--surface-subtle)', borderRadius: 10,
      border: `1px solid ${isSearching ? 'rgba(255,159,10,0.2)' : 'var(--border-subtle)'}`,
    }}>
      {search.posterUrl ? (
        <img src={search.posterUrl.startsWith('/api/') ? search.posterUrl : `/api/poster?url=${encodeURIComponent(search.posterUrl)}`}
          alt="" style={{ width: 32, height: 44, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
          decoding="async"
          onError={e => { e.target.style.display = 'none'; }} />
      ) : (
        <div style={{ width: 32, height: 44, borderRadius: 4, background: 'var(--border-subtle)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--text-faint)' }}>tv</span>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {search.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          {SVC_LABEL[search.service] || search.service} · {search.subtitle}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {isSearching && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{elapsedStr}</span>}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px',
          borderRadius: 6, background: `${dot}18`, border: `1px solid ${dot}30`,
        }}>
          {isSearching && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block', animation: 'pulse 1.2s ease-in-out infinite' }} />
          )}
          {!isSearching && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block' }} />
          )}
          <span style={{ fontSize: 11, fontWeight: 600, color: dot }}>{STATUS_LABEL[search.status] || search.status}</span>
        </div>
      </div>
    </div>
  );
}

const ARR_STATUS_COLOR = { downloading: '#0a84ff', completed: '#0a84ff', warning: '#ff9f0a', error: '#ff453a', failed: '#ff453a', delay: '#ff9f0a' };

const SERVICE_META = {
  radarr: {
    label: 'Radarr',
    short: 'Movies',
    env: ['RADARR_HOST', 'RADARR_API_KEY'],
    detail: 'Movie library, lookup, and automated search.',
  },
  sonarr: {
    label: 'Sonarr',
    short: 'TV',
    env: ['SONARR_HOST', 'SONARR_API_KEY'],
    detail: 'Series library, episode tracking, and season searches.',
  },
  lidarr: {
    label: 'Lidarr',
    short: 'Music',
    env: ['LIDARR_HOST', 'LIDARR_API_KEY'],
    detail: 'Artist library, album monitoring, and Soulseek handoff.',
  },
  prowlarr: {
    label: 'Prowlarr',
    short: 'Indexers',
    env: ['PROWLARR_HOST', 'PROWLARR_API_KEY'],
    detail: 'Indexer sync for Radarr, Sonarr, and Lidarr.',
  },
  qbittorrent: {
    label: 'qBittorrent',
    short: 'Downloads',
    env: ['QBITTORRENT_HOST', 'QBITTORRENT_USER', 'QBITTORRENT_PASS'],
    detail: 'Torrent client connection and download telemetry.',
  },
  slskd: {
    label: 'slskd',
    short: 'Soulseek',
    env: ['SLSKD_HOST', 'SLSKD_API_KEY'],
    detail: 'Soulseek search and music fallback downloads.',
  },
};

const SERVICE_TONE = {
  up: { label: 'Up', fg: '#30d158', bg: 'rgba(48,209,88,0.16)', border: 'rgba(48,209,88,0.28)' },
  ready: { label: 'Ready', fg: '#30d158', bg: 'rgba(48,209,88,0.16)', border: 'rgba(48,209,88,0.28)' },
  down: { label: 'Down', fg: '#ff453a', bg: 'rgba(255,69,58,0.16)', border: 'rgba(255,69,58,0.28)' },
  error: { label: 'Error', fg: '#ff453a', bg: 'rgba(255,69,58,0.16)', border: 'rgba(255,69,58,0.28)' },
  unconfigured: { label: 'Unconfigured', fg: '#ff9f0a', bg: 'rgba(255,159,10,0.16)', border: 'rgba(255,159,10,0.28)' },
  stale: { label: 'Checking', fg: '#8e8e93', bg: 'rgba(142,142,147,0.16)', border: 'rgba(142,142,147,0.28)' },
};

function ServiceStatusPill({ status }) {
  const tone = SERVICE_TONE[status] || SERVICE_TONE.stale;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: tone.fg,
      background: tone.bg,
      border: `1px solid ${tone.border}`,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone.fg, boxShadow: `0 0 8px ${tone.fg}66` }} />
      {tone.label}
    </span>
  );
}

const LIBRARY_SERVICE_NAMES = ['radarr', 'sonarr', 'lidarr'];
const PHASE_READY = new Set(['ready', 'running', 'complete', 'completed', 'healthy', 'online', 'installed']);
const PHASE_PROGRESS = new Set([
  'installing',
  'provisioning',
  'bootstrapping',
  'starting',
  'configuring',
  'writing_config',
  'waiting_for_restart',
  'restarting',
  'waiting_for_readiness',
  'verifying',
  'recovering',
  'retrying',
]);
const PHASE_SETUP = new Set([
  'setup_required',
  'needs_configuration',
  'manual_configuration',
  'manual_config',
  'unconfigured',
  'incomplete',
  'not_ready',
  'blocked',
  'error',
]);
function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function toDisplayText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    const service = firstDefined(value.service, value.name);
    const message = firstDefined(value.message, value.detail, value.error, value.warning, value.reason);
    if (service && message) return `${SERVICE_META[service]?.label || service}: ${message}`;
    if (message) return String(message).trim();
  }
  return String(value).trim() || null;
}

function collectTextEntries(...sources) {
  return [...new Set(
    sources
      .flatMap((source) => {
        if (!source) return [];
        if (Array.isArray(source)) return source;
        return [source];
      })
      .map(toDisplayText)
      .filter(Boolean),
  )];
}

function normalizePhase(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function humanizePhase(value) {
  if (!value) return null;
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function hasAnyLibraryServiceReady(status) {
  const services = status?.services || {};
  return LIBRARY_SERVICE_NAMES.some((name) => ['up', 'ready'].includes(services[name]?.status));
}

function getSetupFlowState(statusData, setupState) {
  const rawPhase = firstDefined(
    setupState?.installPhase,
    setupState?.phase,
    setupState?.install?.phase,
    setupState?.installer?.phase,
    setupState?.readiness?.phase,
    setupState?.readiness?.state,
    statusData?.installPhase,
    statusData?.phase,
    statusData?.install?.phase,
    statusData?.installer?.phase,
    statusData?.readiness?.phase,
    statusData?.readiness?.state,
  );
  const normalizedPhase = normalizePhase(rawPhase);
  const explicitReady = firstBoolean(
    setupState?.ready,
    setupState?.isReady,
    setupState?.readiness?.ready,
    statusData?.ready,
    statusData?.isReady,
    statusData?.readiness?.ready,
  );
  const setupRequired = firstBoolean(
    statusData?.setupRequired,
    setupState?.setupRequired,
    setupState?.needsSetup,
    statusData?.needsSetup,
  ) ?? false;
  const restartPending = firstBoolean(
    setupState?.restartPending,
    statusData?.restartPending,
    setupState?.restartScheduled,
    statusData?.restartScheduled,
  ) ?? false;
  const phaseInProgress = PHASE_PROGRESS.has(normalizedPhase);
  const phaseNeedsSetup = PHASE_SETUP.has(normalizedPhase);
  const phaseReady = PHASE_READY.has(normalizedPhase);
  const ready = explicitReady === true || (
    phaseReady &&
    explicitReady !== false &&
    !setupRequired &&
    !phaseNeedsSetup &&
    !restartPending
  );
  const needsSetup = setupRequired || phaseNeedsSetup || restartPending || explicitReady === false;
  return {
    ready,
    needsSetup,
    shouldStayInSetup: !ready && (needsSetup || phaseInProgress),
    phaseLabel: humanizePhase(rawPhase),
    phaseInProgress,
    restartPending,
    manualConfigOnly: needsSetup && setupState?.installerEnabled === false,
  };
}

function errorToneStyle(tone = 'error') {
  if (tone === 'warning') {
    return { border: 'rgba(255,159,10,0.28)', background: 'rgba(255,159,10,0.09)', color: '#ff9f0a' };
  }
  return { border: 'rgba(255,69,58,0.26)', background: 'rgba(255,69,58,0.08)', color: '#ff453a' };
}

function ApiErrorNotice({ title, error, tone = 'error', style = {} }) {
  const details = getApiErrorDetails(error);
  if (!details) return null;
  const palette = errorToneStyle(tone);
  const meta = [
    details.method && details.endpoint ? `${details.method} ${details.endpoint}` : details.endpoint,
    details.status ? `HTTP ${details.status}` : null,
    details.durationMs ? `${details.durationMs}ms` : null,
    details.attempt ? `attempt ${details.attempt}` : null,
    details.retryAfterMs ? `retry in ${Math.max(1, Math.ceil(details.retryAfterMs / 1000))}s` : null,
    details.requestId ? `request ${details.requestId}` : null,
    details.clientRequestId ? `client ${details.clientRequestId}` : null,
  ].filter(Boolean);
  return (
    <div style={{
      borderRadius: 14,
      padding: '12px 13px',
      border: `1px solid ${palette.border}`,
      background: palette.background,
      ...style,
    }}>
      {title && <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: palette.color, marginBottom: 6 }}>{title}</div>}
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-primary)' }}>{details.message}</div>
      {meta.length > 0 && <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)', marginTop: 6 }}>{meta.join(' · ')}</div>}
      {details.warnings.length > 0 && (
        <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)', marginTop: 6 }}>
          Warnings: {details.warnings.join(' · ')}
        </div>
      )}
    </div>
  );
}

const setupInputStyle = {
  height: 42,
  borderRadius: 12,
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-subtle)',
  color: 'var(--text-primary)',
  padding: '0 12px',
  fontSize: 13,
  outline: 'none',
};

function buildSetupForm(setupState) {
  const seed = setupState?.setup || setupState?.defaults || {};
  return {
    basePath: seed.basePath || '/docker',
    timezone: seed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
    puid: String(seed.puid ?? 1000),
    pgid: String(seed.pgid ?? 1000),
    services: {
      radarr: seed.services?.radarr ?? true,
      sonarr: seed.services?.sonarr ?? true,
      lidarr: seed.services?.lidarr ?? true,
      prowlarr: seed.services?.prowlarr ?? true,
      qbittorrent: seed.services?.qbittorrent ?? true,
      slskd: seed.services?.slskd ?? true,
    },
    qbittorrent: {
      username: seed.qbittorrent?.username || 'server',
      password: '',
    },
    slskd: {
      username: seed.slskd?.username || '',
      password: '',
      webUsername: seed.slskd?.webUsername || 'slskd',
      webPassword: '',
    },
  };
}

function SetupPanel({
  statusData,
  statusError,
  setupState,
  setupStateError,
  onRefresh,
  onContinue,
  onInstall,
  installing,
  installError,
  installResult,
  awaitingBackendRestart,
}) {
  const services = statusData?.services || {};
  const summary = statusData?.summary || { up: 0, down: 0, unconfigured: 0 };
  const setupRequired = Boolean(statusData?.setupRequired);
  const hasIssues = Boolean(statusData?.hasIssues);
  const setupFlow = useMemo(() => getSetupFlowState(statusData, setupState), [statusData, setupState]);
  const installerEnabled = setupState?.installerEnabled !== false;
  const serviceOrder = ['radarr', 'sonarr', 'lidarr', 'prowlarr', 'qbittorrent', 'slskd'];
  const [form, setForm] = useState(() => buildSetupForm(setupState));
  const initializedRef = useRef(false);
  const conflicts = firstDefined(setupState?.validation?.conflicts, setupState?.conflicts, []);
  const showInstaller = setupFlow.shouldStayInSetup && installerEnabled && !setupState?.managed;
  const canBootstrap = setupState?.canBootstrap !== false;
  const selectedServices = useMemo(() => Object.entries(form.services).filter(([, enabled]) => enabled).map(([name]) => name), [form.services]);
  const selectedLibraryServices = useMemo(() => LIBRARY_SERVICE_NAMES.filter((name) => form.services[name]), [form.services]);
  const selectedLibraryCount = selectedLibraryServices.length;
  const noLibrarySelected = selectedLibraryCount === 0;
  const selectedServiceConflicts = useMemo(() => {
    if (!Array.isArray(conflicts) || conflicts.length === 0) return [];
    return conflicts.filter((conflict) => {
      const names = [
        conflict?.service,
        ...(Array.isArray(conflict?.services) ? conflict.services : []),
        ...(Array.isArray(conflict?.relatedServices) ? conflict.relatedServices : []),
      ]
        .map((name) => String(name).toLowerCase())
        .filter(Boolean);
      if (names.length > 0) {
        return names.some((name) => selectedServices.includes(name));
      }
      const value = String(toDisplayText(conflict) || conflict || '').toLowerCase();
      return selectedServices.some((service) => value.includes(service));
    });
  }, [conflicts, selectedServices]);
  const selectedValidationIssues = useMemo(() => {
    const rawIssues = [
      ...(Array.isArray(setupState?.validation?.errors) ? setupState.validation.errors : []),
      ...(Array.isArray(setupState?.validation?.blocking) ? setupState.validation.blocking : []),
      ...(Array.isArray(setupState?.blockingIssues) ? setupState.blockingIssues : []),
    ];
    return collectTextEntries(...rawIssues.filter((issue) => {
      const names = [
        issue?.service,
        ...(Array.isArray(issue?.services) ? issue.services : []),
        ...(Array.isArray(issue?.relatedServices) ? issue.relatedServices : []),
      ]
        .map((name) => String(name).toLowerCase())
        .filter(Boolean);
      if (names.length > 0) return names.some((name) => selectedServices.includes(name));
      return true;
    }));
  }, [selectedServices, setupState]);
  const persistedInstallError = firstDefined(
    setupState?.lastInstallError,
    setupState?.lastError,
    setupState?.installer?.lastError,
    statusData?.lastInstallError,
  );
  const setupWarnings = collectTextEntries(
    setupState?.warnings,
    setupState?.warning,
    setupState?.installer?.warnings,
    statusData?.warnings,
    statusData?.warning,
  );
  const hasBlockingIssues = noLibrarySelected || selectedServiceConflicts.length > 0 || selectedValidationIssues.length > 0;
  const continueDisabled = awaitingBackendRestart || installing || setupFlow.shouldStayInSetup;

  useEffect(() => {
    if (initializedRef.current) return;
    setForm(buildSetupForm(setupState));
    initializedRef.current = true;
  }, [setupState]);

  const updateForm = (path, value) => {
    setForm(prev => {
      const next = structuredClone(prev);
      if (path.length === 1) next[path[0]] = value;
      if (path.length === 2) next[path[0]][path[1]] = value;
      return next;
    });
  };

  const toggleService = (name) => {
    setForm(prev => ({
      ...prev,
      services: {
        ...prev.services,
        [name]: !prev.services[name],
      },
    }));
  };

  const handleInstall = () => {
    onInstall({
      ...form,
      puid: Number(form.puid) || 1000,
      pgid: Number(form.pgid) || 1000,
    });
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area">
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '36px 28px 48px' }}>
        <div style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 24,
          padding: '28px 28px 24px',
          background: 'linear-gradient(180deg, rgba(10,132,255,0.10) 0%, rgba(10,132,255,0.02) 100%)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.22)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ maxWidth: 620 }}>
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#5ac8fa', marginBottom: 10 }}>
                Setup
              </p>
              <h1 style={{ fontSize: 30, lineHeight: 1.08, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 12 }}>
                {showInstaller
                  ? 'Install the media stack from here.'
                  : setupFlow.manualConfigOnly
                      ? 'Finish setup from the backend environment.'
                      : setupFlow.phaseInProgress || awaitingBackendRestart
                        ? 'Waiting for the API and services to become ready.'
                        : setupRequired
                          ? 'Connect the core services before using the dashboard.'
                    : hasIssues ? 'Some integrations need attention.' : 'Everything is connected.'}
              </h1>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: 680 }}>
                {showInstaller
                  ? 'On a fresh VM, the dashboard can now provision qBittorrent, Radarr, Sonarr, Lidarr, Prowlarr, and SLSKD. Pick the host paths and a few defaults, then the backend will create and wire the stack for you.'
                  : setupFlow.manualConfigOnly
                      ? 'This deployment is still configured through backend `.env` values. Update the relevant host or API key entries there, restart the API, then refresh status here.'
                      : setupFlow.phaseInProgress || awaitingBackendRestart
                        ? 'The installer finished enough work to restart the backend, but this screen should stay active until the backend reports a ready phase or readiness flag.'
                        : setupRequired
                          ? 'The backend is running, but no library service is ready yet. Configure at least one of Radarr, Sonarr, or Lidarr in the backend environment, then refresh status.'
                    : hasIssues
                      ? 'The dashboard can stay up while a subset of services is unavailable, but unavailable integrations should not silently pretend the library is empty anymore.'
                      : 'All configured services reported healthy on the last status check.'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{
                padding: '10px 14px',
                borderRadius: 16,
                border: '1px solid var(--border-subtle)',
                background: 'var(--surface)',
                minWidth: 140,
              }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                  Summary
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {summary.up}/{summary.up + summary.down + summary.unconfigured}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  services healthy
                </div>
              </div>
              {setupFlow.phaseLabel && (
                <div style={{
                  padding: '10px 14px',
                  borderRadius: 16,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--surface)',
                  minWidth: 170,
                }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                    Install Phase
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>
                    {setupFlow.phaseLabel}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    backend-reported state
                  </div>
                </div>
              )}
              <button
                onClick={onRefresh}
                style={{
                  height: 42,
                  padding: '0 16px',
                  borderRadius: 12,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Refresh Status
              </button>
                <button
                  onClick={onContinue}
                  disabled={continueDisabled}
                  style={{
                    height: 42,
                    padding: '0 16px',
                    borderRadius: 12,
                    border: 'none',
                    background: continueDisabled ? 'rgba(142,142,147,0.22)' : '#0a84ff',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: continueDisabled ? 'not-allowed' : 'pointer',
                    opacity: continueDisabled ? 0.55 : 1,
                  }}
                >
                  {setupFlow.shouldStayInSetup ? 'Setup Still Required' : 'Continue to Dashboard'}
                </button>
            </div>
          </div>
        </div>

        {(statusError || setupStateError) && (
          <div style={{ display: 'grid', gap: 10, marginTop: 20 }}>
            <ApiErrorNotice title="Status Check Failed" error={statusError} tone="warning" />
            <ApiErrorNotice title="Setup State Check Failed" error={setupStateError} tone="warning" />
          </div>
        )}

        {showInstaller && (
          <div style={{
            marginTop: 20,
            border: '1px solid var(--border-subtle)',
            borderRadius: 20,
            padding: 20,
            background: 'var(--surface)',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ maxWidth: 620 }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>First-run installer</div>
                <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                  This provisions the core containers, sets root folders, creates qBittorrent download clients inside the Arr apps,
                  stores the generated API keys for the dashboard, and restarts the backend onto the new stack.
                </p>
              </div>
              <button
                onClick={handleInstall}
                disabled={!installerEnabled || !canBootstrap || installing || hasBlockingIssues}
                style={{
                  height: 42,
                  padding: '0 16px',
                  borderRadius: 12,
                  border: 'none',
                  background: (!installerEnabled || !canBootstrap || installing || hasBlockingIssues)
                    ? 'rgba(142,142,147,0.22)'
                    : '#0a84ff',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: (!installerEnabled || !canBootstrap || installing || hasBlockingIssues)
                    ? 'not-allowed'
                    : 'pointer',
                  opacity: (!installerEnabled || !canBootstrap || installing || hasBlockingIssues)
                    ? 0.55
                    : 1,
                }}
              >
                {installing ? 'Installing…' : awaitingBackendRestart ? 'Waiting for restart…' : 'Install Stack'}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 18 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Host Data Root</span>
                <input value={form.basePath} onChange={(e) => updateForm(['basePath'], e.target.value)} style={setupInputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Timezone</span>
                <input value={form.timezone} onChange={(e) => updateForm(['timezone'], e.target.value)} style={setupInputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>PUID</span>
                <input value={form.puid} onChange={(e) => updateForm(['puid'], e.target.value)} style={setupInputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>PGID</span>
                <input value={form.pgid} onChange={(e) => updateForm(['pgid'], e.target.value)} style={setupInputStyle} />
              </label>
            </div>

            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Services</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {['radarr', 'sonarr', 'lidarr', 'prowlarr', 'qbittorrent', 'slskd'].map((name) => {
                  const active = form.services[name];
                  return (
                    <button
                      key={name}
                      onClick={() => toggleService(name)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: `1px solid ${active ? 'rgba(10,132,255,0.4)' : 'var(--border-subtle)'}`,
                        background: active ? 'rgba(10,132,255,0.12)' : 'transparent',
                        color: active ? '#5ac8fa' : 'var(--text-secondary)',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {SERVICE_META[name]?.label || name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 18 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>qB Username</span>
                <input value={form.qbittorrent.username} onChange={(e) => updateForm(['qbittorrent', 'username'], e.target.value)} style={setupInputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>qB Password</span>
                <input type="password" value={form.qbittorrent.password} onChange={(e) => updateForm(['qbittorrent', 'password'], e.target.value)} placeholder="Leave blank to auto-generate" style={setupInputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Soulseek User</span>
                <input value={form.slskd.username} onChange={(e) => updateForm(['slskd', 'username'], e.target.value)} placeholder="Optional" style={setupInputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Soulseek Pass</span>
                <input type="password" value={form.slskd.password} onChange={(e) => updateForm(['slskd', 'password'], e.target.value)} placeholder="Optional" style={setupInputStyle} />
              </label>
            </div>

            {(setupStateError || hasBlockingIssues || setupWarnings.length > 0 || persistedInstallError || installError || installResult?.success || awaitingBackendRestart) && (
              <div style={{ marginTop: 18, borderRadius: 16, padding: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}>
                {noLibrarySelected && (
                  <div style={{ fontSize: 12, color: '#ff9f0a' }}>
                    Select at least one library service: Radarr, Sonarr, or Lidarr.
                  </div>
                )}
                {selectedServiceConflicts.length > 0 && (
                  <div style={{ fontSize: 12, color: '#ff9f0a' }}>
                    Existing unmanaged containers block the selected install set: {selectedServiceConflicts.map((conflict) => toDisplayText(conflict)).filter(Boolean).join(', ')}.
                  </div>
                )}
                {selectedValidationIssues.length > 0 && (
                  <div style={{ fontSize: 12, color: '#ff9f0a', marginTop: 6 }}>
                    {selectedValidationIssues.join(' ')}
                  </div>
                )}
                {setupWarnings.length > 0 && (
                  <div style={{ fontSize: 12, color: '#ff9f0a', marginTop: 6, lineHeight: 1.6 }}>
                    {setupWarnings.join(' ')}
                  </div>
                )}
                {persistedInstallError && (
                  <div style={{ fontSize: 12, color: '#ff453a', marginTop: 6, lineHeight: 1.6 }}>
                    Last installer failure: {persistedInstallError}
                  </div>
                )}
                <ApiErrorNotice title="Install Request Failed" error={installError} style={{ marginTop: installError ? 6 : 0 }} />
                {installResult?.success && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#30d158', lineHeight: 1.65 }}>
                    qBittorrent: `{installResult.credentials?.qbittorrent?.username}` / `{installResult.credentials?.qbittorrent?.password}` at `{installResult.credentials?.qbittorrent?.url}`.
                    {installResult.credentials?.slskd && <> SLSKD web auth: `{installResult.credentials.slskd.username}` / `{installResult.credentials.slskd.password}`.</>}
                  </div>
                )}
                {awaitingBackendRestart && (
                  <div style={{ fontSize: 12, color: '#5ac8fa', marginTop: 6 }}>
                    The backend is restarting onto the newly provisioned stack. This screen will recover automatically once `/api/status` and `/api/setup/state` both report readiness.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!showInstaller && setupFlow.manualConfigOnly && (
          <div style={{
            marginTop: 20,
            border: '1px solid var(--border-subtle)',
            borderRadius: 20,
            padding: 20,
            background: 'var(--surface)',
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Manual configuration</div>
            <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text-secondary)' }}>
              This stack is still `.env`-driven. Update the backend service hosts, credentials, and API keys there, restart the API process, then use Refresh Status here to confirm readiness.
            </p>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 16, marginTop: 20 }}>
          {serviceOrder.map((name) => {
            const meta = SERVICE_META[name];
            const info = services[name] || { status: 'stale' };
            return (
              <div key={name} style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 20,
                padding: 18,
                background: 'var(--surface)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 700 }}>{meta.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{meta.short}</div>
                  </div>
                  <ServiceStatusPill status={info.status} />
                </div>
                <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', minHeight: 42 }}>
                  {meta.detail}
                </p>
                <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  <div>{(meta.env || []).join(' · ')}</div>
                  {info.url && <div style={{ marginTop: 6 }}>{info.url}</div>}
                  {info.error && <div style={{ marginTop: 6, color: '#ff9f0a' }}>{info.error}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ArrQueueCard({ item }) {
  const hasError = item.trackedStatus === 'warning' || item.trackedStatus === 'error' || item.status === 'failed';
  const statusColor = hasError ? '#ff9f0a' : ARR_STATUS_COLOR.downloading;
  const progress = item.progress || 0;
  const sizeLeft = item.sizeleft > 0 ? formatBytes(item.sizeleft) + ' left' : null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
      background: hasError ? 'rgba(255,159,10,0.04)' : 'var(--surface-subtle)', borderRadius: 10,
      border: `1px solid ${hasError ? 'rgba(255,159,10,0.2)' : 'var(--border-subtle)'}`,
    }}>
      {item.posterUrl ? (
        <img src={item.posterUrl.startsWith('/api/') ? item.posterUrl : `/api/poster?url=${encodeURIComponent(item.posterUrl)}`}
          alt="" style={{ width: 32, height: 44, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
          decoding="async"
          onError={e => { e.target.style.display = 'none'; }} />
      ) : (
        <div style={{ width: 32, height: 44, borderRadius: 4, background: 'var(--border-subtle)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--text-faint)' }}>{item.service === 'sonarr' ? 'tv' : 'movie'}</span>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.title}{item.episode ? ` — ${item.episode}` : ''}
        </div>
        {hasError && item.errorMessage ? (
          <div style={{ fontSize: 11, color: '#ff9f0a', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.errorMessage}
          </div>
        ) : (
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, height: 3, background: 'var(--progress-bar)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                width: `${progress}%`,
                height: '100%',
                background: statusColor,
                borderRadius: 2,
                transition: 'width 0.5s',
                boxShadow: `0 0 6px ${statusColor}90`,
                animation: hasError ? 'none' : 'downloadPulse 1.8s ease-in-out infinite',
              }} />
            </div>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>
              {sizeLeft || `${progress}%`}
            </span>
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, padding: '3px 8px', borderRadius: 6, background: `${statusColor}18`, border: `1px solid ${statusColor}30` }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: statusColor, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {hasError ? 'Warning' : item.status === 'completed' ? 'Importing' : 'Queued'}
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const [containers, setContainers] = useState([]);
  const [torrents, setTorrents] = useState([]);
  const [torrentError, setTorrentError] = useState(null);
  const [slskdDownloads, setSlskdDownloads] = useState([]);
  const [pendingSearches, setPendingSearches] = useState([]);
  const [pipeline, setPipeline] = useState([]);
  const [startingSearch, setStartingSearch] = useState(false);
  const [manualSearchTarget, setManualSearchTarget] = useState(null);
  const [manualSearchResults, setManualSearchResults] = useState([]);
  const [manualSearchLoading, setManualSearchLoading] = useState(false);
  const [expandedPipelineKey, setExpandedPipelineKey] = useState(null);
  const [arrQueue, setArrQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tailscaleIp, setTailscaleIp] = useState(null);
  const [mediaInfo, setMediaInfo] = useState({});
  const [activeView, setActiveView] = useState('library');
  const [headerQuery, setHeaderQuery] = useState('');
  const [bwHistory, setBwHistory] = useState([]);
  const [bwTotals, setBwTotals] = useState({ dl: 0, ul: 0 });
  const [bwLifetime, setBwLifetime] = useState({ dl: 0, ul: 0 });
  const [statusData, setStatusData] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [setupState, setSetupState] = useState(null);
  const [setupStateError, setSetupStateError] = useState(null);
  const [installingSetup, setInstallingSetup] = useState(false);
  const [setupInstallError, setSetupInstallError] = useState(null);
  const [setupInstallResult, setSetupInstallResult] = useState(null);
  const [awaitingBackendRestart, setAwaitingBackendRestart] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < BP.MOBILE);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= BP.MOBILE);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileSearchValue, setMobileSearchValue] = useState('');
  const [lightMode, setLightMode] = useState(() => {
    const saved = localStorage.getItem('theme') === 'light';
    // Apply the stored theme before first paint to avoid a dark/light flash on reload.
    document.documentElement.setAttribute('data-theme', saved ? 'light' : 'dark');
    return saved;
  });
  const mobileSearchDebounce = useRef(null);
  // Pollers read the latest torrent list from here without recreating their intervals.
  const torrentsRef = useRef([]);
  const prevPipelineRef = useRef({});
  const startingSearchTimersRef = useRef([]);
  const setupFlow = useMemo(() => getSetupFlowState(statusData, setupState), [statusData, setupState]);

  const fetchContainers = useCallback(async () => {
    try {
      const data = await apiFetch('/api/containers');
      setContainers(data);
    } catch (e) { console.error('[fetchContainers]', e); }
  }, []);

  const fetchTorrents = useCallback(async () => {
    try {
      const data = await apiFetch('/api/qbittorrent/status');
      const parsed = (data.torrents || []).map(t => ({ ...t, progress: parseFloat(t.progress) || 0 }));
      setTorrents(parsed);
      torrentsRef.current = parsed;
      setTorrentError(null);
    } catch (e) {
      console.error('[fetchTorrents]', e);
      setTorrentError(e.message);
    }
  }, []);

  const fetchSlskd = useCallback(async () => {
    try {
      const data = await apiFetch('/api/slskd/downloads');
      setSlskdDownloads(data);
    } catch (e) { console.error('[fetchSlskd]', e); }
  }, []);

  const fetchPendingSearches = useCallback(async () => {
    try {
      const pending = await apiFetch('/api/pending-searches');
      setPendingSearches(pending);
      const items = await apiFetch('/api/pipeline');
      if (Notification.permission === 'granted') {
        const prev = prevPipelineRef.current;
        for (const item of items) {
          const prevStage = prev[item.key];
          const isNowComplete = item.stage === 'complete';
          const wasNotComplete = !prevStage || (prevStage !== 'complete');
          if (isNowComplete && wasNotComplete && prevStage !== undefined) {
            new Notification(`Download complete: ${item.title}`, {
              body: item.subtitle ? `${item.subtitle} — Successfully imported` : 'Successfully imported',
              icon: '/favicon.ico',
            });
          }
        }
      }
      const newMap = {};
      for (const item of items) newMap[item.key] = item.stage;
      prevPipelineRef.current = newMap;
      setPipeline(items);
    } catch (e) { console.error('[fetchPendingSearches]', e); }
  }, []);

  const fetchArrQueue = useCallback(async () => {
    try {
      const data = await apiFetch('/api/arr-queue');
      setArrQueue(data);
    } catch (e) { console.error('[fetchArrQueue]', e); }
  }, []);

  const clearStartingSearchTimers = useCallback(() => {
    startingSearchTimersRef.current.forEach((id) => clearTimeout(id));
    startingSearchTimersRef.current = [];
  }, []);

  const refreshDownloadsState = useCallback(async () => {
    await Promise.all([fetchPendingSearches(), fetchArrQueue(), fetchTorrents(), fetchSlskd()]);
  }, [fetchPendingSearches, fetchArrQueue, fetchTorrents, fetchSlskd]);

  const fetchMediaInfo = useCallback((torrentList) => {
    try {
      const hashes = (torrentList || []).map(t => t.hash).filter(Boolean);
      if (hashes.length === 0) return;
      apiFetch(`/api/media-info/batch?hashes=${hashes.join(',')}`)
        .then(data => setMediaInfo(prev => ({ ...prev, ...data })))
        .catch(e => console.error('[fetchMediaInfo]', e));
    } catch (e) { console.error('[fetchMediaInfo]', e); }
  }, []);

  const fetchTailscaleIp = useCallback(async () => {
    try {
      const data = await apiFetch('/api/tailscale-ip');
      setTailscaleIp(data.ip);
    } catch (e) { console.error('[fetchTailscaleIp]', e); }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/status');
      setStatusData(data);
      setStatusError(null);
    } catch (e) {
      console.error('[fetchStatus]', e);
      setStatusError(e);
    }
  }, []);

  const fetchSetupState = useCallback(async () => {
    try {
      const data = await apiFetchWithTimeout('/api/setup/state', {}, 5000);
      setSetupState(data);
      setSetupStateError(null);
    } catch (e) {
      const error = e.name === 'AbortError'
        ? Object.assign(new Error('Setup state check timed out'), { endpoint: '/api/setup/state', method: 'GET' })
        : e;
      console.error('[fetchSetupState]', error);
      setSetupStateError(error);
    }
  }, []);

  useEffect(() => {
    if (!manualSearchTarget) { setManualSearchResults([]); return; }
    setManualSearchLoading(true);
    const controller = new AbortController();
    const { service, title, retryId, seriesId, movieId, seasonNumbers } = manualSearchTarget;
    const sn = seasonNumbers?.length === 1 ? seasonNumbers[0] : null;
    const id = service === 'sonarr' ? (seriesId || retryId) : (movieId || retryId);
    let url;
    if (id) {
      url = `/api/manual-search?service=${service}&id=${id}${sn ? `&seasonNumber=${sn}` : ''}`;
    } else if (title) {
      let q = title;
      if (sn && service === 'sonarr') q += ` S${String(sn).padStart(2, '0')}`;
      url = `/api/fast-search?query=${encodeURIComponent(q)}&service=${service}`;
    }
    apiFetch(url, { signal: controller.signal })
      .then(results => {
        setManualSearchResults(Array.isArray(results) ? results : []);
        setManualSearchLoading(false);
      }).catch(e => { if (e.name !== 'AbortError') setManualSearchLoading(false); });
    return () => controller.abort();
  }, [manualSearchTarget]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    const init = async () => {
      setLoading(true);
      const safePromise = Promise.all([fetchContainers(), fetchTorrents(), fetchTailscaleIp(), fetchSlskd(), fetchPendingSearches(), fetchArrQueue(), fetchStatus(), fetchSetupState()]);
      await safePromise.finally(() => {
        setLoading(false);
        fetchMediaInfo(torrentsRef.current);
      });
    };
    const refresh = async () => {
      await Promise.all([fetchContainers(), fetchTorrents(), fetchSlskd(), fetchPendingSearches(), fetchArrQueue(), fetchStatus()]);
    };
    init().catch((e) => console.error('[init]', e.message));
    const t1 = setInterval(refresh, 5000);
    const t2 = setInterval(() => fetchTailscaleIp(), 60000);
    const t3 = setInterval(() => fetchMediaInfo(torrentsRef.current), 30000);
    const t4 = setInterval(() => {
      fetchStatus();
      fetchSetupState();
    }, 60000);
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); };
  }, [fetchContainers, fetchTorrents, fetchTailscaleIp, fetchSlskd, fetchPendingSearches, fetchArrQueue, fetchMediaInfo, fetchStatus, fetchSetupState]);

  const torrentHashKey = torrents.map(t => t.hash).sort().join(',');
  useEffect(() => {
    const missing = torrents.filter(t => t.hash && !mediaInfo[t.hash]);
    if (missing.length > 0) fetchMediaInfo(missing);
  }, [torrentHashKey, mediaInfo, fetchMediaInfo]);

  useEffect(() => {
    const poll = async () => {
      try {
        const { dlSpeed, ulSpeed, dlTotal, ulTotal, lifetimeDl, lifetimeUl } = await apiFetch('/api/bandwidth');
        setBwHistory(prev => {
          const next = [...prev, { dl: dlSpeed, ul: ulSpeed }];
          return next.length > 60 ? next.slice(-60) : next;
        });
        setBwTotals({ dl: dlTotal, ul: ulTotal });
        setBwLifetime({ dl: lifetimeDl || 0, ul: lifetimeUl || 0 });
      } catch (e) { console.error('[fetchBandwidth]', e); }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', lightMode ? 'light' : 'dark');
    localStorage.setItem('theme', lightMode ? 'light' : 'dark');
  }, [lightMode]);

  useEffect(() => {
    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const mobile = window.innerWidth < BP.MOBILE;
        setIsMobile(mobile);
        setSidebarOpen(prev => {
          if (mobile) return false;
          if (prev === false) return true;
          return prev;
        });
      }, 100);
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(resizeTimer); };
  }, []);

  useEffect(() => {
    if (!setupFlow.shouldStayInSetup) return;
    if (activeView === 'settings') return;
    setActiveView('settings');
  }, [activeView, setupFlow.shouldStayInSetup]);

  useEffect(() => {
    if (awaitingBackendRestart) return;
    if (activeView !== 'settings' && !setupFlow.shouldStayInSetup) return;
    const timer = setInterval(() => {
      fetchSetupState();
    }, 5000);
    return () => clearInterval(timer);
  }, [activeView, awaitingBackendRestart, fetchSetupState, setupFlow.shouldStayInSetup]);

  useEffect(() => {
    if (!awaitingBackendRestart) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [status, setup] = await Promise.all([
          apiFetch('/api/status'),
          apiFetch('/api/setup/state'),
        ]);
        if (cancelled) return;
        setStatusData(status);
        setSetupState(setup);
        setStatusError(null);
        setSetupStateError(null);
        const nextSetupFlow = getSetupFlowState(status, setup);
        if (!nextSetupFlow.shouldStayInSetup) {
          setAwaitingBackendRestart(false);
          setInstallingSetup(false);
          setActiveView(hasAnyLibraryServiceReady(status) ? 'library' : 'downloads');
        }
      } catch (e) {
        if (!cancelled) setStatusError(e);
      }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [awaitingBackendRestart]);

  const isSetupLocked = installingSetup || awaitingBackendRestart || setupFlow.shouldStayInSetup;
  const requestView = (nextView) => {
    if (!nextView || nextView === activeView) return;
    if (isSetupLocked && activeView === 'settings' && nextView !== 'settings') return;
    setActiveView(nextView);
  };

  const runAddSuccessRefreshBurst = useCallback(() => {
    requestView('downloads');
    setStartingSearch(true);
    clearStartingSearchTimers();
    refreshDownloadsState().catch((e) => console.error('[refreshDownloadsState]', e));
    ADD_SUCCESS_REFRESH_STEPS_MS.forEach((delayMs) => {
      const timer = setTimeout(() => {
        refreshDownloadsState().catch((e) => console.error('[refreshDownloadsState]', e));
      }, delayMs);
      startingSearchTimersRef.current.push(timer);
    });
  }, [clearStartingSearchTimers, refreshDownloadsState, requestView]);

  const handleLibraryMediaAdded = useCallback(() => {
    runAddSuccessRefreshBurst();
    const stopTimer = setTimeout(() => setStartingSearch(false), ADD_SUCCESS_PLACEHOLDER_TTL_MS);
    startingSearchTimersRef.current.push(stopTimer);
  }, [runAddSuccessRefreshBurst]);


  const { running, allHealthy, sortedContainers } = useMemo(() => {
    const running = containers.filter(c => c.running);
    const allHealthy = containers.length > 0 && running.length === containers.length;
    const sortedContainers = [...containers].sort((a, b) => {
      if (a.running === b.running) return cleanName(a.name).localeCompare(cleanName(b.name));
      return a.running ? -1 : 1;
    });
    return { running, allHealthy, sortedContainers };
  }, [containers]);

  useEffect(() => () => clearStartingSearchTimers(), [clearStartingSearchTimers]);

  useEffect(() => {
    if (!startingSearch) return;
    const hasVisibleWork = pipeline.length + arrQueue.length + torrents.length + slskdDownloads.length + pendingSearches.length > 0;
    if (hasVisibleWork) {
      setStartingSearch(false);
      clearStartingSearchTimers();
    }
  }, [startingSearch, pipeline.length, arrQueue.length, torrents.length, slskdDownloads.length, pendingSearches.length, clearStartingSearchTimers]);

  const { downloading, totalDl, totalUl } = useMemo(() => ({
    downloading: torrents.filter(t => getTorrentState(t) === 'downloading'),
    totalDl: torrents.reduce((s, t) => s + (t.downloadSpeed || 0), 0),
    totalUl: torrents.reduce((s, t) => s + (t.uploadSpeed || 0), 0),
  }), [torrents]);

  const serviceStatuses = statusData?.services || {};
  const libraryServicesReady = useMemo(() => ({
    movie: ['up', 'ready'].includes(serviceStatuses.radarr?.status),
    series: ['up', 'ready'].includes(serviceStatuses.sonarr?.status),
    music: ['up', 'ready'].includes(serviceStatuses.lidarr?.status),
  }), [serviceStatuses]);
  const anyLibraryServiceReady = libraryServicesReady.movie || libraryServicesReady.series || libraryServicesReady.music;
  const searchDisabled = activeView === 'settings' || !anyLibraryServiceReady;

  // Memoized callback handlers for child components
  const handleSlskdUpdate = useCallback(() => fetchSlskd(), [fetchSlskd]);
  const handleTorrentRefresh = useCallback(() => fetchTorrents(), [fetchTorrents]);
  const handleSidebarClose = useCallback(() => setSidebarOpen(false), []);
  const handleManualSearchClose = useCallback(() => setManualSearchTarget(null), []);
  const handleStatusRefresh = useCallback(() => fetchStatus(), [fetchStatus]);
  const handleSetupInstall = useCallback(async (payload) => {
    setInstallingSetup(true);
    setSetupInstallError(null);
    setSetupInstallResult(null);
    try {
      const data = await apiPost('/api/setup/install', payload);
      setSetupInstallResult(data);
      if (data.restartScheduled) setAwaitingBackendRestart(true);
      else setInstallingSetup(false);
    } catch (e) {
      setSetupInstallError(e);
      setInstallingSetup(false);
    }
  }, []);

  const pipelineStages = useMemo(() => ({
    searching: pipeline.filter(p => p.stage === 'searching'),
    downloading: pipeline.filter(p => p.stage === 'downloading'),
    stuck: pipeline.filter(p => p.stage === 'stuck'),
  }), [pipeline]);
  const hasDownloadsOrSearchWork = pipeline.length + arrQueue.length + torrents.length + slskdDownloads.length + pendingSearches.length > 0;
  const showStartingSearchMessage = startingSearch && !hasDownloadsOrSearchWork;

  if (loading) return <LoadingSkeleton />;

  return (
    <div style={{
      height: '100vh', width: '100vw', display: 'flex', overflow: 'hidden',
      background: 'var(--bg-base)',
      fontFamily: "'Inter', -apple-system, 'SF Pro Display', BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
      WebkitFontSmoothing: 'antialiased',
      color: 'var(--text-primary)',
      fontSize: 14,
      letterSpacing: '-0.005em',
    }}>

      {/* ── Left Rail ── */}
      <nav aria-label="Main navigation" style={{
        width: 64, flexShrink: 0,
        background: 'var(--bg-nav)',
        borderRight: '1px solid var(--border-subtle)',
        display: isMobile ? 'none' : 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '20px 0 24px',
        zIndex: 100,
      }}>
        {/* Logo */}
        <div style={{ width: 32, height: 32, marginBottom: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg viewBox="0 0 28 28" fill="none" style={{ width: 28, height: 28 }}>
            {/* vibarr emblem: wings + sun + descent */}
            <circle cx="14" cy="5" r="3" fill="#FF9F0A"/>
            <path d="M13 8 L2 16 L10 13 L13 11Z" fill="rgba(235,235,245,0.88)"/>
            <path d="M15 8 L26 16 L18 13 L15 11Z" fill="rgba(235,235,245,0.88)"/>
            <path d="M14 11 L13 23 L14 20 L15 23Z" fill="#FF375F"/>
          </svg>
        </div>

        {/* Main nav */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1, width: '100%', padding: '0 8px' }}>
          <RailItem
            icon={<LibraryIcon />}
            active={activeView === 'library'}
            onClick={() => requestView('library')}
            disabled={isSetupLocked && activeView === 'settings'}
            title="Library"
          />
          <RailItem
            icon={<DownloadsIcon />}
            active={activeView === 'downloads'}
            onClick={() => requestView('downloads')}
            disabled={isSetupLocked && activeView === 'settings'}
            title={`Downloads${downloading.length > 0 ? ` (${downloading.length})` : ''}`}
            badge={downloading.length}
          />
        </div>

        <div style={{ flex: 1 }} />

        {/* Bottom nav */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: '100%', padding: '0 8px' }}>
          <RailItem icon={<SettingsIcon />} active={activeView === 'settings'} onClick={() => requestView('settings')} title="Settings" />
        </div>
      </nav>

      {/* ── Main Column ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Header */}
        <header style={{
          height: 60, flexShrink: 0,
          background: 'var(--bg-header)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center',
          padding: '0 28px', gap: 20,
          backdropFilter: 'blur(20px)',
          zIndex: 50,
        }}>
          <span style={{
            fontSize: 18, fontWeight: 700, letterSpacing: '0.22em',
            color: 'var(--text-primary)', textTransform: 'uppercase', flexShrink: 0,
          }}>
            vibarr
          </span>

          {!isMobile && (
            <div style={{ flex: 1, maxWidth: 360, marginLeft: 20 }}>
              <div style={{ position: 'relative' }}>
                <SearchBarIcon />
                <input
                  aria-label="Search library"
                  type="text"
                  placeholder={searchDisabled ? 'Configure a library service to search' : 'Search library…'}
                  value={headerQuery}
                  disabled={searchDisabled}
                  onChange={e => { setHeaderQuery(e.target.value); requestView('library'); }}
                  onFocus={() => { if (!searchDisabled) requestView('library'); }}
                  style={{
                    width: '100%',
                    background: 'var(--surface)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 10,
                    padding: '8px 14px 8px 36px',
                    color: searchDisabled ? 'var(--text-disabled)' : 'var(--text-primary)',
                    fontSize: 13.5,
                    outline: 'none',
                    fontFamily: 'inherit',
                    transition: 'border-color 0.2s, background 0.2s',
                    cursor: searchDisabled ? 'not-allowed' : 'text',
                  }}
                />
              </div>
            </div>
          )}

          {isMobile && (
            <button
              aria-label={mobileSearchOpen ? 'Close search' : 'Open search'}
              onClick={() => setMobileSearchOpen(o => {
                if (o) {
                  clearTimeout(mobileSearchDebounce.current);
                  setMobileSearchValue('');
                  setHeaderQuery('');
                }
                return !o;
              })}
              disabled={searchDisabled}
              style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: searchDisabled ? 'rgba(142,142,147,0.18)' : mobileSearchOpen ? 'rgba(10,132,255,0.18)' : 'var(--border-subtle)',
                border: 'none', cursor: 'pointer',
                color: searchDisabled ? 'var(--text-disabled)' : mobileSearchOpen ? '#0a84ff' : 'var(--text-secondary)',
                opacity: searchDisabled ? 0.55 : 1,
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
                <circle cx="11" cy="11" r="7"/>
                <line x1="16.5" y1="16.5" x2="22" y2="22"/>
              </svg>
            </button>
          )}

          <div style={{ flex: 1 }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            {!isMobile && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: totalDl > 0 ? 1 : 0.28, transition: 'opacity 0.4s' }}>
                <DownArrowIcon />
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: 'var(--text-secondary)' }}>{totalDl > 0 ? formatSpeed(totalDl) : '—'}</span>
              </span>
            )}
            {!isMobile && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', opacity: totalUl > 0 ? 1 : 0.28, transition: 'opacity 0.4s' }}>
                <UpArrowIcon />
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: 'var(--text-secondary)' }}>{totalUl > 0 ? formatSpeed(totalUl) : '—'}</span>
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <div style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: allHealthy ? '#34C759' : '#FF375F',
                boxShadow: allHealthy ? '0 0 6px rgba(52,199,89,0.7)' : '0 0 6px rgba(255,55,95,0.7)',
              }} />
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--text-secondary)' }}>
                {running.length}/{containers.length}
              </span>
            </div>
            <button
              aria-label={lightMode ? 'Switch to dark mode' : 'Switch to light mode'}
              onClick={() => setLightMode(m => !m)}
              style={{
                width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--border-subtle)',
                border: 'none', cursor: 'pointer',
                color: 'var(--text-secondary)',
                transition: 'background 0.2s, color 0.2s',
              }}
            >
              {lightMode ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              )}
            </button>
            {isMobile && (
              <button
                aria-label={sidebarOpen ? 'Close panel' : 'Open panel'}
                onClick={() => setSidebarOpen(o => !o)}
                style={{
                  width: 36, height: 36, borderRadius: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: sidebarOpen ? 'rgba(255,55,95,0.18)' : 'var(--border-subtle)',
                  border: 'none', cursor: 'pointer',
                  color: sidebarOpen ? '#FF375F' : 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
                  {sidebarOpen ? 'close' : 'menu_open'}
                </span>
              </button>
            )}
          </div>
        </header>

          {isMobile && mobileSearchOpen && !searchDisabled && (
            <div style={{
              padding: '14px 16px 16px',
              background: 'var(--bg-mobile-search)',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0,
          }}>
            <div style={{ position: 'relative' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', width: 18, height: 18, pointerEvents: 'none' }}>
                <circle cx="11" cy="11" r="7"/>
                <line x1="16.5" y1="16.5" x2="22" y2="22"/>
              </svg>
              <input
                aria-label="Search library"
                type="text"
                placeholder="Search library…"
                value={mobileSearchValue}
                autoFocus
                  onChange={e => {
                    const val = e.target.value;
                    setMobileSearchValue(val);
                    requestView('library');
                    clearTimeout(mobileSearchDebounce.current);
                    mobileSearchDebounce.current = setTimeout(() => setHeaderQuery(val), 200);
                  }}
                  onFocus={() => requestView('library')}
                style={{
                  width: '100%',
                  background: 'var(--surface)',
                  border: '1px solid var(--border-medium)',
                  borderRadius: 12,
                  padding: '15px 16px 15px 46px',
                  color: 'var(--text-primary)',
                  fontSize: 16,
                  outline: 'none',
                  fontFamily: 'inherit',
                }}
              />
            </div>
          </div>
        )}

        {/* Service Strip */}
        <div style={{
          height: 44, flexShrink: 0,
          background: 'var(--bg-service-strip)',
          borderBottom: '1px solid var(--border-subtle)',
          display: isMobile ? 'none' : 'flex', alignItems: 'center',
          padding: '0 28px', gap: 8,
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }} className="hide-scrollbar">
          {sortedContainers.map(c => {
            const name = cleanName(c.name);
            const port = c.ports?.find(p => p.host) || c.ports?.[0];
            const href = c.running
              ? (tailscaleIp && port
                  ? `http://${tailscaleIp}:${port.host}`
                  : getServiceUrl(name))
              : null;
            return href ? (
              <a key={c.id} href={href} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <ContainerChip container={c} name={name} href={href} />
              </a>
            ) : (
              <div key={c.id}><ContainerChip container={c} name={name} href={null} /></div>
            );
          })}
        </div>

        {/* Content Area */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* Main Content Pane */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0, paddingBottom: isMobile ? 'calc(56px + env(safe-area-inset-bottom))' : 0 }}>
            {activeView === 'library' && (
              <Suspense fallback={null}>
                <Library
                  externalQuery={headerQuery}
                  onExternalQueryChange={setHeaderQuery}
                  serviceStatus={serviceStatuses}
                  onOpenSettings={() => requestView('settings')}
                  onAdded={handleLibraryMediaAdded}
                />
              </Suspense>
            )}

            {activeView === 'downloads' && (
              <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area">
                {pipeline.length > 0 && (
                  <div className="px-6 pt-4 pb-2">
                    <div className="flex items-center gap-2 mb-3">
                      <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Active Searches</p>
                      <span className="text-[10px] font-bold text-text-muted bg-white/[0.07] rounded-full px-1.5 py-0.5 leading-none">
                        {pipeline.length}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {[
                          pipelineStages.searching.length > 0 && pipelineStages.searching.length + ' searching',
                          pipelineStages.downloading.length > 0 && pipelineStages.downloading.length + ' downloading',
                          pipelineStages.stuck.length > 0 && pipelineStages.stuck.length + ' stuck',
                        ].filter(Boolean).join(' · ')}
                      </span>
                      <p className="text-[10px] text-text-muted ml-auto">Click card to expand log</p>
                    </div>
                    <div className="space-y-2 overflow-y-auto" style={{ maxHeight: 600 }}>
                      {pipeline.map(item => (
                        <PipelineCard key={item.key} item={item}
                          expanded={expandedPipelineKey === item.key}
                          onToggle={() => setExpandedPipelineKey(prev => prev === item.key ? null : item.key)}
                          onRetry={async (key) => {
                            await apiPost(`/api/pipeline/${encodeURIComponent(key)}/retry`);
                          }}
                          onCancel={async (key) => {
                            await apiDelete(`/api/pipeline/${encodeURIComponent(key)}/cancel`);
                            fetchPendingSearches();
                          }}
                          onMonitor={async (key) => {
                            await apiPost(`/api/pipeline/${encodeURIComponent(key)}/monitor`);
                            fetchPendingSearches();
                          }}
                          onManualSearch={(item) => setManualSearchTarget(item)}
                          onDismiss={async (key) => {
                            await apiDelete(`/api/pipeline/${encodeURIComponent(key)}`);
                            fetchPendingSearches();
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {pendingSearches.length > 0 && (
                  <div className="px-6 pt-4 pb-2">
                    <div className="flex items-center gap-2 mb-3">
                      <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Recent Searches</p>
                      <span className="text-[10px] font-bold text-text-muted bg-white/[0.07] rounded-full px-1.5 py-0.5 leading-none">
                        {pendingSearches.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {pendingSearches.map((search) => (
                        <PendingSearchCard key={search.key || search.id || search.title} search={search} />
                      ))}
                    </div>
                  </div>
                )}
                {torrents.length > 0 && <TorrentTable torrents={torrents} mediaInfo={mediaInfo} onRefresh={handleTorrentRefresh} />}
                {slskdDownloads.length > 0 && (
                  <div className="px-6 pt-4 pb-2">
                    <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">Soulseek</p>
                    <div className="space-y-2">
                      {slskdDownloads.map((dl, i) => (
                        <SlskdCard key={i} dl={dl}
                          onDelete={async (u) => {
                            await apiDelete(`/api/slskd/downloads/${encodeURIComponent(u)}`);
                            handleSlskdUpdate();
                          }}
                          onRetry={async (u, fid) => {
                            await apiPost('/api/slskd/retry', { username: u, fileId: fid });
                            setTimeout(handleSlskdUpdate, 1000);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {manualSearchTarget && (
                  <Suspense fallback={null}>
            <ManualSearchModal
              target={manualSearchTarget}
              results={manualSearchResults}
              loading={manualSearchLoading}
                      onClose={handleManualSearchClose}
                      onGrab={async (release) => {
                        await apiPost('/api/grab', {
                          service: manualSearchTarget.service,
                          guid: release.guid,
                          indexerId: release.indexerId,
                          pipelineKey: manualSearchTarget.key,
                          downloadUrl: release.downloadUrl || undefined,
                          title: release.title,
                        });
                        setTimeout(() => { setManualSearchTarget(null); fetchPendingSearches(); }, 800);
                      }}
                    />
                  </Suspense>
                )}
                {!hasDownloadsOrSearchWork && (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
                    {torrentError ? (
                      <div style={{ textAlign: 'center' }}>
                        <p style={{ color: '#FF375F', fontSize: 14, fontWeight: 500, marginBottom: 4 }}>qBittorrent unavailable</p>
                        <p style={{ color: 'rgba(235,235,245,0.50)', fontSize: 12 }}>{torrentError}</p>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center' }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 52, display: 'block', marginBottom: 16, fontVariationSettings: "'FILL' 0", color: 'var(--text-disabled)' }}>download_done</span>
                        <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 5 }}>
                          {showStartingSearchMessage ? 'Starting search…' : 'All clear'}
                        </p>
                        <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                          {showStartingSearchMessage ? 'Watch for the new search to appear in active items' : 'No active transfers'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeView === 'settings' && (
                <SetupPanel
                  statusData={statusData || { services: {}, summary: { up: 0, down: 0, unconfigured: 0 }, setupRequired: false, hasIssues: Boolean(statusError) }}
                  statusError={statusError}
                  setupState={setupState}
                  setupStateError={setupStateError}
                  onRefresh={() => {
                    handleStatusRefresh();
                    fetchSetupState();
                  }}
                  onContinue={() => requestView(anyLibraryServiceReady ? 'library' : 'downloads')}
                  onInstall={handleSetupInstall}
                  installing={installingSetup}
                  installError={setupInstallError}
                  installResult={setupInstallResult}
                  awaitingBackendRestart={awaitingBackendRestart}
              />
            )}
          </div>

          {/* Side Panel */}
          <Suspense fallback={null}>
            <SidePanel
              torrents={torrents}
              slskdDownloads={slskdDownloads}
              mediaInfo={mediaInfo}
              onSlskdUpdate={handleSlskdUpdate}
              onTorrentRefresh={handleTorrentRefresh}
              bwHistory={bwHistory}
              bwTotals={bwTotals}
              bwLifetime={bwLifetime}
              isMobile={isMobile}
              isOpen={sidebarOpen}
              onClose={handleSidebarClose}
            />
          </Suspense>

        </div>
      </div>

      {isMobile && (
        <nav aria-label="Bottom navigation" style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, height: 56,
          background: 'var(--bg-nav)',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-around',
          zIndex: 200,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}>
          {[
            { view: 'library', icon: <LibraryIcon />, label: 'Library' },
            { view: 'downloads', icon: <DownloadsIcon />, label: 'Downloads', badge: downloading.length },
            { view: 'settings', icon: <SettingsIcon />, label: 'Settings' },
          ].map(({ view, icon, label, badge }) => (
            <button
              key={view}
              disabled={isSetupLocked && activeView === 'settings' && view !== 'settings'}
              onClick={() => {
                if (isSetupLocked && activeView === 'settings' && view !== 'settings') return;
                requestView(view);
                if (view !== 'library') {
                  setMobileSearchOpen(false);
                  setMobileSearchValue('');
                  setHeaderQuery('');
                }
              }}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                gap: 3, height: '100%', background: 'none', border: 'none',
                cursor: isSetupLocked && activeView === 'settings' && view !== 'settings' ? 'not-allowed' : 'pointer',
                position: 'relative',
                opacity: isSetupLocked && activeView === 'settings' && view !== 'settings' ? 0.56 : 1,
                color: activeView === view ? '#FF375F' : 'var(--text-muted)',
              }}
            >
              {icon}
              <span style={{ fontSize: 10, fontWeight: 600 }}>{label}</span>
              {badge > 0 && (
                <span style={{
                  position: 'absolute', top: 6, right: 'calc(50% - 22px)',
                  minWidth: 16, height: 16, borderRadius: 8, background: '#FF375F',
                  color: '#fff', fontSize: 9, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 3px',
                }}>{badge > 99 ? '99+' : badge}</span>
              )}
            </button>
          ))}
          <button
            aria-label={sidebarOpen ? 'Close panel' : 'Open panel'}
            onClick={() => setSidebarOpen(o => !o)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 3, height: '100%', background: 'none', border: 'none',
              cursor: 'pointer',
              color: sidebarOpen ? '#FF375F' : 'var(--text-muted)',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
              {sidebarOpen ? 'close' : 'dashboard'}
            </span>
            <span style={{ fontSize: 10, fontWeight: 600 }}>Panel</span>
          </button>
        </nav>
      )}
    </div>
  );
}
