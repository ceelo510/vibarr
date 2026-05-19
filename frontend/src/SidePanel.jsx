import React, { useState, useEffect, useRef, useMemo, useCallback, useId } from 'react';
import { formatSpeed, getTorrentState, formatBytes, timeAgo } from './utils';
import PosterImage from './PosterImage';

const DOT_COLOR = {
  success: '#30d158',
  error:   '#ff375f',
  pending: '#ff9f0a',
  info:    '#0a84ff',
};

const SERVICE_ICON = { sonarr: 'tv', radarr: 'movie', lidarr: 'album', slskd: 'cloud_download' };

const PANEL_TITLE_STYLE = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: 14,
};

const SEPARATOR = '1px solid var(--border-subtle)';
const ACTIVE_DOWNLOAD_BLUE = '#0a84ff';
const ACTIVE_DOWNLOAD_BLUE_SOFT = '#5ac8fa';

const Thumb = React.memo(function Thumb({ url, title, square }) {
  const size = square ? { width: 44, height: 44 } : { width: 36, height: 50 };
  const initials = (title || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (
    <PosterImage
      url={url}
      title={title}
      icon={square ? 'album' : 'movie'}
      style={{
        ...size,
        borderRadius: 6,
        flexShrink: 0,
        boxShadow: '0 2px 6px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.06)',
      }}
      fallback={(
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: square ? 13 : 11, fontWeight: 800, letterSpacing: '0.02em',
          color: 'rgba(255,255,255,0.55)', textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        }}>
          {initials}
        </div>
      )}
    />
  );
});

const IconButton = React.memo(function IconButton({ onClick, title, danger, disabled, children }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 44, height: 44, borderRadius: 10,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: hover && !disabled ? (danger ? 'rgba(255,55,95,0.14)' : 'var(--border-subtle)') : 'transparent',
        color: danger ? '#ff6b8a' : 'var(--text-muted)',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 0.15s, color 0.15s',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
});

// Clean up ugly activity messages like "Title S01E02: long file name blob"
function formatActivity(item) {
  const title = item.context?.title || item.context?.artistName || null;
  const raw = item.message || '';
  const svc = item.context?.service;

  // Pattern: "<Title> SxxEyy: <rest>" → extract episode + reason
  const epMatch = raw.match(/^(.*?)\s+(S\d{1,2}E\d{1,3}):?\s*(.*)$/i);
  if (epMatch) {
    const [, , ep, rest] = epMatch;
    const subject = title ? `${title} · ${ep}` : ep;
    const reason = cleanReason(rest, svc);
    return { subject, reason };
  }
  // Pattern: "<Title>: <rest>"
  const colonIdx = raw.indexOf(':');
  if (title && colonIdx > 0) {
    const subject = title;
    const reason = cleanReason(raw.slice(colonIdx + 1).trim(), svc);
    return { subject, reason };
  }
  if (title) return { subject: title, reason: cleanReason(raw, svc) };
  return { subject: raw, reason: '' };
}

function cleanReason(s, svc) {
  if (!s) return '';
  let r = s.trim();
  // Strip the release-name noise: "Show.Name.S01E02.1080p.WEB..."
  r = r.replace(/\b[A-Z0-9][\w.-]+\.(mkv|mp4|avi|flac|mp3|srt|scr)\b/gi, '');
  r = r.replace(/\b\d{3,4}p\b/gi, '');
  r = r.replace(/\b(WEB-?DL|WEB|BluRay|REMUX|HDTV|WEBRip|DVDRip|x265|x264|h264|h265|HEVC|FLAC|DTS|AAC|DD5\.1|Atmos|DV|HDR|AMZN|NF)\b/gi, '');
  r = r.replace(/-[A-Z0-9]{2,}$/gi, '');
  r = r.replace(/\.(scr|exe)\b/gi, '');
  r = r.replace(/\s+/g, ' ').trim();

  const friendly = {
    'qbittorrent is reporting missing files': 'Missing files in qBittorrent',
    'qbittorrent is reporting completed download': 'Download completed',
    'unable to parse': 'Could not identify release',
    'no files found': 'No matching files',
  };
  const lower = r.toLowerCase();
  for (const [k, v] of Object.entries(friendly)) if (lower.includes(k)) return v;
  if (!r) return svc ? `${svc} update` : '';
  return r.length > 60 ? r.slice(0, 58) + '…' : r;
}

// ═══════════════════════════════════════════════════════════════════════════
// Now Downloading — per-torrent card
// ═══════════════════════════════════════════════════════════════════════════

function DownloadMoreMenu({ onClose, onPause, onDelete, onDeleteWithFiles, paused, anchorRef }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, anchorRef]);
  return (
    <div
      ref={menuRef}
      style={{
        position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 100,
        background: 'var(--surface-elevated)',
        border: '1px solid var(--border-medium)',
        borderRadius: 10, padding: 4, minWidth: 180,
        boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <MenuItem icon={paused ? 'play_arrow' : 'pause'} label={paused ? 'Resume' : 'Pause'} onClick={() => { onPause(); onClose(); }} />
      <MenuItem icon="delete_outline" label="Remove from list" onClick={() => { onDelete(); onClose(); }} />
      <MenuItem icon="delete_forever" label="Remove + delete files" danger onClick={() => { onDeleteWithFiles(); onClose(); }} />
    </div>
  );
}

const MenuItem = React.memo(function MenuItem({ icon, label, onClick, danger }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '7px 10px', borderRadius: 7,
        background: hover ? (danger ? 'rgba(255,55,95,0.14)' : 'var(--border-subtle)') : 'transparent',
        color: danger ? '#ff6b8a' : 'var(--text-primary)',
        fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>{icon}</span>
      {label}
    </button>
  );
});

const QbDownloadItem = React.memo(function QbDownloadItem({ torrent, info, onAction, onOpenDetail, isLast }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelTimerRef = useRef(null);
  const moreBtnRef = useRef(null);
  useEffect(() => () => clearTimeout(cancelTimerRef.current), []);
  const pct = Math.round(torrent.progress || 0);
  const displayTitle = info?.title || torrent.name;
  const sub = [info?.year, info?.network, info?.episodeNumber].filter(Boolean).join(' · ')
    || (torrent.size > 0 ? formatBytes(torrent.size) : '');
  const state = getTorrentState(torrent);
  const paused = state === 'paused';
  const speed = torrent.downloadSpeed || 0;
  const isMusic = info?.mediaType === 'music' || /lidarr|music/i.test(torrent.category || '');
  const isLiveDownload = !paused && speed > 0;

  const handle = async (action) => {
    setActionBusy(true);
    setActionErr(null);
    try {
      await onAction(torrent.hash, action);
    } catch (e) {
      setActionErr(e.message || 'Action failed');
      setTimeout(() => setActionErr(null), 3000);
    }
    setActionBusy(false);
  };

  return (
    <div style={{
      paddingBottom: isLast ? 0 : 12, marginBottom: isLast ? 0 : 12,
      borderBottom: isLast ? 'none' : SEPARATOR,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 7 }}>
        <Thumb url={info?.posterUrl} title={displayTitle} square={isMusic} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button
            onClick={() => onOpenDetail?.(torrent, info)}
            title={displayTitle}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: 0,
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {displayTitle}
          </button>
          {sub && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {sub}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
            {speed > 0 ? (
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                color: ACTIVE_DOWNLOAD_BLUE_SOFT,
                fontVariantNumeric: 'tabular-nums',
                animation: isLiveDownload ? 'downloadPulse 1.8s ease-in-out infinite' : 'none',
              }}>
                ↓ {formatSpeed(speed)}
              </span>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-disabled)' }}>
                {paused ? 'Paused' : 'Stalled'}
              </span>
            )}
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {pct}%
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, position: 'relative' }}>
          <IconButton
            title={paused ? 'Resume' : 'Pause'}
            onClick={() => handle(paused ? 'resume' : 'pause')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15, fontVariationSettings: "'FILL' 1" }}>{paused ? 'play_arrow' : 'pause'}</span>
          </IconButton>
          {confirmCancel ? (
            <button
              onClick={() => { clearTimeout(cancelTimerRef.current); setConfirmCancel(false); handle('delete'); }}
              style={{ height: 30, padding: '0 8px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 4,
                background: 'rgba(255,69,58,0.85)', border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 13, fontVariationSettings: "'FILL' 1" }}>delete</span>
              Remove?
            </button>
          ) : (
            <IconButton title="Cancel download" danger
              onClick={() => { setConfirmCancel(true); clearTimeout(cancelTimerRef.current); cancelTimerRef.current = setTimeout(() => setConfirmCancel(false), 2500); }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15, fontVariationSettings: "'FILL' 1" }}>close</span>
            </IconButton>
          )}
          <div ref={moreBtnRef}>
            <IconButton title="More" onClick={() => setMenuOpen(!menuOpen)}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>more_vert</span>
            </IconButton>
          </div>
          {menuOpen && (
            <DownloadMoreMenu
              anchorRef={moreBtnRef}
              onClose={() => setMenuOpen(false)}
              paused={paused}
              onPause={() => handle(paused ? 'resume' : 'pause')}
              onDelete={() => handle('delete')}
              onDeleteWithFiles={() => handle('deleteFiles')}
            />
          )}
        </div>
      </div>
      <div style={{ height: 3, background: 'var(--progress-bar)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 2,
          background: paused
            ? 'linear-gradient(90deg, #636366 0%, #8e8e93 100%)'
            : `linear-gradient(90deg, ${ACTIVE_DOWNLOAD_BLUE} 0%, ${ACTIVE_DOWNLOAD_BLUE_SOFT} 100%)`,
          boxShadow: paused ? 'none' : '0 0 8px rgba(10,132,255,0.35)',
          transition: 'width 0.4s ease',
          animation: isLiveDownload ? 'downloadPulse 1.8s ease-in-out infinite' : 'none',
        }} />
      </div>
      {actionErr && (
        <p style={{ fontSize: 10, color: '#ff453a', marginTop: 4, textAlign: 'right' }}>{actionErr}</p>
      )}
    </div>
  );
});

const SlskdDownloadItem = React.memo(function SlskdDownloadItem({ dl, onDelete, onRetry, isLast }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelTimerRef = useRef(null);
  const moreBtnRef = useRef(null);
  useEffect(() => () => clearTimeout(cancelTimerRef.current), []);
  const pct = dl.percentComplete || 0;
  const speed = dl.files?.find(f => f.state === 'InProgress')?.averageSpeed || 0;
  const hasFailed = dl.failed > 0;

  return (
    <div style={{
      paddingBottom: isLast ? 0 : 12, marginBottom: isLast ? 0 : 12,
      borderBottom: isLast ? 'none' : SEPARATOR,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 7 }}>
        <Thumb url={dl.posterUrl} title={`${dl.artistName} ${dl.albumName}`} square />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div title={`${dl.artistName} — ${dl.albumName}`} style={{
            fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {dl.albumName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {dl.artistName} · Soulseek
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
            {speed > 0 ? (
              <span style={{ fontSize: 11, fontWeight: 600, color: '#30d158', fontVariantNumeric: 'tabular-nums' }}>
                ↓ {formatSpeed(speed)}
              </span>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-disabled)' }}>
                {hasFailed ? `${dl.failed} failed` : 'Queued'}
              </span>
            )}
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {dl.completed}/{dl.fileCount}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, position: 'relative' }}>
          {hasFailed && (
            <IconButton title="Retry failed" onClick={() => onRetry(dl.username)}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>refresh</span>
            </IconButton>
          )}
          {confirmCancel ? (
            <button
              onClick={() => { clearTimeout(cancelTimerRef.current); setConfirmCancel(false); onDelete(dl.username); }}
              style={{ height: 30, padding: '0 8px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 4,
                background: 'rgba(255,69,58,0.85)', border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 13, fontVariationSettings: "'FILL' 1" }}>delete</span>
              Remove?
            </button>
          ) : (
            <IconButton title="Cancel download" danger
              onClick={() => { setConfirmCancel(true); clearTimeout(cancelTimerRef.current); cancelTimerRef.current = setTimeout(() => setConfirmCancel(false), 2500); }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15, fontVariationSettings: "'FILL' 1" }}>close</span>
            </IconButton>
          )}
        </div>
      </div>
      <div style={{ height: 3, background: 'var(--progress-bar)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 2,
          background: hasFailed
            ? 'linear-gradient(90deg, #ff9f0a 0%, #ffd60a 100%)'
            : 'linear-gradient(90deg, #30d158 0%, #5ad67e 100%)',
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Activity row
// ═══════════════════════════════════════════════════════════════════════════

const ActivityRow = React.memo(function ActivityRow({ item, onDismiss, isLast, isMobile = false }) {
  const [hover, setHover] = useState(false);
  const { subject, reason } = formatActivity(item);
  const svcIcon = SERVICE_ICON[item.context?.service];
  const color = DOT_COLOR[item.status] || DOT_COLOR.info;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '8px 4px', borderBottom: isLast ? 'none' : SEPARATOR,
        position: 'relative',
      }}
    >
      <div style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0, marginTop: 6,
        background: color,
        boxShadow: item.status === 'pending' ? `0 0 6px ${color}` : 'none',
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {svcIcon && (
            <span className="material-symbols-rounded" style={{
              fontSize: 11, color: 'var(--text-muted)',
              fontVariationSettings: "'FILL' 1", flexShrink: 0,
            }}>{svcIcon}</span>
          )}
          <span title={subject} style={{
            fontSize: 11.5, color: 'var(--text-primary)', fontWeight: 500,
            lineHeight: 1.3, flex: 1, minWidth: 0,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{subject}</span>
        </div>
        {reason && (
          <div title={reason} style={{
            fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.3,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{reason}</div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginTop: 3 }}>
        <span style={{ fontSize: 10, color: 'var(--text-disabled)', fontVariantNumeric: 'tabular-nums' }}>
          {timeAgo(item.timestamp)}
        </span>
        {(hover || isMobile) && (
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(item.id); }}
            title="Dismiss"
            style={{
              width: 18, height: 18, borderRadius: 4,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'var(--text-muted)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--border-medium)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>close</span>
          </button>
        )}
      </div>
    </div>
  );
});


const Sparkline = React.memo(function Sparkline({ data, height = 38 }) {
  if (!data || data.length < 2) return <div style={{ height }} />;
  const w = 280;
  const h = height;
  const maxVal = Math.max(1, ...data.map(d => Math.max(d.dl, d.ul)));
  const pts = (key) => data.map((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (d[key] / maxVal) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polyline points={pts('dl')} fill="none" stroke="#30d158" strokeWidth="1.5" strokeLinejoin="round" opacity="0.9"/>
      <polyline points={pts('ul')} fill="none" stroke="#FF375F" strokeWidth="1.5" strokeLinejoin="round" opacity="0.65"/>
    </svg>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Main panel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Right-side panel showing active downloads, activity log, bandwidth sparkline, and storage.
 * On desktop: fixed 320px inline sidebar.
 * On mobile: slide-in overlay from the right edge.
 * @param {Array} torrents - qBittorrent torrent list
 * @param {Array} slskdDownloads - Soulseek download list
 * @param {Object} mediaInfo - Hash → media metadata map for poster/title lookup
 * @param {Function} onSlskdUpdate - Refresh Soulseek downloads
 * @param {Function} onTorrentRefresh - Refresh torrent list
 * @param {Array} bwHistory - Rolling 60-point bandwidth history [{dl, ul}]
 * @param {Object} bwTotals - Session totals { dl: bytes, ul: bytes }
 * @param {boolean} isMobile - Whether the viewport is mobile-width (<768px)
 * @param {boolean} isOpen - Whether the panel is visible (mobile overlay mode)
 * @param {Function} onClose - Called when backdrop or close button is tapped (mobile)
 */
function SidePanel({ torrents, slskdDownloads, mediaInfo, onSlskdUpdate, onTorrentRefresh, bwHistory = [], bwTotals = {}, bwLifetime = {}, isMobile = false, isOpen = true, onClose }) {
  const [activity, setActivity] = useState([]);
  const [storage, setStorage] = useState(null);
  const prevActivityIdRef = useRef(null);
  const panelRef = useRef(null);
  const prevFocusRef = useRef(null);
  const titleId = useId();

  // Focus management + Esc to close (mobile overlay)
  useEffect(() => {
    if (!isMobile) return;
    if (isOpen) {
      prevFocusRef.current = document.activeElement;
      // Move focus into panel
      const node = panelRef.current;
      if (node) {
        const focusable = node.querySelector('button, [href], input, [tabindex]:not([tabindex="-1"])');
        (focusable || node).focus?.();
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    } else if (prevFocusRef.current) {
      try { prevFocusRef.current.focus?.(); } catch {}
      prevFocusRef.current = null;
    }
  }, [isMobile, isOpen, onClose]);

  const fetchActivity = async () => {
    try {
      const r = await fetch('/api/activity-log?limit=20', { cache: 'no-store' });
      if (r.ok) {
        const items = await r.json();
        // The first successful poll only seeds the ref; later polls notify on new import/success head items.
        if (items.length > 0 && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const newestId = items[0].id;
          if (prevActivityIdRef.current !== null && newestId !== prevActivityIdRef.current) {
            const newItem = items[0];
            const msg = (newItem.message || '').toLowerCase();
            const isImport = msg.includes('import') || msg.includes('added to library') || newItem.status === 'success';
            if (isImport) {
              const title = newItem.context?.title || newItem.context?.artistName || 'Media imported';
              new Notification(`Imported: ${title}`, {
                body: newItem.message || 'New activity',
                icon: '/favicon.ico',
              });
            }
          }
          if (prevActivityIdRef.current === null || items[0].id !== prevActivityIdRef.current) {
            prevActivityIdRef.current = items[0].id;
          }
        } else if (items.length > 0 && prevActivityIdRef.current === null) {
          prevActivityIdRef.current = items[0].id;
        }
        setActivity(items);
      }
    } catch {}
  };
  const fetchStorage = async () => {
    try {
      const r = await fetch('/api/storage', { cache: 'no-store' });
      if (r.ok) setStorage(await r.json());
    } catch {}
  };

  useEffect(() => {
    fetchActivity();
    fetchStorage();
    const t1 = setInterval(fetchActivity, 15000);
    const t2 = setInterval(fetchStorage, 60000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);

  // Keep the download stack focused on items the operator can still act on.
  const activeDownloads = useMemo(() => (torrents || [])
    .filter(t => { const s = getTorrentState(t); return s === 'downloading' || s === 'paused'; })
    .sort((a, b) => (b.downloadSpeed || 0) - (a.downloadSpeed || 0)), [torrents]);
  const activeSlskd = useMemo(() => (slskdDownloads || []).filter(d => d.inProgress > 0 || d.queued > 0 || d.failed > 0), [slskdDownloads]);

  const handleTorrentAction = useCallback(async (hash, action) => {
    let url, opts;
    if (action === 'pause') { url = `/api/qbittorrent/torrents/${hash}/pause`; opts = { method: 'POST' }; }
    else if (action === 'resume') { url = `/api/qbittorrent/torrents/${hash}/resume`; opts = { method: 'POST' }; }
    else if (action === 'delete') { url = `/api/qbittorrent/torrents/${hash}?deleteFiles=false`; opts = { method: 'DELETE' }; }
    else if (action === 'deleteFiles') { url = `/api/qbittorrent/torrents/${hash}?deleteFiles=true`; opts = { method: 'DELETE' }; }
    else return;
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setTimeout(() => onTorrentRefresh?.(), 400);
  }, [onTorrentRefresh]);

  const handleSlskdDelete = useCallback(async (username) => {
    await fetch(`/api/slskd/downloads/${encodeURIComponent(username)}`, { method: 'DELETE' });
    onSlskdUpdate?.();
  }, [onSlskdUpdate]);
  const handleSlskdRetry = useCallback(async (username, fileId) => {
    await fetch('/api/slskd/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, fileId }),
    });
    setTimeout(() => onSlskdUpdate?.(), 1000);
  }, [onSlskdUpdate]);

  const handleDismissActivity = useCallback(async (id) => {
    try {
      await fetch(`/api/activity-log/${id}`, { method: 'DELETE' });
      setActivity(prev => prev.filter(a => a.id !== id));
    } catch {}
  }, []);

  const totalItems = activeDownloads.length + activeSlskd.length;

  return (
    <>
      {isMobile && (
        <div
          onClick={onClose}
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 149,
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
            opacity: isOpen ? 1 : 0,
            pointerEvents: isOpen ? 'auto' : 'none',
            transition: 'opacity 240ms cubic-bezier(0.22, 1, 0.36, 1)',
            willChange: 'opacity',
          }}
        />
      )}
      <aside
        ref={panelRef}
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile ? 'true' : undefined}
        aria-labelledby={isMobile ? titleId : undefined}
        aria-hidden={isMobile && !isOpen ? 'true' : undefined}
        tabIndex={isMobile ? -1 : undefined}
        style={isMobile ? {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: '85%',
        maxWidth: 360,
        background: 'var(--bg-nav)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        overscrollBehavior: 'contain',
        zIndex: 150,
        transform: isOpen ? 'translate3d(0,0,0)' : 'translate3d(100%,0,0)',
        opacity: isOpen ? 1 : 0,
        willChange: 'transform, opacity',
        transition: 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: isOpen ? 'auto' : 'none',
        boxShadow: isOpen ? '-8px 0 32px rgba(0,0,0,0.3)' : 'none',
        paddingBottom: 'calc(56px + env(safe-area-inset-bottom))',
      } : {
        width: 320,
        flexShrink: 0,
        background: 'var(--bg-nav)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>

      {isMobile && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 16px 8px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}>
          <span id={titleId} style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>Panel</span>
          <button
            onClick={onClose}
            style={{
              width: 30, height: 30, borderRadius: 8,
              background: 'var(--border-subtle)',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-secondary)',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
      )}

      {/* ── Now Downloading ── */}
      <div style={{ padding: '16px 16px 16px', borderBottom: SEPARATOR, flexShrink: 0, willChange: 'transform', maxHeight: '45%', overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'thin' }} className="scroll-area">
        <div style={{ ...PANEL_TITLE_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Now Downloading</span>
          {totalItems > 0 && (
            <span style={{ color: 'var(--text-secondary)', fontSize: 10, letterSpacing: 0 }}>
              {totalItems}
            </span>
          )}
        </div>

        {totalItems === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-faint)', textAlign: 'center', padding: '6px 0' }}>
            No active downloads
          </p>
        ) : (
          <div>
            {activeDownloads.map((t, idx) => {
              const info = mediaInfo?.[t.hash] || mediaInfo?.[t.hash?.toLowerCase()];
              const isLast = idx === activeDownloads.length - 1 && activeSlskd.length === 0;
              return (
                <QbDownloadItem
                  key={t.hash}
                  torrent={t}
                  info={info}
                  onAction={handleTorrentAction}
                  isLast={isLast}
                />
              );
            })}
            {activeSlskd.map((dl, i) => (
              <SlskdDownloadItem
                key={dl.username + dl.directory}
                dl={dl}
                onDelete={handleSlskdDelete}
                onRetry={handleSlskdRetry}
                isLast={i === activeSlskd.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Activity Log ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '16px 16px 16px', borderBottom: SEPARATOR }}>
        <div style={{ ...PANEL_TITLE_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Activity</span>
          {activity.length > 0 && (
            <button
              onClick={async () => { await fetch('/api/activity-log', { method: 'DELETE' }); setActivity([]); }}
              title="Clear all"
              style={{
                fontSize: 10, color: 'var(--text-muted)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: 0, letterSpacing: 0, textTransform: 'none',
              }}
            >Clear</button>
          )}
        </div>
        <div style={{ willChange: 'transform', overflowY: 'auto', flex: 1, scrollbarWidth: 'thin', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }} className="scroll-area">
          {activity.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-faint)', textAlign: 'center', padding: '6px 0' }}>
              No recent activity
            </p>
          ) : (
            activity.map((item, i) => (
              <ActivityRow
                key={item.id}
                item={item}
                onDismiss={handleDismissActivity}
                isLast={i === activity.length - 1}
                isMobile={isMobile}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Bandwidth ── */}
      {bwHistory.length > 0 && (
        <div style={{ padding: '16px 16px 16px', borderBottom: SEPARATOR, flexShrink: 0 }}>
          <div style={{ ...PANEL_TITLE_STYLE, marginBottom: 8 }}>Bandwidth</div>
          <div style={{ borderRadius: 6, overflow: 'hidden', background: 'var(--surface-subtle)' }}>
            <Sparkline data={bwHistory} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: '#30d158', fontWeight: 600 }}>
              ↓ {formatSpeed(bwHistory[bwHistory.length - 1]?.dl || 0)}
            </span>
            <span style={{ color: '#FF375F', opacity: 0.85, fontWeight: 600 }}>
              ↑ {formatSpeed(bwHistory[bwHistory.length - 1]?.ul || 0)}
            </span>
          </div>
          {(bwTotals.dl > 0 || bwTotals.ul > 0) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontSize: 10.5, color: 'var(--text-disabled)', fontVariantNumeric: 'tabular-nums' }}>
              <span>↓ {formatBytes(bwTotals.dl)} session</span>
              <span>↑ {formatBytes(bwTotals.ul)} session</span>
            </div>
          )}
          {(bwLifetime.dl > 0 || bwLifetime.ul > 0) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: 'rgba(48,209,88,0.6)' }}>↓ {formatBytes(bwLifetime.dl)} lifetime</span>
              <span style={{ color: 'rgba(255,55,95,0.5)' }}>↑ {formatBytes(bwLifetime.ul)} lifetime</span>
            </div>
          )}
        </div>
      )}

      {/* ── Storage ── */}
      {storage && (
        <div style={{ padding: '16px 16px 24px', flexShrink: 0 }}>
          <div style={{ ...PANEL_TITLE_STYLE, marginBottom: 12 }}>Storage</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {storage.breakdown?.filter(d => d.size > 0).slice(0, 3).map(d => (
              <div key={d.path}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{d.name}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(d.size)}</span>
                </div>
                <div style={{ height: 4, background: 'var(--progress-bar)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: storage.disk ? `${Math.min(100, Math.round((d.size / storage.disk.total) * 100))}%` : '50%',
                    borderRadius: 3,
                    background: 'linear-gradient(90deg, #0A84FF 0%, #5AC8FA 100%)',
                    transition: 'width 0.5s ease',
                  }} />
                </div>
              </div>
            ))}
            {storage.disk && (() => {
              const pct = Math.round((storage.disk.used / storage.disk.total) * 100);
              const bg = pct > 85
                ? 'linear-gradient(90deg, #FF375F 0%, #FF6B8A 100%)'
                : pct > 75
                ? 'linear-gradient(90deg, #FF9F0A 0%, #FFD60A 100%)'
                : 'linear-gradient(90deg, #0A84FF 0%, #5AC8FA 100%)';
              return (
                <div style={{ marginTop: 2, paddingTop: 10, borderTop: SEPARATOR }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>Total</span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(storage.disk.available)} free</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--progress-bar)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3, background: bg, transition: 'width 0.5s ease' }} />
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </aside>
    </>
  );
}

export default React.memo(SidePanel);
