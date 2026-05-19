import { useState, useRef, useEffect, memo } from 'react';
import { formatBytes, formatSpeed, formatETA, getTorrentState, gradientFor, extractRating } from './utils';
import { getServiceUrl } from './constants';
import PosterImage from './PosterImage';

const STATE_COLOR = { downloading: '#30d158', seeding: '#ff9f0a', paused: '#636366', completed: '#0a84ff', error: '#ff453a' };
const STATE_LABEL = { downloading: 'Downloading', seeding: 'Seeding', paused: 'Paused', completed: 'Completed', error: 'Error' };

function formatDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatRuntime(mins) {
  if (!mins) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Poster ──────────────────────────────────────────────────────────────────

function PosterPlaceholder({ category, title }) {
  let icon = 'movie';
  if (category?.includes('sonarr')) icon = 'tv';
  else if (category?.includes('lidarr')) icon = 'album';
  const displayText = (title || '').toUpperCase().slice(0, 40);
  return (
    <div className="absolute inset-0 flex items-end" style={{ background: gradientFor(title) }}>
      <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)', pointerEvents: 'none' }} />
      <span className="material-symbols-rounded absolute" style={{ top: 12, right: 12, fontSize: 22, fontVariationSettings: "'FILL' 1", color: 'rgba(255,255,255,0.35)' }}>
        {icon}
      </span>
      {displayText && (
        <div style={{
          position: 'relative', padding: '0 14px 18px', zIndex: 2,
          fontSize: 15, fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.01em',
          color: 'rgba(255,255,255,0.88)', textShadow: '0 2px 14px rgba(0,0,0,0.8)',
          wordBreak: 'break-word',
        }}>
          {displayText}
        </div>
      )}
    </div>
  );
}

const CardPoster = memo(function CardPoster({ url, category, title }) {
  return (
    <PosterImage
      url={url}
      title={title}
      icon={category?.includes('sonarr') ? 'tv' : category?.includes('lidarr') ? 'album' : 'movie'}
      loading="eager"
      className="absolute inset-0"
      fallback={<PosterPlaceholder category={category} title={title} />}
    />
  );
});

// ── Sort History ────────────────────────────────────────────────────────────

function SortLine({ sortData }) {
  if (!sortData || Array.isArray(sortData)) return null;
  const { status, dest } = sortData;
  if (status === 'unknown') return null;

  const config = {
    sorted: { icon: 'check_circle', label: 'SORTED', fg: '#30d158', bg: 'rgba(48,209,88,0.15)' },
    error:  { icon: 'error', label: 'SORT ERROR', fg: '#ff453a', bg: 'rgba(255,69,58,0.15)' },
    holding:{ icon: 'hourglass_top', label: 'HOLDING', fg: '#ff9f0a', bg: 'rgba(255,159,10,0.15)' },
  };
  const c = config[status] || config.holding;

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: c.bg }}>
          <span className="material-symbols-rounded" style={{ fontSize: 11, fontVariationSettings: "'FILL' 1", color: c.fg }}>{c.icon}</span>
          <span className="text-[9px] font-bold tracking-wider" style={{ color: c.fg }}>{c.label}</span>
        </span>
      </div>
      {dest && (
        <p className="text-[9px] font-mono text-text-muted truncate mt-0.5" title={dest}>{dest}</p>
      )}
    </div>
  );
}

// ── Hover Controls ──────────────────────────────────────────────────────────

function HoverControls({ torrent, state, onAction }) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [loading, setLoading] = useState(null);
  const [actionError, setActionError] = useState(null);
  const errorTimerRef = useRef(null);
  const confirmTimerRef = useRef(null);

  const startConfirmTimer = () => {
    clearTimeout(confirmTimerRef.current);
    // Delete confirmation auto-expires so the card does not stay armed on hover.
    confirmTimerRef.current = setTimeout(() => setDeleteConfirm(false), 2000);
  };

  useEffect(() => () => clearTimeout(confirmTimerRef.current), []);

  const doAction = async (action) => {
    setLoading(action);
    setActionError(null);
    clearTimeout(errorTimerRef.current);
    try {
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const url = action === 'delete'
        ? `/api/qbittorrent/torrents/${torrent.hash}?deleteFiles=false`
        : `/api/qbittorrent/torrents/${torrent.hash}/${action}`;
      const res = await fetch(url, { method });
      if (res.ok) {
        if (onAction) onAction();
      } else {
        setActionError('Action failed');
        errorTimerRef.current = setTimeout(() => setActionError(null), 3000);
      }
    } catch (_) {
      setActionError('Network error');
      errorTimerRef.current = setTimeout(() => setActionError(null), 3000);
    }
    setLoading(null);
  };

  const handleDelete = () => {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      startConfirmTimer();
    } else {
      clearTimeout(confirmTimerRef.current);
      setDeleteConfirm(false);
      doAction('delete');
    }
  };

  const btnBase = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 34, height: 34, borderRadius: 8,
    border: 'none', cursor: 'pointer',
    backdropFilter: 'blur(8px)',
    transition: 'background 0.15s, transform 0.1s',
    fontSize: 18,
  };

  const iconBtn = (icon, clickHandler, bg, title, isLoading) => (
    <button
      title={title}
      onClick={(e) => { e.stopPropagation(); clickHandler(); }}
      style={{
        ...btnBase,
        background: isLoading ? 'rgba(255,255,255,0.08)' : bg,
        opacity: isLoading ? 0.5 : 1,
      }}
    >
      <span
        className="material-symbols-rounded"
        style={{ fontSize: 18, fontVariationSettings: "'FILL' 1", color: '#fff' }}
      >
        {isLoading ? 'hourglass_empty' : icon}
      </span>
    </button>
  );

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.0) 45%)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '10px 10px 0',
        zIndex: 10,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Left: action buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        {state === 'downloading' && iconBtn('pause', () => doAction('pause'), 'rgba(255,159,10,0.75)', 'Pause', loading === 'pause')}
        {state === 'paused' && iconBtn('play_arrow', () => doAction('resume'), 'rgba(48,209,88,0.75)', 'Resume', loading === 'resume')}
        {(state === 'seeding' || state === 'completed') && (
          <button
            title={deleteConfirm ? 'Click again to confirm' : 'Delete torrent'}
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            style={{
              ...btnBase,
              background: deleteConfirm ? 'rgba(255,69,58,0.9)' : 'rgba(255,69,58,0.65)',
              width: deleteConfirm ? 'auto' : 34,
              padding: deleteConfirm ? '0 10px' : 0,
              gap: 4,
              whiteSpace: 'nowrap',
              opacity: loading === 'delete' ? 0.5 : 1,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1", color: '#fff' }}>
              {loading === 'delete' ? 'hourglass_empty' : 'delete'}
            </span>
            {deleteConfirm && <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>Confirm?</span>}
          </button>
        )}
      </div>

      {/* Right: open in qBittorrent */}
      <a
        href={getServiceUrl('qbittorrent')}
        target="_blank"
        rel="noopener noreferrer"
        title="Open in qBittorrent"
        onClick={(e) => e.stopPropagation()}
        style={{
          ...btnBase,
          background: 'rgba(255,255,255,0.12)',
          textDecoration: 'none',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18, fontVariationSettings: "'FILL' 0", color: 'rgba(255,255,255,0.85)' }}>
          open_in_new
        </span>
      </a>
      {/* Error toast */}
      {actionError && (
        <div style={{
          position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(255,69,58,0.9)', color: '#fff',
          fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
          whiteSpace: 'nowrap', pointerEvents: 'none',
        }}>{actionError}</div>
      )}
    </div>
  );
}

// ── Download Card ───────────────────────────────────────────────────────────

const DownloadCard = memo(function DownloadCard({ torrent, info, sortData, onAction }) {
  const [hovered, setHovered] = useState(false);
  const state = getTorrentState(torrent);
  const color = STATE_COLOR[state];
  const rating = extractRating(info?.ratings);
  const runtime = formatRuntime(info?.runtime);
  const isActive = state === 'downloading';
  const displayProgress = state === 'completed' ? 100 : torrent.progress;

  let statusText = STATE_LABEL[state];
  if (state === 'downloading' && torrent.downloadSpeed > 0) {
    statusText = formatSpeed(torrent.downloadSpeed);
  } else if (state === 'seeding' && torrent.uploadSpeed > 0) {
    statusText = formatSpeed(torrent.uploadSpeed);
  }

  const displayTitle = info?.title || torrent.name;
  const hasInfo = info?.title;

  return (
    <div
      className="card carousel-item flex-none rounded-xl overflow-hidden bg-bg-card border border-border-subtle cursor-default"
      style={{ width: 260 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >

      {/* Poster area */}
      <div className="relative" style={{ height: 360 }}>
        <CardPoster url={info?.posterUrl || torrent.posterUrl} category={torrent.category} title={displayTitle} />

        {/* Hover controls overlay */}
        {hovered && (
          <HoverControls torrent={torrent} state={state} onAction={onAction} />
        )}

        {/* Gradient overlay at bottom of poster */}
        <div className="poster-overlay absolute inset-x-0 bottom-0" style={{ height: '60%' }} />

        {/* Progress bar overlay */}
        <div className="absolute inset-x-0 bottom-0 px-3 pb-3">
          {/* Status badge */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full flex-none" style={{ background: color }} />
              <span className="text-[11px] font-medium text-white/80 tabular-nums">{statusText}</span>
            </div>
            <span className="text-[10px] font-mono text-white/50 tabular-nums" style={{ minWidth: 56, textAlign: 'right', display: 'inline-block' }}>
              {state === 'downloading' && torrent.eta > 0 && torrent.eta < 8640000 ? formatETA(torrent.eta) : '\u00a0'}
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(displayProgress, 100)}%`,
                background: color,
                transition: 'width 800ms cubic-bezier(0.22, 0.61, 0.36, 1)',
              }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[11px] font-mono font-medium text-white tabular-nums">{displayProgress}%</span>
            <span className="text-[10px] font-mono text-white/40 tabular-nums">{formatBytes(torrent.size)}</span>
          </div>
        </div>

        {/* Status badge top-right */}
        <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/50 backdrop-blur-sm">
          <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: color }}>{STATE_LABEL[state]}</span>
        </div>

        {/* Ratio badge top-left for seeding */}
        {state === 'seeding' && torrent.ratio != null && (
          <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-black/60 backdrop-blur-sm">
            <span className="text-[10px] font-mono text-accent-orange">{torrent.ratio.toFixed(1)}x</span>
          </div>
        )}
      </div>

      {/* Info area below poster */}
      <div className="px-3 pt-2.5 pb-3">
        {/* Title */}
        <h3 className="text-[13px] font-semibold text-text-primary line-clamp-2 leading-snug">
          {displayTitle}{info?.year && hasInfo ? ` (${info.year})` : ''}
        </h3>

        {/* Episode info */}
        {info?.episodeNumber && (
          <p className="text-[11px] text-accent-blue font-medium mt-0.5">
            {info.episodeNumber}{info.episodeTitle ? ` · ${info.episodeTitle}` : ''}
          </p>
        )}

        {/* Metadata line */}
        {hasInfo && (
          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-text-muted flex-wrap">
            {rating && (
              <span className="flex items-center gap-0.5 text-accent-orange">
                <span className="material-symbols-rounded" style={{ fontSize: 11, fontVariationSettings: "'FILL' 1" }}>star</span>
                {rating}
              </span>
            )}
            {runtime && <span>{runtime}</span>}
            {info.network && <span>{info.network}</span>}
            {info.quality && <span>{info.quality}</span>}
          </div>
        )}

        {/* Genres */}
        {info?.genres?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {info.genres.slice(0, 3).map(g => <span key={g} className="genre-pill">{g}</span>)}
          </div>
        )}

        {/* Overview */}
        {info?.overview && (
          <p className="text-[10px] text-text-muted mt-1.5 line-clamp-2 leading-relaxed">{info.overview}</p>
        )}

        {/* Sort destination */}
        <SortLine sortData={sortData} />

        {/* Added date */}
        {torrent.addedOn && (
          <div className="text-[9px] text-text-muted mt-1.5 font-mono">
            Added {formatDate(torrent.addedOn)}
            {torrent.completedOn && ` · Done ${formatDate(torrent.completedOn)}`}
          </div>
        )}
      </div>
    </div>
  );
}, downloadCardEqual);

// Torrent polling recreates objects often, so memoization keys off painted fields only.
function downloadCardEqual(prev, next) {
  if (prev.onAction !== next.onAction) return false;
  if (prev.sortData !== next.sortData) return false;
  if (prev.info !== next.info) return false;
  const a = prev.torrent, b = next.torrent;
  if (a === b) return true;
  return a.hash === b.hash
    && a.progress === b.progress
    && a.downloadSpeed === b.downloadSpeed
    && a.uploadSpeed === b.uploadSpeed
    && a.eta === b.eta
    && a.state === b.state
    && a.size === b.size
    && a.ratio === b.ratio
    && a.completedOn === b.completedOn;
}

// ── Carousel Row ────────────────────────────────────────────────────────────

function CarouselRow({ title, icon, count, color, children }) {
  const scrollRef = useRef(null);

  const scroll = (dir) => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: dir * 560, behavior: 'smooth' });
  };

  if (count === 0) return null;

  return (
    <div className="mb-8">
      {/* Section header */}
      <div className="flex items-center gap-2.5 mb-3 px-8">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
        <h2 className="text-[16px] font-semibold text-text-primary">{title}</h2>
        <span className="text-[13px] text-text-muted font-mono">{count}</span>
        <div className="flex-1" />
        <button onClick={() => scroll(-1)} className="p-1 rounded-md hover:bg-bg-hover active:bg-bg-hover text-text-muted hover:text-text-primary active:text-text-primary transition-colors">
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>chevron_left</span>
        </button>
        <button onClick={() => scroll(1)} className="p-1 rounded-md hover:bg-bg-hover active:bg-bg-hover text-text-muted hover:text-text-primary active:text-text-primary transition-colors">
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>chevron_right</span>
        </button>
      </div>

      {/* Carousel */}
      <div className="carousel-container">
        <div ref={scrollRef} className="carousel flex gap-4 overflow-x-auto px-8 pb-2">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Skeleton Card ───────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="carousel-item flex-none rounded-xl overflow-hidden bg-bg-card border border-border-subtle" style={{ width: 260 }}>
      <div className="shimmer" style={{ height: 360 }} />
      <div className="px-3 pt-3 pb-3 space-y-2">
        <div className="shimmer rounded h-4 w-3/4" />
        <div className="shimmer rounded h-3 w-1/2" />
        <div className="shimmer rounded h-3 w-2/3" />
      </div>
    </div>
  );
}


// ── Group helpers ────────────────────────────────────────────────────────────

function extractSeriesName(name) {
  const base = (name || '').split('/').pop().replace(/\.\w+$/, '');
  // SxxExx — individual episode
  const m = base.match(/^(.+?)[.\s_-]+[Ss]\d{1,2}[Ee]\d{1,2}/);
  if (m) return m[1].replace(/[._]/g, ' ').trim();
  // Sxx — season pack (not followed by another digit)
  const m2 = base.match(/^(.+?)[.\s_-]+[Ss]\d{1,2}(?:\s|$|\.|_|-|[A-Z])/);
  if (m2) return m2[1].replace(/[._]/g, ' ').trim();
  // "Season X" spelled out
  const m3 = base.match(/^(.+?)[.\s_-]+[Ss]eason[.\s_-]*\d/i);
  if (m3) return m3[1].replace(/[._]/g, ' ').trim();
  return base.replace(/[._]/g, ' ').trim();
}

function extractSeasonLabel(t, tInfo) {
  if (tInfo?.episodeNumber) {
    const m = tInfo.episodeNumber.match(/[Ss](\d{1,2})/);
    return m ? 'S' + parseInt(m[1]) : tInfo.episodeNumber;
  }
  const name = t.name || '';
  // Individual episode
  const ep = name.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
  if (ep) return 'S' + parseInt(ep[1]) + 'E' + ep[2].padStart(2, '0');
  // Season pack
  const sp = name.match(/[Ss](\d{1,2})(?:\s|$|\.|_|-|[A-Z])/);
  if (sp) return 'S' + parseInt(sp[1]);
  return '?';
}

function extractSeasonNum(t, tInfo) {
  const label = extractSeasonLabel(t, tInfo);
  const m = label.match(/S(\d+)/);
  return m ? parseInt(m[1]) : 999;
}

function groupByShow(torrents, getInfo) {
  const map = new Map();
  torrents.forEach(t => {
    const info = getInfo(t.hash);
    const key = info?.title ?? extractSeriesName(t.name);
    if (!map.has(key)) map.set(key, { key, torrents: [], info: null, posterUrl: null });
    const g = map.get(key);
    g.torrents.push(t);
    if (!g.info && info) g.info = info;
    if (!g.posterUrl) g.posterUrl = info?.posterUrl || t.posterUrl || null;
  });
  return Array.from(map.values());
}

// ── Grouped Download Card ────────────────────────────────────────────────────

const GroupedDownloadCard = memo(function GroupedDownloadCard({ group, getInfo, onAction }) {
  const { torrents, info, key, posterUrl } = group;
  const [hovered, setHovered] = useState(false);
  const [ctrlBusy, setCtrlBusy] = useState(false);

  const anyDownloading = torrents.some(t => getTorrentState(t) === 'downloading');

  const handleBulk = async (action) => {
    setCtrlBusy(true);
    await Promise.all(torrents.map(t =>
      fetch(`/api/qbittorrent/torrents/${t.hash}/${action}`, { method: 'POST' }).catch(() => {})
    ));
    setCtrlBusy(false);
    if (onAction) onAction();
  };

  const totalSize      = torrents.reduce((s, t) => s + (t.size || 0), 0);
  const downloadedSize = torrents.reduce((s, t) => s + ((t.size || 0) * (t.progress || 0) / 100), 0);
  const overallProgress = totalSize > 0 ? downloadedSize / totalSize * 100 : 0;
  const totalSpeed     = torrents.reduce((s, t) => s + (t.downloadSpeed || 0), 0);
  const etaCandidates  = torrents.filter(t => t.eta > 0 && t.eta < 8640000).map(t => t.eta);
  const maxETA         = etaCandidates.length > 0 ? Math.max(...etaCandidates) : null;

  const sortedItems = [...torrents].sort((a, b) =>
    extractSeasonNum(a, getInfo(a.hash)) - extractSeasonNum(b, getInfo(b.hash))
  );

  const displayTitle = info?.title || key;

  return (
    <div
      className="card carousel-item flex-none rounded-xl overflow-hidden bg-bg-card border border-border-subtle cursor-default"
      style={{ width: 360 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ── Poster ── */}
      <div className="relative" style={{ height: 260 }}>
        <CardPoster url={info?.posterUrl || posterUrl} category={torrents[0]?.category} title={displayTitle} />

        {/* Pause/Resume all overlay on hover */}
        {hovered && (
          <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 12 }} onClick={e => e.stopPropagation()}>
            <button
              title={anyDownloading ? 'Pause all' : 'Resume all'}
              disabled={ctrlBusy}
              onClick={() => handleBulk(anyDownloading ? 'pause' : 'resume')}
              style={{ width: 34, height: 34, borderRadius: 8, border: 'none', cursor: ctrlBusy ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: anyDownloading ? 'rgba(255,159,10,0.8)' : 'rgba(48,209,88,0.8)',
                backdropFilter: 'blur(8px)', opacity: ctrlBusy ? 0.5 : 1 }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1", color: '#fff' }}>
                {ctrlBusy ? 'hourglass_empty' : anyDownloading ? 'pause' : 'play_arrow'}
              </span>
            </button>
          </div>
        )}

        {/* gradient — transparent top, heavy at bottom */}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0) 20%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0.93) 100%)' }}
        />

        {/* top-right: open in qBittorrent */}
        <a
          href={getServiceUrl('qbittorrent')}
          target="_blank" rel="noopener noreferrer"
          title="Open in qBittorrent"
          className="absolute top-3 right-3 flex items-center justify-center rounded-lg"
          style={{ width: 32, height: 32, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(10px)', textDecoration: 'none' }}
          onClick={e => e.stopPropagation()}
        >
          <span
            className="material-symbols-rounded"
            style={{ fontSize: 16, fontVariationSettings: "'FILL' 0", color: 'rgba(255,255,255,0.7)' }}
          >
            open_in_new
          </span>
        </a>

        {/* top-left: DOWNLOADING pill */}
        <div
          className="absolute top-3 left-3 px-2.5 py-1 rounded-lg"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(10px)' }}
        >
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#30d158' }}>
            Downloading
          </span>
        </div>

        {/* bottom: aggregate progress */}
        <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
          <div className="flex items-end justify-between mb-2.5">
            {/* big % number */}
            <span
              className="font-black text-white tabular-nums"
              style={{ fontSize: 38, lineHeight: 1, letterSpacing: '-0.03em' }}
            >
              {overallProgress.toFixed(1)}
              <span style={{ fontSize: 20, fontWeight: 700, opacity: 0.65 }}>%</span>
            </span>
            {/* speed + size */}
            <div className="text-right pb-0.5">
              {totalSpeed > 0 && (
                <div className="text-[14px] font-semibold tabular-nums" style={{ color: '#30d158' }}>
                  ↓ {formatSpeed(totalSpeed)}
                </div>
              )}
              <div className="text-[10px] font-mono text-white/50 tabular-nums mt-0.5">
                {formatBytes(downloadedSize)} / {formatBytes(totalSize)}
              </div>
              {maxETA && (
                <div className="text-[10px] font-mono text-white/35 mt-0.5">{formatETA(maxETA)} remaining</div>
              )}
            </div>
          </div>
          {/* fat progress bar */}
          <div className="h-2.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.12)' }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(overallProgress, 100)}%`,
                background: 'linear-gradient(90deg, #1db954, #30d158)',
                transition: 'width 800ms cubic-bezier(0.22, 0.61, 0.36, 1)',
                boxShadow: '0 0 8px rgba(48,209,88,0.4)',
              }}
            />
          </div>
        </div>
      </div>

      {/* ── Title block ── */}
      <div className="px-4 pt-3 pb-2.5 border-b border-border-subtle">
        <h3 className="text-[15px] font-bold text-text-primary leading-tight">
          {displayTitle}{info?.year ? ` (${info.year})` : ''}
        </h3>
        <p className="text-[11px] text-text-muted mt-0.5">
          {info?.network ? info.network + ' · ' : ''}
          {sortedItems.length} season{sortedItems.length !== 1 ? 's' : ''} downloading
        </p>
      </div>

      {/* ── Per-season rows ── */}
      <div className="px-4 pt-3 pb-4 space-y-3">
        {sortedItems.map(t => {
          const tInfo = getInfo(t.hash);
          const state = getTorrentState(t);
          const color = STATE_COLOR[state];
          const label = extractSeasonLabel(t, tInfo);
          const prog  = t.progress || 0;
          const speed = t.downloadSpeed || 0;
          const eta   = t.eta > 0 && t.eta < 8640000 ? t.eta : null;

          return (
            <div key={t.hash}>
              {/* label + bar + % */}
              <div className="flex items-center gap-2.5">
                <span
                  className="text-[10px] font-bold font-mono rounded-md flex-none text-center px-2 py-0.5"
                  style={{ background: 'rgba(48,209,88,0.15)', color: '#30d158', minWidth: 36 }}
                >
                  {label}
                </span>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.1)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(prog, 100)}%`, background: color, transition: 'width 800ms cubic-bezier(0.22, 0.61, 0.36, 1)' }}
                  />
                </div>
                <span
                  className="text-[11px] font-mono font-semibold tabular-nums flex-none text-right"
                  style={{ color, minWidth: 42 }}
                >
                  {prog.toFixed(1)}%
                </span>
              </div>
              {/* speed + size + eta */}
              <div className="flex items-center gap-3 mt-1" style={{ paddingLeft: 48 }}>
                {speed > 0 && (
                  <span className="text-[10px] font-mono font-medium tabular-nums" style={{ color: '#30d158' }}>
                    ↓ {formatSpeed(speed)}
                  </span>
                )}
                <span className="text-[10px] font-mono text-text-muted">{formatBytes(t.size || 0)}</span>
                {eta && <span className="text-[10px] font-mono text-text-muted">{formatETA(eta)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}, groupedDownloadCardEqual);

function groupedDownloadCardEqual(prev, next) {
  if (prev.onAction !== next.onAction) return false;
  if (prev.getInfo !== next.getInfo) return false;
  if (prev.group.key !== next.group.key) return false;
  const a = prev.group.torrents, b = next.group.torrents;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.hash !== y.hash
      || x.progress !== y.progress
      || x.downloadSpeed !== y.downloadSpeed
      || x.eta !== y.eta
      || x.size !== y.size
      || x.state !== y.state) return false;
  }
  return true;
}


// ── Main Export ──────────────────────────────────────────────────────────────

export default memo(function TorrentTable({ torrents, mediaInfo = {}, onRefresh }) {
  const [sortHistories, setSortHistories] = useState({});
  const prevStatesRef = useRef({});

  // Re-fetch sort history when a torrent transitions to seeding/completed —
  // clears stale HOLDING status from when it was still downloading.
  useEffect(() => {
    const toRefetch = [];
    torrents.forEach(t => {
      const state = getTorrentState(t);
      const prev = prevStatesRef.current[t.hash];
      if (prev && prev !== state && (state === 'seeding' || state === 'completed')) {
        toRefetch.push(t.hash);
      }
      prevStatesRef.current[t.hash] = state;
    });
    if (toRefetch.length > 0) {
      setSortHistories(prev => {
        const next = { ...prev };
        toRefetch.forEach(h => delete next[h]);
        return next;
      });
    }
  }, [torrents]);

  // Fetch sort history for all torrents that don't have it yet
  useEffect(() => {
    const hashes = torrents.map(t => t.hash);
    const missing = hashes.filter(h => !(h in sortHistories));
    if (missing.length === 0) return;

    // Fetch in batches of 5 to avoid flooding
    let i = 0;
    let cancelled = false;
    let timer = null;
    const fetchNext = () => {
      if (cancelled || i >= missing.length) return;
      const batch = missing.slice(i, i + 5);
      i += 5;
      batch.forEach(hash => {
        const t = torrents.find(t => t.hash === hash);
        if (!t) return;
        fetch(`/api/sort-history?search=${encodeURIComponent(t.name)}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (!cancelled) setSortHistories(prev => ({ ...prev, [hash]: data })); })
          .catch(() => { if (!cancelled) setSortHistories(prev => ({ ...prev, [hash]: [] })); });
      });
      timer = setTimeout(fetchNext, 500);
    };
    fetchNext();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [torrents]);

  const getInfo = (hash) => mediaInfo[hash] || mediaInfo[hash?.toLowerCase()] || null;

  const downloading = torrents.filter(t => getTorrentState(t) === 'downloading');
  const library = torrents.filter(t => getTorrentState(t) === 'seeding' || getTorrentState(t) === 'completed');
  const paused = torrents.filter(t => getTorrentState(t) === 'paused');
  const errored = torrents.filter(t => getTorrentState(t) === 'error');

  // Sort downloading by progress desc, library by ratio desc
  downloading.sort((a, b) => b.progress - a.progress);
  library.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));

  const downloadingGroups = groupByShow(downloading, getInfo);

  const noTorrents = torrents.length === 0;

  return (
    <div className="flex-1 overflow-y-auto scroll-area py-6">
      {noTorrents ? (
        <div className="flex flex-col items-center justify-center h-full text-text-muted">
          <span className="material-symbols-rounded mb-3" style={{ fontSize: 48, fontVariationSettings: "'FILL' 1" }}>cloud_done</span>
          <p className="text-[14px]">No active transfers</p>
        </div>
      ) : (
        <>
          <CarouselRow title="Downloading" icon="download" count={downloadingGroups.length} color="#30d158">
            {downloadingGroups.map(g =>
              g.torrents.length === 1
                ? <DownloadCard key={g.key} torrent={g.torrents[0]} info={g.info} sortData={sortHistories[g.torrents[0].hash]} onAction={onRefresh} />
                : <GroupedDownloadCard key={g.key} group={g} getInfo={getInfo} onAction={onRefresh} />
            )}
          </CarouselRow>

          <CarouselRow title="Library" icon="video_library" count={library.length} color="#0a84ff">
            {library.map(t => (
              <DownloadCard key={t.hash} torrent={t} info={getInfo(t.hash)} sortData={sortHistories[t.hash]} onAction={onRefresh} />
            ))}
          </CarouselRow>

          <CarouselRow title="Paused" icon="pause" count={paused.length} color="#636366">
            {paused.map(t => (
              <DownloadCard key={t.hash} torrent={t} info={getInfo(t.hash)} sortData={sortHistories[t.hash]} onAction={onRefresh} />
            ))}
          </CarouselRow>

          {errored.length > 0 && (
            <CarouselRow title="Error" icon="error" count={errored.length} color="#ef4444">
              {errored.map(t => (
                <DownloadCard key={t.hash} torrent={t} info={getInfo(t.hash)} sortData={sortHistories[t.hash]} onAction={onRefresh} />
              ))}
            </CarouselRow>
          )}
        </>
      )}
    </div>
  );
});
