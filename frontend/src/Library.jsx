import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';

// Inject shimmer + pill keyframes once (CSS-only, no new deps, no App.css edits)
if (typeof document !== 'undefined' && !document.getElementById('library-shimmer-style')) {
  const _s = document.createElement('style');
  _s.id = 'library-shimmer-style';
  _s.textContent = `@keyframes posterShimmer { 0% { background-position: -150% 0, 0 0; } 100% { background-position: 150% 0, 0 0; } } .pill-springy { transition: background-color 180ms ease, color 180ms ease, box-shadow 180ms ease, transform 220ms cubic-bezier(0.34,1.56,0.64,1); } .pill-springy:active { transform: scale(0.94); } .library-grid-fade { animation: gridFadeIn 220ms ease-out; } @keyframes gridFadeIn { from { opacity: 0; } to { opacity: 1; } } @media (prefers-reduced-motion: reduce) { .library-grid-fade { animation: none !important; } .pill-springy { transition: none !important; } }`;
  document.head.appendChild(_s);
}

import { formatBytes, gradientFor, extractRating, detectQualityLabel } from './utils';
import { apiFetch, apiPost, getApiErrorDetails } from './api';

function useAnimatedClose(onClose, duration = 200) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef(null);
  const close = useCallback(() => {
    setClosing(true);
    timerRef.current = setTimeout(onClose, duration);
  }, [onClose, duration]);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return { closing, close };
}

const TYPE_FILTERS = [
  { key: 'all', label: 'All', icon: 'apps' },
  { key: 'series', label: 'TV', icon: 'tv' },
  { key: 'movie', label: 'Movies', icon: 'movie' },
  { key: 'music', label: 'Music', icon: 'album' },
  { key: 'missing', label: 'Missing', icon: 'warning' },
];

function isServiceIssueStatus(status) {
  return !['ready', 'up', 'unconfigured', null, undefined].includes(status);
}

function isSetupAdjacentError(error) {
  const details = getApiErrorDetails(error);
  if (!details) return false;
  const text = `${details.message || ''} ${details.endpoint || ''}`.toLowerCase();
  return (
    [409, 423, 424, 429, 500, 502, 503, 504].includes(details.status) ||
    /setup|install|token|auth|not ready|not configured|unconfigured|unavailable|restart|recover/.test(text)
  );
}

function LibraryErrorNotice({ error, title, tone = 'error' }) {
  const details = getApiErrorDetails(error);
  if (!details) return null;
  const accent = tone === 'warning' ? 'text-accent-orange' : 'text-accent-red';
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
    <div className="mt-1">
      {title && <p className={`text-[11px] uppercase tracking-[0.08em] font-semibold ${accent}`}>{title}</p>}
      <p className={`text-[12px] ${accent}`}>{details.message}</p>
      {meta.length > 0 && (
        <p className="text-[11px] text-text-muted mt-1">{meta.join(' · ')}</p>
      )}
      {details.warnings.length > 0 && (
        <p className="text-[11px] text-text-muted mt-1">Warnings: {details.warnings.join(' · ')}</p>
      )}
    </div>
  );
}

// ── Shared Poster Component ─────────────────────────────────────────────────

function PosterImg({ url, fallbackIcon, title }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  if (!url || failed) {
    return (
      <div className="absolute inset-0 flex items-center justify-center" style={{ background: gradientFor(title) }}>
        <span className="material-symbols-rounded" style={{ fontSize: 40, fontVariationSettings: "'FILL' 1", color: "rgba(255,255,255,0.25)" }}>{fallbackIcon}</span>
      </div>
    );
  }
  const src = url.startsWith('/api/') ? url : `/api/poster?url=${encodeURIComponent(url)}`;
  return (
    <img
        src={src}
        alt={title}
        decoding="async"
        onError={() => setFailed(true)}
        className="absolute inset-0 w-full h-full object-cover"
        style={{ opacity: 1, transition: 'opacity 320ms ease-out' }}
      />
  );
}




function Select({ label, value, onChange, options, className }) {
  return (
    <div className={className}>
      <label className="block text-[11px] text-text-muted mb-1 font-medium">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="add-select w-full px-3 py-2 bg-bg-card border border-border-subtle rounded-lg text-[12px] text-text-primary focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30 appearance-none cursor-pointer"
      >
        {options.map(o => <option key={o.value ?? o.id} value={o.value ?? o.id}>{o.label ?? o.name}</option>)}
      </select>
    </div>
  );
}

// ── Manual Search View ──────────────────────────────────────────────────────


const QUALITY_ORDER = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'HDTV': 4, 'WEB': 5, 'BluRay': 6, 'CAM': 7, 'Other': 8 };

function normalizeProfileName(name) {
  return String(name || '').toLowerCase();
}

function selectDefaultQualityProfileId(qualityProfiles, mediaType) {
  if (!Array.isArray(qualityProfiles) || qualityProfiles.length === 0) return null;
  const normalized = qualityProfiles.map(profile => ({
    ...profile,
    _name: normalizeProfileName(profile?.name),
  }));
  const findByPatterns = (patterns) => normalized.find(({ _name }) => patterns.some(pattern => pattern.test(_name)))?.id;

  if (mediaType === 'music') {
    return findByPatterns([/\blossless\b/]) || normalized[0].id;
  }

  if (mediaType === 'series' || mediaType === 'movie') {
    const ultra = findByPatterns([/\b2160p\b/, /\b4k\b/, /\bultra[-\s]?hd\b/, /\buhd\b/]);
    if (ultra) return ultra;
    const sense = findByPatterns([/\bhd - 720p\/1080p\b/, /\bhd[-\s]?1080p\b/, /\b1080p\b/, /\b1080\b/]);
    if (sense) return sense;
    const fallback = findByPatterns([/\b720p\b/, /\bhd\b/]);
    if (fallback) return fallback;
    return normalized[0].id;
  }

  return normalized[0].id;
}

function detectResolution(text) {
  if (/2160p|4k(?!\w)|uhd/i.test(text)) return '2160p';
  if (/1080p/i.test(text)) return '1080p';
  if (/720p/i.test(text)) return '720p';
  if (/576p|480p/i.test(text)) return '480p';
  return null;
}

function detectSource(text) {
  if (/remux/i.test(text)) return 'Remux';
  if (/blu-?ray|bdrip|brrip|bdremux/i.test(text)) return 'Bluray';
  if (/web-?dl|webdl/i.test(text)) return 'WEBDL';
  if (/webrip/i.test(text)) return 'WEBRip';
  if (/hdtv/i.test(text)) return 'HDTV';
  if (/dvdrip|dvdscr|dvd/i.test(text)) return 'DVD';
  if (/\bcam\b|telesync|\bts\b|telecine/i.test(text)) return 'CAM';
  return 'Unknown';
}

function detectCodec(title) {
  const t = title || '';
  if (/\bAV1\b/i.test(t)) return 'AV1';
  if (/\bHEVC\b|\bx265\b|h\.?265/i.test(t)) return 'x265';
  if (/\bx264\b|\bh\.?264\b|\bAVC\b/i.test(t)) return 'x264';
  return null;
}

function ManualSearchView({ service, id, seasonNumber, title, onGrabbed }) {
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('smart');
  const [sortDir, setSortDir] = useState('desc');
  const [exactMatchOnly, setExactMatchOnly] = useState(false);
  const [qualityFilters, setQualityFilters] = useState([]);
  const [minSeeders, setMinSeeders] = useState(0);
  const [showCount, setShowCount] = useState(50);
  const [grabbing, setGrabbing] = useState(null);
  const [grabResult, setGrabResult] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null); setReleases([]);
    setQualityFilters([]); setMinSeeders(0); setShowCount(50);
    let url;
    if (id) {
      url = `/api/manual-search?service=${service}&id=${id}${seasonNumber ? `&seasonNumber=${seasonNumber}` : ''}`;
    } else if (title) {
      let q = title;
      if (seasonNumber && service === 'sonarr') q += ` S${String(seasonNumber).padStart(2, '0')}`;
      url = `/api/fast-search?query=${encodeURIComponent(q)}&service=${service}`;
    }
    if (!url) {
      setError('Missing manual-search target');
      setLoading(false);
      return;
    }
    apiFetch(url)
      .then(data => { setReleases(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(e => { setError(String(e)); setLoading(false); });
  }, [service, id, seasonNumber, title]);

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const toggleQuality = (q) => {
    setQualityFilters(prev => prev.includes(q) ? prev.filter(x => x !== q) : [...prev, q]);
    setShowCount(50);
  };

  // Build sorted+filtered set
  const { sorted, allQualities } = useMemo(() => {
    let filtered = exactMatchOnly ? releases.filter(r => !r.rejected) : releases;
    if (qualityFilters.length > 0) filtered = filtered.filter(r => qualityFilters.includes(detectQualityLabel(r)));
    if (minSeeders > 0) filtered = filtered.filter(r => (r.seeders || 0) >= minSeeders);

    const _maxSeeders = Math.max(1, ...filtered.map(r => r.seeders || 0));
    const RES_SCORE = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
    const SRC_SCORE = { Remux: 5, Bluray: 4, WEBDL: 3, WEBRip: 2, HDTV: 1, DVD: 1, CAM: 0, Unknown: 1 };
    const smartScore = r => {
      const combined = (r.quality || '') + ' ' + (r.title || '');
      const resScore = RES_SCORE[detectResolution(combined)] ?? 0;
      const srcScore = SRC_SCORE[detectSource(combined)] ?? 1;
      // resolution is primary (5x weight), source is secondary tiebreaker
      const qualNorm = (resScore * 5 + srcScore) / 25;
      // penalize files >40 GB (remux overkill) or suspiciously tiny <300 MB
      const sizeGB = (r.size || 0) / 1073741824;
      const sizePenalty = sizeGB > 40 ? Math.max(0.4, 1 - (sizeGB - 40) / 100)
                        : sizeGB > 0 && sizeGB < 0.3 ? 0.65 : 1.0;
      // seeder floor: dead torrents rank last regardless of quality
      const seeders = r.seeders || 0;
      const seederFloor = seeders < 5 ? 0.2 : seeders < 15 ? 0.6 : seeders < 30 ? 0.85 : 1.0;
      const seedNorm = seeders / _maxSeeders;
      return (qualNorm * sizePenalty * 0.65 + seedNorm * 0.35) * seederFloor;
    };
    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'smart') cmp = smartScore(b) - smartScore(a);
      else if (sortBy === 'seeders') cmp = (b.seeders || 0) - (a.seeders || 0);
      else if (sortBy === 'size') cmp = (b.size || 0) - (a.size || 0);
      else if (sortBy === 'quality') cmp = (QUALITY_ORDER[detectQualityLabel(a)] ?? 99) - (QUALITY_ORDER[detectQualityLabel(b)] ?? 99);
      else cmp = (b.seeders || 0) - (a.seeders || 0) || (b.size || 0) - (a.size || 0);
      return sortDir === 'asc' ? -cmp : cmp;
    });
    // Unique quality labels across ALL releases (not filtered) for the chips
    const allQualities = [...new Set(releases.map(r => detectQualityLabel(r)))]
      .sort((a, b) => (QUALITY_ORDER[a] ?? 99) - (QUALITY_ORDER[b] ?? 99));
    return { sorted, allQualities };
  }, [releases, exactMatchOnly, qualityFilters, minSeeders, sortBy, sortDir]);

  const visible = sorted.slice(0, showCount);
  const hasMore = sorted.length > showCount;

  const handleGrab = async (r) => {
    setGrabbing(r.guid); setGrabResult(null);
    try {
      await apiPost('/api/grab', { service, guid: r.guid, indexerId: r.indexerId, downloadUrl: r.downloadUrl || undefined, title: r.title });
      setGrabResult({ success: true, message: `Grabbed "${r.title}"` });
      onGrabbed?.();
    } catch (e) { setGrabResult({ success: false, message: e.message }); }
    setGrabbing(null);
  };

  return (
    <div className="mt-3">
      {/* ── Top control bar: Exact Match + Sort ── */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <button
          onClick={() => setExactMatchOnly(v => !v)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-colors ${exactMatchOnly ? 'bg-accent-blue/15 border-accent-blue/30 text-accent-blue' : 'bg-bg-surface border-border-subtle text-text-muted hover:text-text-primary'}`}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 11, fontVariationSettings: "'FILL' 1" }}>filter_alt</span>
          Exact Match
        </button>
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[10px] text-text-muted mr-0.5">Sort:</span>
          {[['smart', 'Smart'], ['seeders', 'Seeds'], ['size', 'Size'], ['quality', 'Quality']].map(([val, label]) => (
            <button key={val} onClick={() => toggleSort(val)}
              className={`px-2 py-1 rounded-lg text-[10px] font-semibold border transition-colors inline-flex items-center gap-0.5 ${sortBy === val ? 'bg-accent-blue/15 border-accent-blue/30 text-accent-blue' : 'bg-bg-surface border-border-subtle text-text-muted hover:text-text-primary'}`}
            >
              {label}
              {sortBy === val && <span style={{ fontSize: 9 }}>{sortDir === 'desc' ? '↓' : '↑'}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Quality chips + Min seeders (only when results are loaded) ── */}
      {!loading && releases.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mb-2 pb-2 border-b border-border-subtle/50">
          {allQualities.length > 1 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[9px] font-bold text-text-muted uppercase tracking-widest">Q:</span>
              {allQualities.map(q => (
                <button key={q} onClick={() => toggleQuality(q)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors ${qualityFilters.includes(q) ? 'bg-accent-blue/20 border-accent-blue/40 text-accent-blue' : 'bg-bg-surface border-border-subtle text-text-muted hover:text-text-primary'}`}
                >{q}</button>
              ))}
              {qualityFilters.length > 0 && (
                <button onClick={() => setQualityFilters([])}
                  className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-border-subtle bg-bg-surface text-text-muted hover:text-text-primary transition-colors"
                >✕</button>
              )}
            </div>
          )}
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-widest">Seeds:</span>
            {[[0,'Any'],[10,'10+'],[25,'25+'],[50,'50+']].map(([val, label]) => (
              <button key={val} onClick={() => { setMinSeeders(val); setShowCount(50); }}
                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors ${minSeeders === val ? 'bg-accent-green/15 border-accent-green/40 text-accent-green' : 'bg-bg-surface border-border-subtle text-text-muted hover:text-text-primary'}`}
              >{label}</button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6 gap-2">
          <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 18 }}>progress_activity</span>
          <span className="text-[12px] text-text-muted">Searching indexers...</span>
        </div>
      ) : error ? (
        <p className="text-[12px] text-accent-red text-center py-4">{error}</p>
      ) : sorted.length === 0 ? (
        <div className="py-4 text-center">
          <p className="text-[12px] text-text-muted mb-2">
            {exactMatchOnly && releases.filter(r => r.rejected).length > 0
              ? `No exact matches — toggle filter to see ${releases.length} rejected release${releases.length !== 1 ? 's' : ''}`
              : (qualityFilters.length > 0 || minSeeders > 0)
              ? `No results match current filters — ${releases.length} total available`
              : 'No releases found from indexers'}
          </p>
          {exactMatchOnly && releases.filter(r => r.rejected).length > 0 && (() => {
            const rejected = releases.filter(r => r.rejected);
            const counts = {};
            for (const r of rejected) {
              for (const rej of (r.rejections || [])) {
                const cat = rej.includes('alias') ? 'Title alias conflict'
                  : rej.includes('seeders') ? 'No seeders'
                  : rej.includes('not wanted in profile') ? 'Quality profile'
                  : rej.includes('Unknown') ? 'Unrecognized'
                  : rej.includes('Wrong season') ? 'Wrong season'
                  : rej.includes('Existing file') ? 'Already downloaded'
                  : rej.includes('Episode wasn') ? 'Not monitored'
                  : 'Other';
                counts[cat] = (counts[cat] || 0) + 1;
              }
            }
            const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
            if (entries.length === 0) return null;
            return (
              <div className="inline-flex flex-col items-start gap-1 bg-white/[0.04] rounded-lg px-4 py-2.5 text-left">
                <div className="text-[9px] font-bold text-text-muted uppercase tracking-widest mb-1">Why rejected</div>
                {entries.map(([cat, count]) => (
                  <div key={cat} className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-amber-400 font-mono w-7 text-right">{count}×</span>
                    <span className="text-[11px] text-text-muted">{cat}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      ) : (
        <>
          {/* ── Result count ── */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] text-text-muted flex-1">
              Showing {visible.length} of {sorted.length} result{sorted.length !== 1 ? 's' : ''}
              {releases.length > sorted.length ? ` · ${releases.length - sorted.length} hidden by filters` : ''}
            </span>
            {sorted.length > 0 && !grabResult?.success && (
              <button
                onClick={() => handleGrab(sorted[0])}
                disabled={!!grabbing}
                className="flex-none flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-accent-blue/10 border border-accent-blue/25 text-accent-blue hover:bg-accent-blue/20 disabled:opacity-40 transition-colors"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 12, fontVariationSettings: "'FILL' 1" }}>bolt</span>
                Grab Best
              </button>
            )}
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto scroll-area">
            {visible.map((r, i) => (
              <div key={r.guid || i} className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-surface border transition-colors hover:bg-bg-hover/50 ${i === 0 && sortBy === 'smart' ? 'border-accent-blue/30' : 'border-border-subtle'}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {i === 0 && sortBy === 'smart' && (
                      <span className="flex-none text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-accent-blue/15 border border-accent-blue/30 text-accent-blue leading-none">★</span>
                    )}
                    <div className="text-[11px] font-medium text-text-primary truncate">{r.title}</div>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-[10px] text-text-muted">{r.indexer}</span>
                    <span className="text-[10px] font-medium text-accent-blue">{r.quality}</span>
                    {detectCodec(r.title) && (
                      <span className={`text-[9px] font-mono font-bold px-1 py-0.5 rounded ${detectCodec(r.title) === 'AV1' ? 'bg-purple-500/15 text-purple-400' : detectCodec(r.title) === 'x265' ? 'bg-accent-green/10 text-accent-green' : 'bg-white/[0.06] text-text-muted'}`}>{detectCodec(r.title)}</span>
                    )}
                    <span className="text-[10px] font-mono text-text-muted">{formatBytes(r.size)}</span>
                    <span className={`text-[10px] font-semibold ${r.seeders >= 10 ? 'text-accent-green' : r.seeders >= 3 ? 'text-accent-orange' : 'text-accent-red'}`}>{r.seeders}↑ {r.leechers}↓</span>
                    <span className="text-[10px] text-text-muted">{r.ageHours < 24 ? `${Math.round(r.ageHours)}h` : `${Math.round(r.ageHours / 24)}d`}</span>
                  </div>
                </div>
                <button onClick={() => handleGrab(r)} disabled={!!grabbing}
                  className={`flex-none px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap ${grabbing === r.guid ? 'bg-bg-surface-2 text-text-muted cursor-not-allowed' : grabResult?.success ? 'bg-accent-green/15 text-accent-green border border-accent-green/30 cursor-not-allowed' : 'bg-accent-blue text-white hover:bg-accent-blue/90'}`}
                >
                  {grabbing === r.guid ? '...' : 'Grab'}
                </button>
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={() => setShowCount(c => c + 50)}
              className="mt-2 w-full py-1.5 rounded-lg text-[11px] font-semibold border border-border-subtle bg-bg-surface text-text-muted hover:text-text-primary transition-colors"
            >
              Show more ({sorted.length - showCount} remaining)
            </button>
          )}
        </>
      )}
      {grabResult && (
        <div className={`mt-2 px-3 py-2 rounded-lg text-[11px] font-medium ${grabResult.success ? 'bg-accent-green/10 text-accent-green border border-accent-green/20' : 'bg-accent-red/10 text-accent-red border border-accent-red/20'}`}>
          {grabResult.message}
        </div>
      )}
    </div>
  );
}

// ── Season Selector ─────────────────────────────────────────────────────────

function SeasonSelector({ seasons, selected, onChange }) {
  if (!seasons?.length) return null;
  const selectableSeasons = seasons.filter(s => s.seasonNumber > 0);
  if (!selectableSeasons.length) return null;
  const toggleSeason = (sn) => {
    onChange(selected.includes(sn) ? selected.filter(s => s !== sn) : [...selected, sn]);
  };
  const selectableSeasonNumbers = selectableSeasons.map(s => s.seasonNumber);
  const allSelected = selectableSeasonNumbers.every(sn => selected.includes(sn));
  const toggleAll = () => {
    onChange(allSelected
      ? selected.filter(sn => !selectableSeasonNumbers.includes(sn))
      : Array.from(new Set([...selected, ...selectableSeasonNumbers]))
    );
  };
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <label className="text-[11px] text-text-muted font-medium">Select Seasons</label>
        <button onClick={toggleAll} className="text-[10px] text-accent-blue hover:underline">{allSelected ? 'Unselect All' : 'Select All'}</button>
      </div>
      <div className="space-y-1 max-h-40 overflow-y-auto scroll-area">
        {selectableSeasons.map(s => (
          <label key={s.seasonNumber} className="flex items-center gap-2.5 px-3 py-1.5 rounded-md hover:bg-bg-hover cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={selected.includes(s.seasonNumber)}
              onChange={() => toggleSeason(s.seasonNumber)}
              className="w-3.5 h-3.5 rounded border-border-medium text-accent-blue focus:ring-accent-blue/30 cursor-pointer"
            />
            <span className="text-[12px] text-text-primary flex-1">Season {s.seasonNumber}</span>
            {s.episodeCount > 0 && <span className="text-[10px] text-text-muted font-mono">{s.episodeCount} ep</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Album Selector (for library download) ───────────────────────────────────

function AlbumSelector({ albums, selected, onChange }) {
  if (!albums?.length) return null;
  const toggle = (id) => {
    onChange(selected.includes(id) ? selected.filter(a => a !== id) : [...selected, id]);
  };
  const missing = albums.filter(a => a.trackFileCount < a.trackCount);
  const selectMissing = () => onChange(missing.map(a => a.id));
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <label className="text-[11px] text-text-muted font-medium">Select Albums</label>
        {missing.length > 0 && (
          <button onClick={selectMissing} className="text-[10px] text-accent-blue hover:underline">Select Missing ({missing.length})</button>
        )}
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto scroll-area">
        {albums.map(a => (
          <label key={a.id} className="flex items-center gap-2.5 px-3 py-1.5 rounded-md hover:bg-bg-hover cursor-pointer transition-colors">
            <input
              type="checkbox"
              checked={selected.includes(a.id)}
              onChange={() => toggle(a.id)}
              className="w-3.5 h-3.5 rounded border-border-medium text-accent-blue focus:ring-accent-blue/30 cursor-pointer"
            />
            <span className="text-[12px] text-text-primary flex-1 truncate">{a.title}</span>
            <span className={`text-[10px] font-mono ${a.trackFileCount === a.trackCount && a.trackCount > 0 ? 'text-accent-green' : 'text-accent-orange'}`}>
              {a.trackFileCount}/{a.trackCount}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Series Detail Modal ─────────────────────────────────────────────────────

function SeriesDetail({ seriesId, onClose, onDelete }) {
  const { closing, close } = useAnimatedClose(onClose);
  const [episodes, setEpisodes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedSeason, setExpandedSeason] = useState(null);
  const [expandedEpisode, setExpandedEpisode] = useState(null);
  const [selectedSeasons, setSelectedSeasons] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [manualMode, setManualMode] = useState(false);

  const fetchEpisodes = (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    fetch(`/api/library/series/${seriesId}/episodes`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { setEpisodes(data?.seasons || {}); })
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  };

  useEffect(() => { fetchEpisodes(); }, [seriesId]);

  const seasonNums = episodes ? Object.keys(episodes).map(Number).sort((a, b) => a - b) : [];
  const missingSeason = (sn) => (episodes[sn] || []).filter(e => !e.hasFile).length;
  const totalMissing = seasonNums.reduce((acc, sn) => acc + missingSeason(sn), 0);
  const allComplete = !loading && seasonNums.length > 0 && totalMissing === 0;

  const selectedComplete = selectedSeasons.filter(sn => missingSeason(sn) === 0);
  const selectedStillMissing = selectedSeasons.filter(sn => missingSeason(sn) > 0);

  const handleDownload = async () => {
    if (selectedSeasons.length === 0) return;
    setSearching(true);
    setSearchResult(null);
    try {
      const resp = await fetch('/api/command/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'sonarr', id: seriesId, seasonNumbers: selectedSeasons }),
      });
      const data = await resp.json();
      setSearchResult(resp.ok ? { success: true, message: `Search triggered for ${selectedSeasons.length} season(s) — check back soon` } : { success: false, message: data.error });
    } catch (err) { setSearchResult({ success: false, message: err.message }); }
    setSearching(false);
  };

  const handleDelete = async (deleteFiles) => {
    setDeleting(true);
    try {
      const resp = await fetch(`/api/delete/series/${seriesId}?deleteFiles=${deleteFiles}`, { method: 'DELETE' });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.substring(0, 100) || 'Delete failed'); }
      onDelete?.();
      onClose();
    } catch (err) { setSearchResult({ success: false, message: `Delete failed: ${err.message}` }); }
    setDeleting(false);
    setConfirmDelete(false);
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[20px] ${closing ? 'modal-backdrop-exit' : 'modal-backdrop-enter'}`} onClick={close}>
      <div className={`bg-bg-card rounded-2xl border border-border-subtle shadow-xl max-w-2xl w-full mx-4 max-h-[85vh] flex flex-col ${closing ? 'modal-exit' : 'modal-enter'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <h3 className="text-[15px] font-semibold text-text-primary">Seasons & Episodes</h3>
          <div className="flex items-center gap-1">
            <button onClick={() => fetchEpisodes(true)} disabled={refreshing}
              className="p-1 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors" title="Refresh">
              <span className={`material-symbols-rounded ${refreshing ? 'animate-spin' : ''}`} style={{ fontSize: 18 }}>refresh</span>
            </button>
            <button onClick={() => setConfirmDelete(!confirmDelete)}
              className="p-1 rounded-md hover:bg-accent-red/10 text-text-muted hover:text-accent-red transition-colors" title="Delete series">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>delete</span>
            </button>
            <button onClick={close} className="p-1 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
            </button>
          </div>
        </div>
        {confirmDelete && (
          <div className="px-5 py-3 bg-accent-red/5 border-b border-accent-red/20">
            <p className="text-[12px] text-accent-red font-medium mb-2">Delete this series?</p>
            <div className="flex items-center gap-2">
              <button onClick={() => handleDelete(true)} disabled={deleting}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-accent-red text-white hover:bg-accent-red/90 disabled:opacity-50">
                {deleting ? 'Deleting...' : 'Delete + Remove Files'}
              </button>
              <button onClick={() => handleDelete(false)} disabled={deleting}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-bg-surface border border-border-subtle text-text-primary hover:bg-bg-hover disabled:opacity-50">
                Remove from Sonarr Only
              </button>
              <button onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto scroll-area p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 24 }}>progress_activity</span>
            </div>
          ) : seasonNums.length === 0 ? (
            <p className="text-center text-text-muted text-[13px] py-8">No episodes found</p>
          ) : (
            <div className="space-y-1.5">
              {seasonNums.map(sn => {
                const eps = episodes[sn];
                const downloaded = eps.filter(e => e.hasFile).length;
                const missing = eps.length - downloaded;
                const isOpen = expandedSeason === sn;
                const isSelected = selectedSeasons.includes(sn);
                const seasonComplete = missing === 0;
                return (
                  <div key={sn} className={`rounded-lg border overflow-hidden ${seasonComplete ? 'border-accent-green/20' : 'border-border-subtle'}`}>
                    <div className={`flex items-center gap-2 px-4 py-2.5 hover:bg-bg-hover transition-colors ${seasonComplete ? 'bg-accent-green/5' : ''}`}>
                      {missing > 0 ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => setSelectedSeasons(prev => isSelected ? prev.filter(s => s !== sn) : [...prev, sn])}
                          className="w-3.5 h-3.5 rounded border-border-medium text-accent-blue focus:ring-accent-blue/30 cursor-pointer"
                        />
                      ) : (
                        <span className="material-symbols-rounded text-accent-green" style={{ fontSize: 16 }}>check_circle</span>
                      )}
                      <button
                        onClick={() => setExpandedSeason(isOpen ? null : sn)}
                        className="flex items-center gap-2 flex-1 text-left"
                      >
                        <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 18, transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' }}>chevron_right</span>
                        <span className="text-[13px] font-semibold text-text-primary">
                          {sn === 0 ? 'Specials' : `Season ${sn}`}
                        </span>
                        {seasonComplete && <span className="text-[10px] font-semibold text-accent-green">Complete</span>}
                      </button>
                      <span className="text-[11px] font-mono text-text-muted">
                        <span className={seasonComplete ? 'text-accent-green' : 'text-accent-orange'}>{downloaded}</span>/{eps.length}
                      </span>
                      <div className="w-16 h-1 rounded-full bg-bg-surface-2 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${eps.length > 0 ? (downloaded / eps.length) * 100 : 0}%`, background: seasonComplete ? '#16a34a' : '#d97706' }} />
                      </div>
                    </div>
                    {isOpen && (
                      <div className="border-t border-border-subtle">
                        {eps.map(ep => {
                          const epExpanded = expandedEpisode === ep.id;
                          return (
                            <div key={ep.id} className="border-b border-border-subtle last:border-b-0">
                              <div
                                className={`px-4 py-2 hover:bg-bg-hover/50 ${ep.hasFile ? 'cursor-pointer' : ''}`}
                                onClick={() => ep.hasFile && setExpandedEpisode(epExpanded ? null : ep.id)}
                              >
                                <div className="flex items-center gap-2 text-[12px]">
                                  {ep.imageUrl && (
                                    <div className="w-[72px] h-[40px] rounded flex-none overflow-hidden relative bg-bg-surface-2 flex-shrink-0">
                                      <img
                                        src={ep.imageUrl}
                                        alt=""
                                        className="absolute inset-0 w-full h-full object-cover"
                                        loading="eager"
                                        onError={e => { e.target.style.display = 'none'; e.target.parentElement.style.display = 'none'; }}
                                      />
                                    </div>
                                  )}
                                  <span className="font-mono text-text-muted w-8 text-right flex-none">E{String(ep.episodeNumber).padStart(2, '0')}</span>
                                  <span className={`w-2 h-2 rounded-full flex-none ${ep.hasFile ? 'bg-accent-green' : 'bg-border-medium'}`} />
                                  <span className="text-text-primary truncate flex-1">{ep.title || 'TBA'}</span>
                                  {ep.runTime && <span className="text-[10px] font-mono text-text-muted flex-none">{ep.runTime}</span>}
                                  {!ep.runTime && ep.runtime && <span className="text-[10px] font-mono text-text-muted flex-none">{ep.runtime}m</span>}
                                  {ep.quality && <span className="text-[10px] font-mono text-accent-blue flex-none">{ep.quality}</span>}
                                  {ep.size > 0 && <span className="text-[10px] font-mono text-text-muted flex-none">{formatBytes(ep.size)}</span>}
                                  {ep.hasFile && <span className="material-symbols-rounded text-text-muted/50 flex-none" style={{ fontSize: 13 }}>{epExpanded ? 'expand_less' : 'expand_more'}</span>}
                                </div>
                              </div>
                              {epExpanded && ep.hasFile && (
                                <div className="px-4 pb-3 bg-bg-surface/50 border-t border-border-subtle/50">
                                  <div className="ml-11 pt-2 space-y-1.5">
                                    <div className="flex flex-wrap gap-1.5 items-center">
                                      {ep.resolution && <span className="text-[9px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-muted">{ep.resolution}</span>}
                                      {ep.videoCodec && <span className="text-[9px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-muted">{ep.videoCodec}</span>}
                                      {ep.dynamicRange && ep.dynamicRange !== 'SDR' && <span className="text-[9px] font-mono bg-accent-orange/10 border border-accent-orange/30 rounded px-1.5 py-0.5 text-accent-orange">{ep.dynamicRange}</span>}
                                      {ep.audioCodec && <span className="text-[9px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-muted">{ep.audioCodec}{ep.audioChannels ? ` ${ep.audioChannels}ch` : ''}</span>}
                                      {ep.audioLanguages && <span className="text-[9px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-muted">{ep.audioLanguages}</span>}
                                      {ep.subtitles && <span className="text-[9px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-muted">Sub: {ep.subtitles}</span>}
                                    </div>
                                    {ep.filePath && (
                                      <div className="flex items-start gap-1.5">
                                        <span className="material-symbols-rounded text-text-muted/60 mt-px flex-none" style={{ fontSize: 12 }}>folder</span>
                                        <span className="text-[10px] font-mono text-text-muted/70 break-all leading-relaxed">{ep.filePath}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* Footer: completion status or download controls */}
        {!loading && seasonNums.length > 0 && (
          <div className="px-5 py-3 border-t border-border-subtle bg-bg-surface">
            {allComplete ? (
              <div className="flex items-center gap-2 py-1">
                <span className="material-symbols-rounded text-accent-green" style={{ fontSize: 20 }}>check_circle</span>
                <div>
                  <p className="text-[12px] font-semibold text-accent-green">All content downloaded</p>
                  <p className="text-[10px] text-text-muted">{seasonNums.filter(sn => sn > 0).length} season(s) · {seasonNums.reduce((a, sn) => a + (episodes[sn]?.length || 0), 0)} episodes</p>
                </div>
              </div>
            ) : (
              <>
                {selectedSeasons.length > 0 && selectedComplete.length > 0 && (
                  <div className="mb-2 px-3 py-2 rounded-lg text-[11px] font-medium bg-accent-green/10 text-accent-green">
                    Season(s) {selectedComplete.map(sn => sn === 0 ? 'Specials' : `S${String(sn).padStart(2, '0')}`).join(', ')} — complete
                    {selectedStillMissing.length > 0 && <span className="text-accent-orange"> · {selectedStillMissing.map(sn => sn === 0 ? 'Specials' : `S${String(sn).padStart(2, '0')}`).join(', ')} still downloading ({selectedStillMissing.reduce((a, sn) => a + missingSeason(sn), 0)} ep missing)</span>}
                  </div>
                )}
                {searchResult && (
                  <div className={`mb-2 px-3 py-2 rounded-lg text-[11px] font-medium ${searchResult.success ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'}`}>
                    {searchResult.message}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-text-muted">
                    {totalMissing} episode{totalMissing !== 1 ? 's' : ''} missing · {selectedSeasons.length} season(s) selected
                    {selectedSeasons.length === 0 && (
                      <button onClick={() => setSelectedSeasons(seasonNums.filter(sn => missingSeason(sn) > 0))}
                        className="text-accent-blue hover:underline ml-2">Select all missing</button>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setManualMode(v => !v)}
                      disabled={selectedSeasons.length === 0}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] border ${
                        selectedSeasons.length === 0 ? 'border-border-subtle text-text-muted cursor-not-allowed' :
                        manualMode ? 'bg-accent-blue/15 border-accent-blue/30 text-accent-blue' : 'border-border-subtle text-text-muted hover:text-text-primary hover:border-border-medium'
                      }`}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>manage_search</span>
                      Manual
                    </button>
                    <button
                      onClick={handleDownload}
                      disabled={selectedSeasons.length === 0 || searching}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] ${
                        selectedSeasons.length === 0 || searching
                          ? 'bg-bg-surface-2 text-text-muted cursor-not-allowed'
                          : 'bg-accent-blue text-white hover:bg-accent-blue/90'
                      }`}
                    >
                      {searching ? (
                        <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span> Searching...</>
                      ) : (
                        <><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span> Auto</>
                      )}
                    </button>
                  </div>
                </div>
                {manualMode && selectedSeasons.length > 0 && (
                  <ManualSearchView
                    service="sonarr"
                    id={seriesId}
                    seasonNumber={selectedSeasons[0]}
                    title={null}
                    onGrabbed={() => setSearchResult({ success: true, message: 'Release grabbed — downloading shortly' })}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
// ── Artist Detail Modal ─────────────────────────────────────────────────────

function ArtistDetail({ artistId, onClose, onDelete }) {
  const { closing, close } = useAnimatedClose(onClose);
  const [albums, setAlbums] = useState(null);
  const [artistInfo, setArtistInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedAlbums, setSelectedAlbums] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [fileTree, setFileTree] = useState(null);
  const [showFiles, setShowFiles] = useState(false);
  const [expandedFolder, setExpandedFolder] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteAlbum, setConfirmDeleteAlbum] = useState(null);
  // Discover-more state
  const [discoverAlbums, setDiscoverAlbums] = useState(null);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [discoverFilter, setDiscoverFilter] = useState('all'); // all|Album|EP|Single
  const [discoverSelected, setDiscoverSelected] = useState([]);
  const [addingExtras, setAddingExtras] = useState(false);
  const [discoverTextFilter, setDiscoverTextFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/library/artists/${artistId}/albums`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/library/artists/${artistId}/files`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
    ]).then(([albumData, fileData]) => {
      setAlbums(albumData?.albums || []);
      setArtistInfo(albumData?.artist || null);
      setFileTree(fileData);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [artistId]);

  const loadDiscover = async () => {
    if (!artistInfo?.artistName) return;
    setShowDiscover(true);
    if (discoverAlbums) return;
    setDiscoverLoading(true);
    try {
      const url = `/api/lookup/music/albums?artistName=${encodeURIComponent(artistInfo.artistName)}&foreignArtistId=${encodeURIComponent(artistInfo.foreignArtistId || '')}`;
      const data = await fetch(url, { cache: 'no-store' }).then(r => r.ok ? r.json() : []);
      // Dedupe against albums already in Lidarr (normalized title match)
      const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\[.*?\]\s*/g, ' ')
        .replace(/ - (single|ep)$/i, '').replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ').trim();
      const existing = new Set((albums || []).map(a => norm(a.title)));
      const filtered = (Array.isArray(data) ? data : []).filter(a => !existing.has(norm(a.title)));
      setDiscoverAlbums(filtered);
    } catch (e) {
      setDiscoverAlbums([]);
    }
    setDiscoverLoading(false);
  };

  const submitExtras = async () => {
    if (discoverSelected.length === 0 || !discoverAlbums) return;
    setAddingExtras(true);
    setSearchResult(null);
    try {
      const titles = discoverAlbums
        .filter(a => discoverSelected.includes(a.id))
        .map(a => a.title.replace(/ - Single$/, ''));
      const resp = await fetch(`/api/library/artists/${artistId}/albums/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedAlbumTitles: titles }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setSearchResult({ success: true,
          message: `Adding ${titles.length} album(s) — ${data.monitored} matched in Lidarr, ${data.unmatched?.length || 0} via Soulseek` });
        setDiscoverSelected([]);
        // Refresh library albums after a delay
        setTimeout(() => {
          fetch(`/api/library/artists/${artistId}/albums`, { cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d?.albums) setAlbums(d.albums); });
          // Force re-fetch discover (some moved to library)
          setDiscoverAlbums(null);
        }, 4000);
      } else {
        setSearchResult({ success: false, message: data.error || 'Add failed' });
      }
    } catch (e) {
      setSearchResult({ success: false, message: e.message });
    }
    setAddingExtras(false);
  };

  const handleDownload = async () => {
    if (selectedAlbums.length === 0) return;
    setSearching(true);
    setSearchResult(null);
    try {
      const resp = await fetch('/api/command/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'lidarr', id: artistId, albumIds: selectedAlbums }),
      });
      const data = await resp.json();
      setSearchResult(resp.ok ? { success: true, message: `Search triggered for ${selectedAlbums.length} album(s)` } : { success: false, message: data.error });
    } catch (err) { setSearchResult({ success: false, message: err.message }); }
    setSearching(false);
  };

  const isAlbumComplete = a => a.trackFileCount > 0 && a.trackFileCount >= a.trackCount && a.trackCount > 0;
  const missingAlbums = albums?.filter(a => !isAlbumComplete(a)) || [];
  const downloadedAlbums = albums?.filter(a => isAlbumComplete(a)) || [];
  const allAlbumsComplete = !loading && albums?.length > 0 && missingAlbums.length === 0;

  const handleDeleteAlbumFiles = async (albumId) => {
    try {
      await fetch(`/api/delete/album/${albumId}/files`, { method: 'DELETE' });
      // Refresh album list
      const data = await fetch(`/api/library/artists/${artistId}/albums`, { cache: 'no-store' }).then(r => r.json());
      setAlbums(data?.albums || []);
      setSearchResult({ success: true, message: 'Album files removed from disk' });
    } catch (err) { setSearchResult({ success: false, message: err.message }); }
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[20px] ${closing ? 'modal-backdrop-exit' : 'modal-backdrop-enter'}`} onClick={close}>
      <div className={`bg-bg-card rounded-2xl border border-border-subtle shadow-xl max-w-2xl w-full mx-4 max-h-[85vh] flex flex-col ${closing ? 'modal-exit' : 'modal-enter'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <h3 className="text-[15px] font-semibold text-text-primary">Albums</h3>
          <div className="flex items-center gap-1">
            <button onClick={() => setConfirmDelete(!confirmDelete)}
              className="p-1 rounded-md hover:bg-accent-red/10 text-text-muted hover:text-accent-red transition-colors" title="Delete artist">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>delete</span>
            </button>
            <button onClick={close} className="p-1 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
            </button>
          </div>
        </div>
        {confirmDelete && (
          <div className="px-5 py-3 bg-accent-red/5 border-b border-accent-red/20">
            <p className="text-[12px] text-accent-red font-medium mb-2">Delete this artist?</p>
            <div className="flex items-center gap-2">
              <button onClick={async () => {
                setDeleting(true);
                try {
                  const resp = await fetch(`/api/delete/music/${artistId}?deleteFiles=true`, { method: 'DELETE' });
                  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.substring(0, 100) || 'Delete failed'); }
                  onDelete?.(); onClose();
                } catch (err) { setSearchResult({ success: false, message: `Delete failed: ${err.message}` }); }
                setDeleting(false); setConfirmDelete(false);
              }} disabled={deleting}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-accent-red text-white hover:bg-accent-red/90 disabled:opacity-50">
                {deleting ? 'Deleting...' : 'Delete + Remove Files'}
              </button>
              <button onClick={async () => {
                setDeleting(true);
                try {
                  const resp = await fetch(`/api/delete/music/${artistId}?deleteFiles=false`, { method: 'DELETE' });
                  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.substring(0, 100) || 'Delete failed'); }
                  onDelete?.(); onClose();
                } catch (err) { setSearchResult({ success: false, message: `Delete failed: ${err.message}` }); }
                setDeleting(false); setConfirmDelete(false);
              }} disabled={deleting}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-bg-surface border border-border-subtle text-text-primary hover:bg-bg-hover disabled:opacity-50">
                Remove from Lidarr Only
              </button>
              <button onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto scroll-area p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 24 }}>progress_activity</span>
            </div>
          ) : albums.length === 0 ? (
            <p className="text-center text-text-muted text-[13px] py-8">No albums found</p>
          ) : (
            <div className="space-y-2">
              {albums.map(a => {
                const isMissing = a.trackFileCount < a.trackCount;
                const isSelected = selectedAlbums.includes(a.id);
                return (
                  <div key={a.id} className={`flex items-center gap-3 p-3 rounded-lg border hover:bg-bg-hover/50 transition-colors ${isAlbumComplete(a) ? 'border-accent-green/20 bg-accent-green/5' : 'border-border-subtle'}`}>
                    {!isAlbumComplete(a) ? (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => setSelectedAlbums(prev => isSelected ? prev.filter(id => id !== a.id) : [...prev, a.id])}
                        className="w-3.5 h-3.5 rounded border-border-medium text-accent-blue focus:ring-accent-blue/30 cursor-pointer flex-none"
                      />
                    ) : (
                      <span className="material-symbols-rounded text-accent-green flex-none" style={{ fontSize: 16 }}>check_circle</span>
                    )}
                    <div className="w-12 h-12 rounded-md overflow-hidden relative flex-none bg-bg-surface-2">
                      {a.coverUrl ? (
                        <img src={a.coverUrl.startsWith('/api/') ? a.coverUrl : `/api/poster?url=${encodeURIComponent(a.coverUrl)}`} alt={a.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="material-symbols-rounded text-border-medium" style={{ fontSize: 24, fontVariationSettings: "'FILL' 1" }}>album</span>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-text-primary truncate">{a.title}</p>
                      <p className="text-[11px] text-text-muted">
                        {a.releaseDate ? new Date(a.releaseDate).getFullYear() : 'Unknown'}
                        {' · '}
                        <span className={a.trackFileCount === a.trackCount && a.trackCount > 0 ? 'text-accent-green' : 'text-accent-orange'}>
                          {a.trackFileCount}/{a.trackCount} tracks
                        </span>
                        {a.sizeOnDisk > 0 && ` · ${formatBytes(a.sizeOnDisk)}`}
                      </p>
                    </div>
                    {a.percentOfTracks > 0 && (
                      <div className="flex items-center gap-2 flex-none">
                        <div className="w-16 h-1.5 rounded-full bg-bg-surface-2 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${a.percentOfTracks}%`, background: a.percentOfTracks >= 100 ? '#16a34a' : '#d97706' }} />
                        </div>
                        <span className="text-[10px] font-mono text-text-muted">{Math.round(a.percentOfTracks)}%</span>
                      </div>
                    )}
                    {isAlbumComplete(a) && (
                      confirmDeleteAlbum === a.id ? (
                        <div className="flex items-center gap-1 flex-none">
                          <button onClick={() => { handleDeleteAlbumFiles(a.id); setConfirmDeleteAlbum(null); }}
                            className="px-2 py-0.5 rounded text-[10px] font-semibold bg-accent-red text-white hover:bg-accent-red/90">
                            Delete
                          </button>
                          <button onClick={() => setConfirmDeleteAlbum(null)}
                            className="px-2 py-0.5 rounded text-[10px] text-text-muted hover:text-text-primary">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteAlbum(a.id)}
                          className="p-1 rounded hover:bg-accent-red/10 text-text-muted hover:text-accent-red transition-colors flex-none"
                          title="Remove files from disk"
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
                        </button>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* Discover more section */}
        {!loading && artistInfo?.artistName && (
          <div className="border-t border-border-subtle">
            <button
              onClick={() => showDiscover ? setShowDiscover(false) : loadDiscover()}
              className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-bg-hover/50 transition-colors text-left"
            >
              <span className="material-symbols-rounded text-accent-blue" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>add_circle</span>
              <span className="text-[11px] font-semibold text-text-primary flex-1">Discover More (EPs, Singles & missing albums)</span>
              <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 14, transition: 'transform 0.2s', transform: showDiscover ? 'rotate(180deg)' : 'none' }}>expand_more</span>
            </button>
            {showDiscover && (
              <div className="px-5 pb-4">
                {discoverLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 22 }}>progress_activity</span>
                  </div>
                ) : !discoverAlbums || discoverAlbums.length === 0 ? (
                  <p className="text-[11px] text-text-muted py-3">No additional releases found from iTunes/MusicBrainz.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-[11px] text-text-muted font-medium">Select Albums ({discoverSelected.length} selected)</label>
                      <div className="flex gap-2">
                        <button onClick={() => setDiscoverSelected(discoverAlbums.filter(a => a.albumType !== 'Single').map(a => a.id))}
                          className="text-[10px] text-accent-blue hover:underline">Albums + EPs</button>
                        <button onClick={() => setDiscoverSelected(discoverAlbums.filter(a => a.albumType === 'EP').map(a => a.id))}
                          className="text-[10px] text-accent-blue hover:underline">EPs only</button>
                        <button onClick={() => setDiscoverSelected(discoverAlbums.filter(a => a.albumType === 'Single').map(a => a.id))}
                          className="text-[10px] text-accent-blue hover:underline">Singles only</button>
                        <button
                          onClick={() => setDiscoverSelected(discoverSelected.length === discoverAlbums.length ? [] : discoverAlbums.map(a => a.id))}
                          className="text-[10px] text-accent-blue hover:underline"
                        >
                          {discoverSelected.length === discoverAlbums.length ? 'Unselect All' : 'Select All'}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                      {['all', 'Album', 'EP', 'Single'].map(t => {
                        const count = t === 'all' ? discoverAlbums.length : discoverAlbums.filter(a => a.albumType === t).length;
                        return (
                          <button key={t} onClick={() => setDiscoverFilter(t)}
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${discoverFilter === t ? 'bg-accent-blue/15 border-accent-blue/40 text-accent-blue' : 'border-border-subtle text-text-muted hover:text-text-primary'}`}>
                            {t === 'all' ? 'All' : t} <span className="opacity-60">{count}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="relative mb-2">
                      <span className="material-symbols-rounded absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" style={{ fontSize: 14 }}>search</span>
                      <input
                        type="text"
                        value={discoverTextFilter}
                        onChange={e => setDiscoverTextFilter(e.target.value)}
                        placeholder="Filter releases..."
                        className="w-full pl-7 pr-2 py-1.5 text-[11px] bg-[#e8e8ed]/50 border-none rounded-xl text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-[#007AFF]/30"
                      />
                    </div>
                    <div className="space-y-0.5 max-h-72 overflow-y-auto scroll-area">
                      {discoverAlbums
                        .filter(a => discoverFilter === 'all' || a.albumType === discoverFilter)
                        .filter(a => !discoverTextFilter || a.title.toLowerCase().includes(discoverTextFilter.toLowerCase()))
                        .map(a => {
                          const isSel = discoverSelected.includes(a.id);
                          return (
                            <label key={a.id} className="flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-bg-hover cursor-pointer transition-colors">
                              <input
                                type="checkbox"
                                checked={isSel}
                                onChange={() => setDiscoverSelected(prev => prev.includes(a.id) ? prev.filter(id => id !== a.id) : [...prev, a.id])}
                                className="w-3.5 h-3.5 rounded border-border-medium text-accent-blue focus:ring-accent-blue/30 cursor-pointer flex-none"
                              />
                              {a.coverUrl && (
                                <img src={'/api/poster?url=' + encodeURIComponent(a.coverUrl)} alt="" className="w-11 h-11 rounded-lg object-cover flex-none" onError={e => { e.target.style.display = 'none'; }} />
                              )}
                              <div className="flex-1 min-w-0">
                                <span className="text-[12px] text-text-primary block truncate">{a.title.replace(/ - (Single|EP)$/i, '')}</span>
                                <span className="text-[10px] text-text-muted">
                                  {a.releaseDate ? new Date(a.releaseDate).getFullYear() : ''}
                                  {a.trackCount > 0 ? ' · ' + a.trackCount + ' tracks' : ''}
                                  {a.source === 'musicbrainz' ? ' · MB' : ''}
                                </span>
                              </div>
                              <span className={'text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-none ' + (a.albumType === 'Album' ? 'bg-[#007AFF]/10 text-[#007AFF]' : a.albumType === 'EP' ? 'bg-[#AF52DE]/10 text-[#AF52DE]' : 'bg-bg-surface-2 text-text-muted')}>
                                {a.albumType}
                              </span>
                            </label>
                          );
                      })}
                    </div>
                    <div className="flex items-center justify-end gap-2 mt-3">
                      <button onClick={() => setDiscoverSelected([])} disabled={discoverSelected.length === 0}
                        className="text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40 px-2 py-1">Clear</button>
                      <button onClick={submitExtras} disabled={discoverSelected.length === 0 || addingExtras}
                        className={`px-4 py-2 rounded-xl text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] flex items-center gap-2 ${
                          discoverSelected.length === 0 || addingExtras ? 'bg-bg-surface-2 text-text-muted cursor-not-allowed' : 'bg-text-primary text-white hover:bg-text-secondary'
                        }`}>
                        {addingExtras ? (
                          <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span> Adding…</>
                        ) : (
                          <><span className="material-symbols-rounded" style={{ fontSize: 14 }}>add</span> Add {discoverSelected.length} to Lidarr</>
                        )}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {/* File tree section */}
        {!loading && fileTree && (
          <div className="border-t border-border-subtle">
            <button
              onClick={() => setShowFiles(!showFiles)}
              className="w-full flex items-center gap-2 px-5 py-2.5 hover:bg-bg-hover/50 transition-colors text-left"
            >
              <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>folder_open</span>
              <span className="text-[11px] font-semibold text-text-primary flex-1">Files on Disk</span>
              {fileTree.path && <span className="text-[9px] font-mono text-text-muted truncate max-w-[200px]">{fileTree.path}</span>}
              <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 14, transition: 'transform 0.2s', transform: showFiles ? 'rotate(180deg)' : 'none' }}>expand_more</span>
            </button>
            {showFiles && (
              <div className="px-5 pb-3 max-h-64 overflow-y-auto scroll-area">
                {fileTree.folders?.length === 0 ? (
                  <p className="text-[11px] text-text-muted py-2">No files found on disk</p>
                ) : (
                  <div className="space-y-1">
                    {fileTree.folders.map(folder => (
                      <div key={folder.name} className="rounded-lg border border-border-subtle overflow-hidden">
                        <button
                          onClick={() => setExpandedFolder(expandedFolder === folder.name ? null : folder.name)}
                          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg-hover/30 transition-colors text-left"
                        >
                          <span className="material-symbols-rounded text-accent-blue flex-none" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>folder</span>
                          <span className="text-[11px] text-text-primary font-medium flex-1 truncate">{folder.name}</span>
                          <span className="text-[9px] font-mono text-text-muted">{folder.fileCount} files · {formatBytes(folder.totalSize)}</span>
                          <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 12, transition: 'transform 0.2s', transform: expandedFolder === folder.name ? 'rotate(180deg)' : 'none' }}>expand_more</span>
                        </button>
                        {expandedFolder === folder.name && (
                          <div className="border-t border-border-subtle bg-bg-surface/50">
                            {folder.files.map((f, fi) => (
                              <div key={fi} className="flex items-center gap-2 px-3 py-1 border-b border-border-subtle last:border-b-0">
                                <span className="material-symbols-rounded text-text-muted flex-none" style={{ fontSize: 11, fontVariationSettings: "'FILL' 1" }}>
                                  {f.name.endsWith('.flac') ? 'audio_file' : f.name.endsWith('.mp3') ? 'audio_file' : 'description'}
                                </span>
                                <span className="text-[10px] text-text-secondary truncate flex-1">{f.name}</span>
                                <span className="text-[9px] font-mono text-text-muted flex-none">{formatBytes(f.size)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Footer: completion or download controls */}
        {!loading && albums?.length > 0 && (
          <div className="px-5 py-3 border-t border-border-subtle bg-bg-surface">
            {allAlbumsComplete ? (
              <div className="flex items-center gap-2 py-1">
                <span className="material-symbols-rounded text-accent-green" style={{ fontSize: 20 }}>check_circle</span>
                <div>
                  <p className="text-[12px] font-semibold text-accent-green">All albums downloaded</p>
                  <p className="text-[10px] text-text-muted">{downloadedAlbums.length} album{downloadedAlbums.length !== 1 ? 's' : ''} · click trash icon to remove files</p>
                </div>
              </div>
            ) : (
              <>
                {searchResult && (
                  <div className={`mb-2 px-3 py-2 rounded-lg text-[11px] font-medium ${searchResult.success ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'}`}>
                    {searchResult.message}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[11px] text-text-muted">{selectedAlbums.length} album(s) selected · {missingAlbums.length} missing</span>
                    {selectedAlbums.length === 0 && <button onClick={() => setSelectedAlbums(missingAlbums.map(a => a.id))} className="text-[10px] text-accent-blue hover:underline ml-2">Select all missing</button>}
                  </div>
                  <button
                    onClick={handleDownload}
                    disabled={selectedAlbums.length === 0 || searching}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] ${
                      selectedAlbums.length === 0 || searching
                        ? 'bg-bg-surface-2 text-text-muted cursor-not-allowed'
                        : 'bg-accent-blue text-white hover:bg-accent-blue/90'
                    }`}
                  >
                    {searching ? (
                      <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span> Searching...</>
                    ) : (
                      <><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span> Attempt Download</>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add Media Panel ─────────────────────────────────────────────────────────

function AddPanel({ item, mediaType, onClose, onAdded }) {
  const { closing, close } = useAnimatedClose(onClose);
  const [profiles, setProfiles] = useState(null);
  const [profileError, setProfileError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState(null);
  const [config, setConfig] = useState({});
  const [selectedSeasons, setSelectedSeasons] = useState([]);
  const [lookupAlbums, setLookupAlbums] = useState(null);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [selectedAlbumIds, setSelectedAlbumIds] = useState([]);
  const [albumFilter, setAlbumFilter] = useState("");
  // Manual add is a two-step flow: create the arr record first, then browse releases against that new id.
  const [manualStep, setManualStep] = useState(null); // null | 'adding' | 'browse'
  const [addedId, setAddedId] = useState(null);
  const handlePanelClose = useCallback(() => {
    if (manualStep === 'browse' && addedId && onAdded) onAdded({ mediaType, id: addedId, title: item?.title || item?.artistName });
    close();
  }, [manualStep, addedId, onAdded, item, close, mediaType]);

  useEffect(() => {
    apiFetch(`/api/profiles/${mediaType}`)
      .then(data => {
        setProfiles(data);
        setProfileError(null);
        if (data) {
          const defaults = {};
          if (data.qualityProfiles?.length) {
            defaults.qualityProfileId = selectDefaultQualityProfileId(data.qualityProfiles, mediaType);
          }
          if (data.rootFolders?.length) defaults.rootFolderPath = data.rootFolders[0].path;
          if (data.metadataProfiles?.length) defaults.metadataProfileId = data.metadataProfiles[0].id;
          if (data.minimumAvailabilities?.length) defaults.minimumAvailability = data.minimumAvailabilities[2]?.value || data.minimumAvailabilities[0].value;
          if (data.seriesTypes?.length) defaults.seriesType = data.seriesTypes[0].value;
          if (data.monitorOptions?.length) defaults.monitorOption = data.monitorOptions[0].value;
          setConfig(defaults);
        }
        setLoading(false);
      })
      .catch((err) => { setProfileError(err.message); setLoading(false); });
    // Pre-select all seasons
    if (item.seasons) setSelectedSeasons(item.seasons.filter(s => s.seasonNumber > 0).map(s => s.seasonNumber));
  }, [mediaType, item]);

  const handleManualAdd = async () => {
    setManualStep('adding');
    setResult(null);
    try {
      let body = { ...config, monitored: true };
      if (mediaType === 'movie') {
        body.tmdbId = item.tmdbId;
        body.searchForMovie = false;
      } else {
        body.tvdbId = item.tvdbId;
        body.searchForMissingEpisodes = false;
        if (selectedSeasons.length > 0 && item.seasons?.length) body.selectedSeasons = selectedSeasons;
      }
      const data = await apiPost(`/api/add/${mediaType}`, body);
      if (data.success) {
        setAddedId(data.id);
        setManualStep('browse');
      } else {
        setResult({ success: false, message: data.error || 'Failed to add' });
        setManualStep(null);
      }
    } catch (err) {
      setResult({ success: false, message: err.message });
      setManualStep(null);
    }
  };

  // Fetch albums for music artists
  useEffect(() => {
    if (mediaType !== 'music' || !item.foreignArtistId) return;
    setAlbumsLoading(true);
    apiFetch(`/api/lookup/music/albums?artistName=${encodeURIComponent(item.artistName)}&foreignArtistId=${encodeURIComponent(item.foreignArtistId || "")}`)
      .then(albums => {
        setLookupAlbums(albums);
        setSelectedAlbumIds(albums.filter(a => a.albumType !== 'Single').map(a => a.id));
        setAlbumsLoading(false);
      })
      .catch(() => { setLookupAlbums([]); setAlbumsLoading(false); });
  }, [mediaType, item.foreignArtistId, item.artistName]);

  const handleAdd = async () => {
    setAdding(true);
    setResult(null);
    try {
      let body = { ...config, monitored: true };
      if (mediaType === 'movie') {
        body.tmdbId = item.tmdbId;
        body.searchForMovie = true;
      } else if (mediaType === 'series') {
        body.tvdbId = item.tvdbId;
        body.searchForMissingEpisodes = true;
        if (selectedSeasons.length > 0 && item.seasons?.length) {
          body.selectedSeasons = selectedSeasons;
        }
      } else {
        body.foreignArtistId = item.foreignArtistId;
        body.artistName = item.artistName;
        body.searchForMissingAlbums = true;
        if (lookupAlbums?.length > 0) {
          body.selectedAlbumTitles = lookupAlbums
            .filter(a => selectedAlbumIds.includes(a.id))
            .map(a => a.title.replace(/ - Single$/, ''));
        }
      }
      const data = await apiPost(`/api/add/${mediaType}`, body);
      if (data.success) {
        setResult({ success: true, message: data.albumsMonitored ? `Added "${data.artistName}" — ${data.albumsMonitored}/${data.totalAlbums} albums monitored, searching Soulseek...` : `Added "${data.title || data.artistName}" — searching for downloads...` });
        setAdding(false);
        if (onAdded) onAdded({ mediaType, id: data.id, title: data.artistName || data.title || title });
        return;
      } else {
        setResult({ success: false, message: data.error || 'Failed to add' });
      }
    } catch (err) { setResult({ success: false, message: err.message }); }
    setAdding(false);
  };

  const rating = extractRating(item.ratings);
  const title = mediaType === 'music' ? item.artistName : item.title;
  const fallbackIcon = mediaType === 'movie' ? 'movie' : mediaType === 'series' ? 'tv' : 'album';
  const albumsAndEPs = lookupAlbums?.filter(a => a.albumType !== 'Single') || [];
  const albumsAndEPIds = albumsAndEPs.map(a => a.id);
  const allAlbumsAndEPsSelected = albumsAndEPIds.length > 0 && albumsAndEPIds.every(id => selectedAlbumIds.includes(id));
  const toggleAlbumsAndEPsSelection = () => {
    setSelectedAlbumIds(current => (
      allAlbumsAndEPsSelected ? current.filter(id => !albumsAndEPIds.includes(id)) : Array.from(new Set([...current, ...albumsAndEPIds]))
    ));
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[20px] ${closing ? 'modal-backdrop-exit' : 'modal-backdrop-enter'}`} onClick={handlePanelClose}>
      <div className={`bg-bg-card rounded-2xl border border-border-subtle shadow-xl max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto scroll-area ${closing ? 'modal-exit' : 'modal-enter'}`} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex gap-4 p-5 border-b border-border-subtle">
          <div className="w-24 h-36 rounded-lg overflow-hidden relative flex-none">
            <PosterImg url={item.posterUrl} fallbackIcon={fallbackIcon} title={title} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-text-primary">{title}</h3>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted flex-wrap">
              {item.year && <span>{item.year}</span>}
              {item.network && <span>· {item.network}</span>}
              {item.studio && <span>· {item.studio}</span>}
              {item.disambiguation && <span>· {item.disambiguation}</span>}
              {rating && (
                <span className="flex items-center gap-0.5 text-accent-orange">
                  <span className="material-symbols-rounded" style={{ fontSize: 11, fontVariationSettings: "'FILL' 1" }}>star</span>{rating}
                </span>
              )}
            </div>
            {item.overview && <p className="text-[11px] text-text-muted mt-2 line-clamp-3 leading-relaxed">{item.overview}</p>}
            {item.genres?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {item.genres.slice(0, 4).map(g => <span key={g} className="genre-pill">{g}</span>)}
              </div>
            )}
          </div>
          <button onClick={handlePanelClose} className="p-1 h-fit rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors flex-none">
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        {/* Config */}
        <div className="p-5">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 24 }}>progress_activity</span>
            </div>
          ) : !profiles ? (
            <p className="text-center text-accent-red text-[12px] py-4">{profileError || 'Failed to load profiles'}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                {profiles.qualityProfiles?.length > 0 && (
                  <Select label="Quality Profile" value={config.qualityProfileId || ''} onChange={v => setConfig(c => ({ ...c, qualityProfileId: parseInt(v) }))} options={profiles.qualityProfiles.map(p => ({ value: p.id, label: p.name }))} />
                )}
                {profiles.rootFolders?.length > 0 && (
                  <Select label="Root Folder" value={config.rootFolderPath || ''} onChange={v => setConfig(c => ({ ...c, rootFolderPath: v }))} options={profiles.rootFolders.map(f => ({ value: f.path, label: `${f.path}${f.freeSpace ? ` (${formatBytes(f.freeSpace)} free)` : ''}` }))} />
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                {profiles.minimumAvailabilities && (
                  <Select label="Minimum Availability" value={config.minimumAvailability || ''} onChange={v => setConfig(c => ({ ...c, minimumAvailability: v }))} options={profiles.minimumAvailabilities} />
                )}
                {profiles.seriesTypes && (
                  <Select label="Series Type" value={config.seriesType || ''} onChange={v => setConfig(c => ({ ...c, seriesType: v }))} options={profiles.seriesTypes} />
                )}
                {profiles.monitorOptions && !item.seasons && (
                  <Select label="Monitor" value={config.monitorOption || ''} onChange={v => setConfig(c => ({ ...c, monitorOption: v }))} options={profiles.monitorOptions} />
                )}
                {profiles.metadataProfiles && (
                  <Select label="Metadata Profile" value={config.metadataProfileId || ''} onChange={v => setConfig(c => ({ ...c, metadataProfileId: parseInt(v) }))} options={profiles.metadataProfiles.map(p => ({ value: p.id, label: p.name }))} />
                )}
              </div>
              {/* Season selection for TV */}
              {item.seasons && (
                <SeasonSelector seasons={item.seasons} selected={selectedSeasons} onChange={setSelectedSeasons} />
              )}
              {/* Album selection for Music */}
              {mediaType === 'music' && albumsLoading && (
                <div className="mt-3 flex items-center justify-center py-4">
                  <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 18 }}>progress_activity</span>
                  <span className="text-[11px] text-text-muted ml-2">Loading discography...</span>
                </div>
              )}
              {mediaType === 'music' && !albumsLoading && lookupAlbums && lookupAlbums.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[11px] text-text-muted font-medium">Select Albums ({selectedAlbumIds.length} selected)</label>
                    <div className="flex gap-2">
                      <button onClick={() => setSelectedAlbumIds(albumsAndEPIds)} className="text-[10px] text-accent-blue hover:underline">Albums + EPs</button>
                      <button
                        onClick={toggleAlbumsAndEPsSelection}
                        className="text-[10px] text-accent-blue hover:underline"
                      >
                        {allAlbumsAndEPsSelected ? 'Unselect All' : 'Select All'}
                      </button>
                    </div>
                  </div>
                  <div className="relative mb-2">
                    <span className="material-symbols-rounded absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" style={{ fontSize: 14 }}>search</span>
                    <input
                      type="text"
                      value={albumFilter}
                      onChange={e => setAlbumFilter(e.target.value)}
                      placeholder="Filter albums..."
                      className="w-full pl-7 pr-2 py-1.5 text-[11px] bg-[#e8e8ed]/50 border-none rounded-xl text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-[#007AFF]/30"
                    />
                  </div>
                  <div className="space-y-0.5 max-h-56 overflow-y-auto scroll-area">
                    {lookupAlbums.filter(a => !albumFilter || a.title.toLowerCase().includes(albumFilter.toLowerCase())).map(a => (
                      <label key={a.id} className="flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-bg-hover cursor-pointer transition-colors">
                        <input
                          type="checkbox"
                          checked={selectedAlbumIds.includes(a.id)}
                          onChange={() => setSelectedAlbumIds(prev => prev.includes(a.id) ? prev.filter(id => id !== a.id) : [...prev, a.id])}
                          className="w-3.5 h-3.5 rounded border-border-medium text-accent-blue focus:ring-accent-blue/30 cursor-pointer flex-none"
                        />
                        {a.coverUrl && (
                          <img src={'/api/poster?url=' + encodeURIComponent(a.coverUrl)} alt="" className="w-11 h-11 rounded-lg object-cover flex-none" onError={e => { e.target.style.display = 'none'; }} />
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="text-[12px] text-text-primary block truncate">{a.title.replace(/ - (Single|EP)$/i, '')}</span>
                          <span className="text-[10px] text-text-muted">
                            {a.releaseDate ? new Date(a.releaseDate).getFullYear() : ''}
                            {a.trackCount > 0 ? ' · ' + a.trackCount + ' tracks' : ''}
                            {a.source === 'musicbrainz' ? ' · MB' : ''}
                          </span>
                        </div>
                        <span className={'text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-none ' + (a.albumType === 'Album' ? 'bg-[#007AFF]/10 text-[#007AFF]' : a.albumType === 'EP' ? 'bg-[#AF52DE]/10 text-[#AF52DE]' : 'bg-bg-surface-2 text-text-muted')}>
                          {a.albumType}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {result && (
            <div className={`mt-4 px-4 py-2.5 rounded-lg text-[12px] font-medium ${result.success ? 'bg-accent-green/10 text-accent-green border border-accent-green/20' : 'bg-accent-red/10 text-accent-red border border-accent-red/20'}`}>
              <div className="flex items-center gap-2">
                <span className="material-symbols-rounded" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>{result.success ? 'check_circle' : 'error'}</span>
                {result.message}
              </div>
            </div>
          )}

          {!result?.success && manualStep !== 'browse' && (
            <div className="mt-4 flex gap-2">
              <button
                onClick={handleAdd}
                disabled={adding || loading || !profiles || manualStep === 'adding'}
                className={`flex-1 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-150 active:scale-[0.97] flex items-center justify-center gap-2 ${
                  adding || loading || !profiles ? 'bg-bg-surface-2 text-text-muted cursor-not-allowed' : 'bg-text-primary text-white hover:bg-text-secondary'
                }`}
              >
                {adding ? (
                  <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 16 }}>progress_activity</span> Adding...</>
                ) : (
                  <><span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span> Add & Search</>
                )}
              </button>
              {mediaType !== 'music' && (
                <button
                  onClick={handleManualAdd}
                  disabled={adding || loading || !profiles || manualStep === 'adding'}
                  className={`px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-150 active:scale-[0.97] flex items-center justify-center gap-2 border ${
                    loading || !profiles || manualStep === 'adding' ? 'border-border-subtle text-text-muted cursor-not-allowed' : 'border-border-medium text-text-primary hover:bg-bg-hover hover:border-border-strong'
                  }`}
                >
                  {manualStep === 'adding' ? (
                    <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 15 }}>progress_activity</span> Adding...</>
                  ) : (
                    <><span className="material-symbols-rounded" style={{ fontSize: 15 }}>manage_search</span> Manual</>
                  )}
                </button>
              )}
            </div>
          )}
          {manualStep === 'browse' && addedId && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] font-semibold text-text-primary">Manual Search</span>
                <button onClick={handlePanelClose} className="text-[10px] text-text-muted hover:text-text-primary">Keep Added</button>
              </div>
              <p className="text-[11px] text-text-muted mb-2">This title is already added to your library. Closing this panel keeps it monitored so you can come back later.</p>
              <ManualSearchView
                service={mediaType === 'movie' ? 'radarr' : 'sonarr'}
                id={addedId}
                seasonNumber={mediaType === 'series' ? selectedSeasons?.[0] : undefined}
                title={title}
                onGrabbed={() => {
                  setResult({ success: true, message: `Added "${title}" — release grabbed, downloading shortly` });
                  if (onAdded) onAdded({ mediaType, id: addedId, title });
                  setManualStep(null);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Library Card Components ─────────────────────────────────────────────────

function _SeriesCard({ series, onClick, queued }) {
  const total = series.totalEpisodeCount || 0;
  const have = series.episodeFileCount || 0;
  const isComplete = total > 0 && have >= total;
  const pct = total > 0 ? Math.min(100, Math.round((have / total) * 100)) : 0;
  const badgeLabel = total === 0 ? null : isComplete ? 'Complete' : `${have}/${total} eps`;
  const barColor = isComplete ? '#30D158' : '#FF9F0A';

  return (
    <div onClick={onClick} className="poster-card" style={{ borderRadius: 12 }}>
      <div style={{ aspectRatio: '2/3', position: 'relative', overflow: 'hidden', borderRadius: 12 }}>
        <PosterImg url={series.posterUrl} fallbackIcon="tv" title={series.title} />
        <div className="poster-film-grain" />
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '65%', background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)', pointerEvents: 'none', zIndex: 1 }} />
        {/* QUEUED badge */}
        {queued && (
          <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(10,132,255,0.25)', border: '1px solid rgba(10,132,255,0.5)', color: '#0A84FF', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 5, zIndex: 6, backdropFilter: 'blur(8px)', letterSpacing: '0.04em' }}>
            QUEUED
          </div>
        )}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 4 }}>
          {/* Completion bar */}
          {total > 0 && (
            <div style={{ height: 3, background: 'rgba(255,255,255,0.12)', margin: '0 0 6px 0' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: barColor, transition: 'width 0.3s ease' }} />
            </div>
          )}
          <div style={{ padding: '0 10px 10px 10px' }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.01em', lineHeight: 1.2, textShadow: '0 2px 12px rgba(0,0,0,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>
              {series.title.toUpperCase()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
              {series.seasonCount > 0 && (
                <span style={{ fontSize: 9.5, fontWeight: 600, color: 'rgba(235,235,245,0.55)', letterSpacing: '0.03em' }}>
                  {series.seasonCount} Season{series.seasonCount !== 1 ? 's' : ''}
                </span>
              )}
              {badgeLabel && (
                <span style={{ fontSize: 9, fontWeight: 700, color: isComplete ? '#30D158' : '#FF9F0A', letterSpacing: '0.03em', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {badgeLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
const SeriesCard = memo(_SeriesCard, (a, b) => a.series === b.series && a.queued === b.queued);


function _MovieCard({ movie, onClick, queued }) {
  return (
    <div onClick={onClick} className="poster-card" style={{ borderRadius: 12 }}>
      <div style={{ aspectRatio: '2/3', position: 'relative', overflow: 'hidden', borderRadius: 12 }}>
        <PosterImg url={movie.posterUrl} fallbackIcon="movie" title={movie.title} />
        <div className="poster-film-grain" />
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '65%', background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)', pointerEvents: 'none', zIndex: 1 }} />
        {/* QUEUED badge (top-left) */}
        {queued && (
          <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(10,132,255,0.25)', border: '1px solid rgba(10,132,255,0.5)', color: '#0A84FF', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 5, zIndex: 6, backdropFilter: 'blur(8px)', letterSpacing: '0.04em' }}>
            QUEUED
          </div>
        )}
        {/* Downloaded / Downloading / Missing badge (top-right) */}
        <div style={{ position: 'absolute', top: 8, right: 8, background: movie.hasFile ? 'rgba(48,209,88,0.18)' : queued ? 'rgba(10,132,255,0.18)' : 'rgba(255,159,10,0.2)', border: `1px solid ${movie.hasFile ? 'rgba(48,209,88,0.4)' : queued ? 'rgba(10,132,255,0.4)' : 'rgba(255,159,10,0.4)'}`, color: movie.hasFile ? '#30D158' : queued ? '#0A84FF' : '#FF9F0A', fontSize: 9.5, fontWeight: 700, padding: '3px 7px', borderRadius: 6, zIndex: 6, backdropFilter: 'blur(8px)' }}>
          {movie.hasFile ? 'DOWNLOADED' : queued ? 'DOWNLOADING' : 'MISSING'}
        </div>
        <div style={{ position: 'absolute', bottom: 10, left: 10, right: 10, zIndex: 3 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.01em', lineHeight: 1.2, textShadow: '0 2px 12px rgba(0,0,0,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>
            {movie.title.toUpperCase()}
          </div>
          <span style={{ fontSize: 9.5, fontWeight: 600, color: 'rgba(235,235,245,0.55)', letterSpacing: '0.03em' }}>
            {[movie.quality, movie.year && String(movie.year)].filter(Boolean).join(' · ') || (movie.year && String(movie.year)) || ''}
          </span>
        </div>
      </div>
    </div>
  );
}
const MovieCard = memo(_MovieCard, (a, b) => a.movie === b.movie && a.queued === b.queued);



function _ArtistCard({ artist, onClick }) {
  return (
    <div onClick={onClick} className="poster-card" style={{ borderRadius: 12 }}>
      <div style={{ aspectRatio: '1/1', position: 'relative', overflow: 'hidden', borderRadius: 12 }}>
        <PosterImg url={artist.posterUrl} fallbackIcon="album" title={artist.artistName} />
        <div className="poster-film-grain" />
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)', pointerEvents: 'none', zIndex: 1 }} />
        <div style={{ position: 'absolute', bottom: 10, left: 10, right: 10, zIndex: 3 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.01em', lineHeight: 1.2, textShadow: '0 2px 12px rgba(0,0,0,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 4 }}>
            {artist.artistName.toUpperCase()}
          </div>
          {artist.albumCount > 0 && (
            <span style={{ fontSize: 9.5, fontWeight: 600, color: artist.downloadedAlbumCount > 0 && artist.downloadedAlbumCount < artist.albumCount ? 'rgba(255,159,10,0.9)' : 'rgba(235,235,245,0.55)', letterSpacing: '0.03em' }}>
              {artist.downloadedAlbumCount > 0 ? `${artist.downloadedAlbumCount}/${artist.albumCount}` : artist.albumCount} album{artist.albumCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
const ArtistCard = memo(_ArtistCard, (a, b) => a.artist === b.artist);



// ── Lookup Result Card ──────────────────────────────────────────────────────

const ResultCard = memo(function ResultCard({ item, mediaType, onClick }) {
  const rating = extractRating(item.ratings);
  const isAlbum = mediaType === 'music-album';
  const isMusic = mediaType === 'music' || isAlbum;
  const title = isAlbum ? item.title : (mediaType === 'music' ? item.artistName : item.title);
  const subtitle = isAlbum ? item.artistName : null;
  const fallbackIcon = mediaType === 'movie' ? 'movie' : mediaType === 'series' ? 'tv' : 'album';
  const imgHeight = isMusic ? 160 : 280;
  return (
    <div onClick={item.inLibrary && !isAlbum ? undefined : onClick} className={`library-card rounded-2xl overflow-hidden bg-bg-card border border-border-subtle ${item.inLibrary && !isAlbum ? 'opacity-60' : 'cursor-pointer'}`}>
      <div className="relative" style={{ height: imgHeight }}>
        <PosterImg url={item.posterUrl} fallbackIcon={fallbackIcon} title={title} />
        <div className="poster-overlay absolute inset-x-0 bottom-0" style={{ height: '50%' }} />
        {item.inLibrary && !isAlbum && (
          <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-accent-green/90">
            <span className="text-[9px] font-bold text-white tracking-wider flex items-center gap-1">
              <span className="material-symbols-rounded" style={{ fontSize: 11, fontVariationSettings: "'FILL' 1" }}>check</span>IN LIBRARY
            </span>
          </div>
        )}
        {isAlbum && item.albumType && (
          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wider"
            style={{ background: item.albumType === 'Album' ? 'rgba(10,132,255,0.85)' : item.albumType === 'EP' ? 'rgba(175,82,222,0.85)' : 'rgba(255,159,10,0.85)', color: '#fff' }}>
            {item.albumType.toUpperCase()}
          </div>
        )}
      </div>
      <div className="px-2.5 pt-2 pb-2.5">
        <h3 className="text-[12px] font-semibold text-text-primary line-clamp-2 leading-snug">{title}</h3>
        {subtitle && <p className="text-[10px] text-text-muted truncate">{subtitle}</p>}
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-text-muted">
          {item.releaseDate && <span>{new Date(item.releaseDate).getFullYear()}</span>}
          {item.year && !item.releaseDate && <span>{item.year}</span>}
          {item.network && <span>· {item.network}</span>}
          {item.studio && <span>· {item.studio}</span>}
          {item.seasonCount && <span>· {item.seasonCount}S</span>}
          {item.disambiguation && <span>· {item.disambiguation}</span>}
          {rating && (
            <span className="flex items-center gap-0.5 text-accent-orange ml-auto">
              <span className="material-symbols-rounded" style={{ fontSize: 10, fontVariationSettings: "'FILL' 1" }}>star</span>{rating}
            </span>
          )}
        </div>
        {!isAlbum && item.overview && <p className="text-[10px] text-text-muted mt-1 line-clamp-2 leading-relaxed">{item.overview}</p>}
      </div>
    </div>
  );
});

// ── Movie Download Trigger ──────────────────────────────────────────────────

function MovieDownloadPanel({ movie, onClose, onDelete }) {
  const { closing, close } = useAnimatedClose(onClose);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [fileInfo, setFileInfo] = useState(null);

  useEffect(() => {
    if (!movie.hasFile) return;
    fetch(`/api/library/movie/${movie.id}/file`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => setFileInfo(data))
      .catch(() => {});
  }, [movie.id, movie.hasFile]);

  const handleSearch = async () => {
    setSearching(true);
    setResult(null);
    try {
      const resp = await fetch('/api/command/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'radarr', id: movie.id }),
      });
      const data = await resp.json();
      setResult(resp.ok ? { success: true, message: 'Radarr is now searching for this movie' } : { success: false, message: data.error });
    } catch (err) { setResult({ success: false, message: err.message }); }
    setSearching(false);
  };

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[20px] ${closing ? 'modal-backdrop-exit' : 'modal-backdrop-enter'}`} onClick={close}>
      <div className={`bg-bg-card rounded-2xl border border-border-subtle shadow-xl max-w-md w-full mx-4 ${closing ? 'modal-exit' : 'modal-enter'}`} onClick={e => e.stopPropagation()}>
        <div className="flex gap-4 p-5">
          <div className="w-20 h-28 rounded-lg overflow-hidden relative flex-none">
            <PosterImg url={movie.posterUrl} fallbackIcon="movie" title={movie.title} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-text-primary">{movie.title} {movie.year && `(${movie.year})`}</h3>
            <p className="text-[11px] text-text-muted mt-1">{movie.hasFile ? `Downloaded · ${movie.quality || 'Unknown quality'}` : 'Missing from disk'}</p>
            {movie.sizeOnDisk > 0 && <p className="text-[11px] text-text-muted">{formatBytes(movie.sizeOnDisk)}</p>}
            {fileInfo && (
              <div className="mt-2 space-y-1">
                {fileInfo.resolution && (
                  <div className="flex flex-wrap gap-1.5">
                    {fileInfo.resolution && <span className="text-[10px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-secondary">{fileInfo.resolution}</span>}
                    {fileInfo.videoCodec && <span className="text-[10px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-secondary">{fileInfo.videoCodec}</span>}
                    {fileInfo.dynamicRange && <span className="text-[10px] font-mono bg-accent-blue/10 border border-accent-blue/20 rounded px-1.5 py-0.5 text-accent-blue">{fileInfo.dynamicRange}</span>}
                    {fileInfo.audioCodec && <span className="text-[10px] font-mono bg-bg-surface border border-border-subtle rounded px-1.5 py-0.5 text-text-secondary">{fileInfo.audioCodec}{fileInfo.audioChannels ? ` ${fileInfo.audioChannels}ch` : ''}</span>}
                    {fileInfo.runTime && <span className="text-[10px] text-text-muted">{fileInfo.runTime}</span>}
                  </div>
                )}
                {fileInfo.path && (
                  <p className="text-[10px] font-mono text-text-muted break-all leading-relaxed" title={fileInfo.path}>
                    <span className="text-text-muted/50">📁 </span>{fileInfo.path}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1 flex-none">
            <button onClick={() => setConfirmDelete(!confirmDelete)}
              className="p-1 rounded-md hover:bg-accent-red/10 text-text-muted hover:text-accent-red transition-colors" title="Delete movie">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>delete</span>
            </button>
            <button onClick={close} className="p-1 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors">
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
            </button>
          </div>
        </div>
        {confirmDelete && (
          <div className="px-5 py-3 bg-accent-red/5 border-b border-border-subtle">
            <p className="text-[12px] text-accent-red font-medium mb-2">Delete this movie?</p>
            <div className="flex items-center gap-2">
              <button onClick={async () => {
                setDeleting(true);
                try {
                  const resp = await fetch(`/api/delete/movie/${movie.id}?deleteFiles=true`, { method: 'DELETE' });
                  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.substring(0, 100) || 'Delete failed'); }
                  onDelete?.(); onClose();
                } catch (err) { setResult({ success: false, message: `Delete failed: ${err.message}` }); }
                setDeleting(false); setConfirmDelete(false);
              }} disabled={deleting}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-accent-red text-white hover:bg-accent-red/90 disabled:opacity-50">
                {deleting ? 'Deleting...' : 'Delete + Remove Files'}
              </button>
              <button onClick={async () => {
                setDeleting(true);
                try {
                  const resp = await fetch(`/api/delete/movie/${movie.id}?deleteFiles=false`, { method: 'DELETE' });
                  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.substring(0, 100) || 'Delete failed'); }
                  onDelete?.(); onClose();
                } catch (err) { setResult({ success: false, message: `Delete failed: ${err.message}` }); }
                setDeleting(false); setConfirmDelete(false);
              }} disabled={deleting}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-bg-surface border border-border-subtle text-text-primary hover:bg-bg-hover disabled:opacity-50">
                Remove from Radarr Only
              </button>
              <button onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
            </div>
          </div>
        )}
        <div className="px-5 pb-5">
          {result && (
            <div className={`mb-3 px-3 py-2 rounded-lg text-[11px] font-medium ${result.success ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'}`}>
              {result.message}
            </div>
          )}
          <div className="flex gap-2 mt-1">
            <button
              onClick={handleSearch}
              disabled={searching}
              className={`flex-1 py-2.5 rounded-xl text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] flex items-center justify-center gap-2 ${
                searching ? 'bg-bg-surface-2 text-text-muted cursor-not-allowed' : movie.hasFile ? 'bg-bg-surface border border-border-medium text-text-primary hover:bg-bg-hover' : 'bg-accent-blue text-white hover:bg-accent-blue/90'
              }`}
            >
              {searching ? (
                <><span className="material-symbols-rounded animate-spin" style={{ fontSize: 14 }}>progress_activity</span> Searching...</>
              ) : movie.hasFile ? (
                <><span className="material-symbols-rounded" style={{ fontSize: 14 }}>upgrade</span> Search for Upgrade</>
              ) : (
                <><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span> Auto</>
              )}
            </button>
            <button
              onClick={() => setManualMode(v => !v)}
              className={`px-4 py-2.5 rounded-xl text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] flex items-center justify-center gap-1.5 border ${manualMode ? 'bg-accent-blue/15 border-accent-blue/30 text-accent-blue' : 'border-border-medium text-text-primary hover:bg-bg-hover'}`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>manage_search</span>
              Manual
            </button>
          </div>
          {manualMode && (
            <ManualSearchView
              service="radarr"
              id={movie.id}
              title={movie.title}
              onGrabbed={() => setResult({ success: true, message: 'Release grabbed — downloading shortly' })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Library Component ──────────────────────────────────────────────────

export default function Library({
  externalQuery,
  onExternalQueryChange,
  serviceStatus = {},
  onOpenSettings,
  onAdded,
}) {
  const [mode, setMode] = useState('library'); // 'library' or 'add'
  const [query, setQuery] = useState(externalQuery || '');
  const [activeType, setActiveType] = useState('all');
  const [results, setResults] = useState({ series: [], movies: [], artists: [] });
  const [lookupResults, setLookupResults] = useState([]);
  const [musicSections, setMusicSections] = useState(null); // { artists, albums, singles, topCategory }
  const [loading, setLoading] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [libraryError, setLibraryError] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [libraryServiceStates, setLibraryServiceStates] = useState(null);
  const [detailView, setDetailView] = useState(null);
  const [addPanel, setAddPanel] = useState(null);
  const [addType, setAddType] = useState('movie');
  const [queuedSeriesIds, setQueuedSeriesIds] = useState(new Set());
  const [queuedMovieIds, setQueuedMovieIds] = useState(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const autoOpenedAddOnEmptyLibrary = useRef(false);
  const addPanelHandledRef = useRef(false);
  const debounceRef = useRef(null);
  const inputRef = useRef(null);
  const libraryRequestRef = useRef(0);
  const lookupRequestRef = useRef(0);
  const libraryFailureRef = useRef({ count: 0, lastGoodAt: null });
  const latestSearchRef = useRef({ query: externalQuery || '', activeType: 'all' });

  // Sync external header query → local query (when header search bar is typed into)
  useEffect(() => {
    if (externalQuery !== undefined && externalQuery !== query) {
      setQuery(externalQuery);
      setMode('library');
    }
  }, [externalQuery]);

  const serviceAvailability = useMemo(() => ({
    series: ['up', 'ready'].includes(serviceStatus.sonarr?.status),
    movie: ['up', 'ready'].includes(serviceStatus.radarr?.status),
    music: ['up', 'ready'].includes(serviceStatus.lidarr?.status),
  }), [serviceStatus]);
  const hasLibraryServices = serviceAvailability.series || serviceAvailability.movie || serviceAvailability.music;

  const availableLibraryFilters = useMemo(() => TYPE_FILTERS.filter((filter) => {
    if (filter.key === 'all') return serviceAvailability.series || serviceAvailability.movie || serviceAvailability.music;
    if (filter.key === 'series') return serviceAvailability.series;
    if (filter.key === 'movie') return serviceAvailability.movie;
    if (filter.key === 'music') return serviceAvailability.music;
    if (filter.key === 'missing') return serviceAvailability.series || serviceAvailability.movie;
    return true;
  }), [serviceAvailability]);

  const availableAddTypes = useMemo(() => (
    [{ key: 'movie', label: 'Movies', icon: 'movie' }, { key: 'series', label: 'TV', icon: 'tv' }, { key: 'music', label: 'Music', icon: 'album' }]
      .filter((filter) => serviceAvailability[filter.key])
  ), [serviceAvailability]);

  useEffect(() => {
    latestSearchRef.current = { query, activeType };
  }, [query, activeType]);

  useEffect(() => {
    if (availableLibraryFilters.some(filter => filter.key === activeType)) return;
    setActiveType(availableLibraryFilters[0]?.key || 'all');
  }, [availableLibraryFilters, activeType]);

  useEffect(() => {
    if (availableAddTypes.some(filter => filter.key === addType)) return;
    setAddType(availableAddTypes[0]?.key || 'movie');
  }, [availableAddTypes, addType]);

  // Library search
  const doLibrarySearch = useCallback(async (q, type) => {
    if (!hasLibraryServices) {
      setLoading(false);
      setInitialLoaded(true);
      return;
    }
    const requestId = ++libraryRequestRef.current;
    setLoading(true);
    setLibraryError(null);
    try {
      const data = await apiFetch(`/api/library/search?q=${encodeURIComponent(q)}&type=${type}`);
      if (requestId !== libraryRequestRef.current) return;
      setResults({
        series: Array.isArray(data.series) ? data.series : [],
        movies: Array.isArray(data.movies) ? data.movies : [],
        artists: Array.isArray(data.artists) ? data.artists : [],
      });
      setLibraryServiceStates(data.serviceStates || null);
      libraryFailureRef.current = { count: 0, lastGoodAt: Date.now() };
    } catch (err) {
      if (requestId !== libraryRequestRef.current) return;
      const message = String(err?.message || 'Library request failed');
      const transientFailure =
        message.startsWith('backoff:') ||
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('Load failed');
      const shouldRetryMessage = transientFailure || isSetupAdjacentError(err);
      const nextFailureCount = libraryFailureRef.current.count + 1;
      const hasLoadedSuccessfully = Boolean(libraryFailureRef.current.lastGoodAt);
      libraryFailureRef.current = {
        ...libraryFailureRef.current,
        count: nextFailureCount,
      };
      if (transientFailure && (initialLoaded || hasLoadedSuccessfully)) {
        setLibraryError(null);
        return;
      }
      if (transientFailure && nextFailureCount < 3) {
        setLibraryError(null);
        return;
      }
      setLibraryError(shouldRetryMessage
        ? Object.assign(new Error('Reconnecting to the library…'), err, { message: 'Reconnecting to the library…' })
        : err);
    } finally {
      if (requestId === libraryRequestRef.current) {
        setLoading(false);
        setInitialLoaded(true);
      }
    }
  }, [hasLibraryServices, initialLoaded]);

  // Lookup search (add mode)
  const doLookupSearch = useCallback(async (q, type) => {
    if (!q.trim()) {
      setLookupResults([]);
      setMusicSections(null);
      setLookupError(null);
      return;
    }
    const requestId = ++lookupRequestRef.current;
    setLoading(true);
    setLookupError(null);
    const endpoint = type === 'movie' ? 'movie' : type === 'series' ? 'series' : 'music';
    try {
      const data = await apiFetch(`/api/lookup/${endpoint}?term=${encodeURIComponent(q)}`);
      if (requestId !== lookupRequestRef.current) return;
      if (type === 'music' && data && !Array.isArray(data)) {
        // Preserve grouped sections for rendering, but flatten them for shared empty/loading handling.
        setMusicSections(data);
        setLookupResults([...(data.artists || []), ...(data.albums || []), ...(data.singles || [])]);
      } else {
        setMusicSections(null);
        setLookupResults(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      if (requestId !== lookupRequestRef.current) return;
      setLookupResults([]);
      setMusicSections(null);
      setLookupError(err);
    } finally {
      if (requestId === lookupRequestRef.current) setLoading(false);
    }
  }, []);

  // Fetch download queue for badge display
  const fetchQueue = useCallback(async () => {
    try {
      const items = await apiFetch('/api/arr-queue');
      const sIds = new Set();
      const mIds = new Set();
      // Materialize queue membership once so library cards can do cheap badge lookups.
      for (const item of items) {
        if (item.service === 'sonarr' && item.seriesId) sIds.add(item.seriesId);
        if (item.service === 'radarr' && item.movieId) mIds.add(item.movieId);
      }
      setQueuedSeriesIds(sIds);
      setQueuedMovieIds(mIds);
    } catch {}
  }, []);

  // Manual refresh handler
  const handleRefresh = useCallback(() => {
    if (!hasLibraryServices) return;
    setRefreshing(true);
    apiFetch('/api/library/refresh')
      .then(() => {
        doLibrarySearch(query, activeType);
        fetchQueue();
      })
      .catch((err) => setLibraryError(err))
      .finally(() => setRefreshing(false));
  }, [query, activeType, hasLibraryServices, doLibrarySearch, fetchQueue]);

  // Initial load
  useEffect(() => {
    if (!hasLibraryServices) {
      setLibraryError(null);
      setResults({ series: [], movies: [], artists: [] });
      setLibraryServiceStates(null);
      setInitialLoaded(true);
      setLoading(false);
      return;
    }
    doLibrarySearch(latestSearchRef.current.query, latestSearchRef.current.activeType);
    fetchQueue();
    const poll = setInterval(() => {
      doLibrarySearch(latestSearchRef.current.query, latestSearchRef.current.activeType);
      fetchQueue();
    }, 15000);
    return () => clearInterval(poll);
  }, [doLibrarySearch, fetchQueue, hasLibraryServices]);

  // Debounced search
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (mode === 'library') {
      if (!hasLibraryServices) return;
      // The mount effect already loads the default library view; skip that duplicate fetch.
      if (!initialLoaded) return;
      debounceRef.current = setTimeout(() => doLibrarySearch(query, activeType), 300);
    } else {
      if (!query.trim()) { setLookupResults([]); setLookupError(null); return; }
      debounceRef.current = setTimeout(() => doLookupSearch(query, addType), 400);
    }
    return () => clearTimeout(debounceRef.current);
  }, [query, activeType, mode, addType, initialLoaded, doLibrarySearch, doLookupSearch, hasLibraryServices]);

  // Reset on mode change — going to 'add' keeps the query so it pre-fills the lookup
  useEffect(() => {
    setLookupResults([]);
    setMusicSections(null);
    setLookupError(null);
    if (mode === 'library') {
      setQuery('');
      setLibraryError(null);
      if (hasLibraryServices) doLibrarySearch('', activeType);
      else {
        setInitialLoaded(true);
        setLoading(false);
        setResults({ series: [], movies: [], artists: [] });
      }
    }
  }, [mode, activeType, doLibrarySearch, hasLibraryServices]);

  // Compute missing / wanted items for the "Missing" filter
  const { missingSeries, missingMovies } = useMemo(() => ({
    missingSeries: results.series
      .filter(s => s.monitored && s.totalEpisodeCount > 0 && s.episodeFileCount < s.totalEpisodeCount)
      .sort((a, b) => (b.totalEpisodeCount - b.episodeFileCount) - (a.totalEpisodeCount - a.episodeFileCount)),
    missingMovies: results.movies.filter(m => m.monitored && !m.hasFile),
  }), [results.series, results.movies]);

  const isMissingFilter = activeType === 'missing';

  // Determine what to show given the active filter
  const visibleSeries = isMissingFilter ? missingSeries : (activeType === 'all' || activeType === 'series' ? results.series : []);
  const visibleMovies = isMissingFilter ? missingMovies : (activeType === 'all' || activeType === 'movie' ? results.movies : []);
  const visibleArtists = isMissingFilter ? [] : (activeType === 'all' || activeType === 'music' ? results.artists : []);

  const totalLibrary = visibleSeries.length + visibleMovies.length + visibleArtists.length;
  const effectiveServiceStates = {
    series: libraryServiceStates?.series || { status: serviceAvailability.series ? 'ready' : 'unconfigured', error: null },
    movies: libraryServiceStates?.movies || { status: serviceAvailability.movie ? 'ready' : 'unconfigured', error: null },
    artists: libraryServiceStates?.artists || { status: serviceAvailability.music ? 'ready' : 'unconfigured', error: null },
  };
  const activeLibraryIssue = activeType === 'series'
    ? effectiveServiceStates.series
    : activeType === 'movie'
      ? effectiveServiceStates.movies
      : activeType === 'music'
        ? effectiveServiceStates.artists
        : null;
  const libraryModeUnavailable = availableLibraryFilters.length === 0;
  const addModeUnavailable = availableAddTypes.length === 0;
  const unavailableServices = [
    !serviceAvailability.series && 'TV',
    !serviceAvailability.movie && 'Movies',
    !serviceAvailability.music && 'Music',
  ].filter(Boolean);
  const isLibraryEmptyWelcome = initialLoaded && !loading && !query.trim() && !isMissingFilter && activeType === 'all' && totalLibrary === 0 && !libraryModeUnavailable && !libraryError && !isServiceIssueStatus(activeLibraryIssue?.status) && hasLibraryServices && availableAddTypes.length > 0;

  const jumpToAddMode = useCallback(() => {
    if (addModeUnavailable) {
      onOpenSettings?.();
      return;
    }
    const typeMap = { series: 'series', movie: 'movie', music: 'music' };
    if (typeMap[activeType]) setAddType(typeMap[activeType]);
    setMode('add');
  }, [addModeUnavailable, activeType, onOpenSettings]);

  useEffect(() => {
    if (!isLibraryEmptyWelcome || autoOpenedAddOnEmptyLibrary.current || mode !== 'library') return;
    const typeMap = { series: 'series', movie: 'movie', music: 'music' };
    if (typeMap[activeType]) setAddType(typeMap[activeType]);
    else if (availableAddTypes[0]?.key) setAddType(availableAddTypes[0].key);
    setMode('add');
    autoOpenedAddOnEmptyLibrary.current = true;
  }, [activeType, isLibraryEmptyWelcome, mode, availableAddTypes]);

  useEffect(() => {
    if (addPanel) addPanelHandledRef.current = false;
  }, [addPanel]);

  const handlePanelAdded = useCallback((payload) => {
    if (addPanelHandledRef.current) return;
    addPanelHandledRef.current = true;
    setAddPanel(null);
    doLibrarySearch('', 'all');
    onAdded?.(payload);
  }, [doLibrarySearch, onAdded]);

  return (
    <div className="flex-1 overflow-y-auto scroll-area">
      {/* Search header */}
      <div className="sticky top-0 z-10 bg-bg-base/80 backdrop-blur-[20px] border-b border-border-subtle px-8 py-4">
        {/* Mode toggle */}
        <div className="flex items-center gap-4 mb-3">
          <button
            onClick={() => setMode('library')}
            className={`flex items-center gap-1.5 text-[13px] font-medium pb-0.5 border-b-2 transition-colors ${
              mode === 'library' ? 'text-text-primary border-text-primary' : 'text-text-muted border-transparent hover:text-text-primary'
            }`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18, fontVariationSettings: mode === 'library' ? "'FILL' 1" : "'FILL' 0" }}>video_library</span>
            My Library
          </button>
          <button
            onClick={() => {
              if (addModeUnavailable) return;
              // Pre-select addType based on current library filter context
              const typeMap = { series: 'series', movie: 'movie', music: 'music' };
              if (typeMap[activeType]) setAddType(typeMap[activeType]);
              setMode('add');
            }}
            disabled={addModeUnavailable}
            className={`flex items-center gap-1.5 text-[13px] font-medium pb-0.5 border-b-2 transition-colors ${
              mode === 'add' ? 'text-text-primary border-text-primary' : 'text-text-muted border-transparent hover:text-text-primary'
            }`}
            style={{ opacity: addModeUnavailable ? 0.45 : 1, cursor: addModeUnavailable ? 'not-allowed' : 'pointer' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18, fontVariationSettings: mode === 'add' ? "'FILL' 1" : "'FILL' 0" }}>add_circle</span>
            Add New
          </button>
        </div>

        {/* Search + filters */}
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-rounded text-text-muted" style={{ fontSize: 20 }}>search</span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              disabled={mode === 'library' ? libraryModeUnavailable : addModeUnavailable}
              onChange={e => { setQuery(e.target.value); onExternalQueryChange?.(e.target.value); }}
              placeholder={mode === 'library'
                ? (libraryModeUnavailable ? 'Configure Radarr, Sonarr, or Lidarr in backend .env to browse the library' : 'Search your library...')
                : (addModeUnavailable ? 'No add services are configured in backend .env' : `Search for ${addType === 'movie' ? 'movies' : addType === 'series' ? 'TV shows' : 'artists'} to add...`)}
              className="search-input w-full pl-10 pr-10 py-2.5 bg-bg-card border border-border-subtle rounded-xl text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue focus:ring-1 focus:ring-accent-blue/30"
              style={{ opacity: mode === 'library' ? (libraryModeUnavailable ? 0.6 : 1) : (addModeUnavailable ? 0.6 : 1) }}
            />
            {query && (
              <button onClick={() => { setQuery(''); onExternalQueryChange?.(''); inputRef.current?.focus(); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary">
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
              </button>
            )}
          </div>
          {mode === 'library' && (
            <button
              onClick={handleRefresh}
              disabled={refreshing || !hasLibraryServices}
              title="Refresh library"
              className="flex items-center justify-center w-9 h-9 rounded-xl bg-bg-card border border-border-subtle text-text-muted hover:text-text-primary hover:border-border-medium transition-colors flex-none"
            >
              <span className={`material-symbols-rounded${refreshing ? ' animate-spin' : ''}`} style={{ fontSize: 18 }}>refresh</span>
            </button>
          )}

          {/* Type filter */}
          <div className="flex gap-1">
            {mode === 'library' ? (
              availableLibraryFilters.map(f => (
                <button
                  key={f.key}
                  onClick={() => setActiveType(f.key)}
                  className={`pill-springy flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-medium ${
                    activeType === f.key ? 'bg-white/10 text-text-primary ring-1 ring-white/15' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16, fontVariationSettings: activeType === f.key ? "'FILL' 1" : "'FILL' 0" }}>{f.icon}</span>
                  {f.label}
                </button>
              ))
            ) : (
              availableAddTypes.map(f => (
                <button
                  key={f.key}
                  onClick={() => setAddType(f.key)}
                  className={`pill-springy flex items-center gap-1.5 px-3 py-2 rounded-full text-[12px] font-medium ${
                    addType === f.key ? 'bg-white/10 text-text-primary ring-1 ring-white/15' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16, fontVariationSettings: addType === f.key ? "'FILL' 1" : "'FILL' 0" }}>{f.icon}</span>
                  {f.label}
                </button>
              ))
            )}
          </div>
        </div>
        {(unavailableServices.length > 0 || libraryError || lookupError || isServiceIssueStatus(activeLibraryIssue?.status)) && (
          <div className="mt-3 rounded-2xl border border-border-subtle bg-bg-card/80 px-4 py-3">
            {unavailableServices.length > 0 && (
              <p className="text-[12px] text-text-secondary">
                Unavailable right now: {unavailableServices.join(', ')}.
                {' '}This stack still reads manual service config from backend `.env` values.
                <button onClick={() => onOpenSettings?.()} className="ml-1 text-accent-blue hover:underline">View setup status</button>
              </p>
            )}
            {libraryError && mode === 'library' && <LibraryErrorNotice error={libraryError} title="Library Request Failed" />}
            {lookupError && mode === 'add' && <LibraryErrorNotice error={lookupError} title="Lookup Request Failed" />}
            {isServiceIssueStatus(activeLibraryIssue?.status) && activeLibraryIssue?.error && mode === 'library' && (
              <p className="text-[12px] text-accent-orange mt-1">{activeLibraryIssue.error}</p>
            )}
          </div>
        )}
        {mode === 'library' && initialLoaded && (
          <p className="text-[11px] text-text-muted mt-2">
            {loading ? 'Searching...' : isMissingFilter
              ? `${totalLibrary} item${totalLibrary !== 1 ? 's' : ''} need attention`
              : `${totalLibrary} result${totalLibrary !== 1 ? 's' : ''}`}
          </p>
        )}
      </div>

      {/* Library Results */}
      {mode === 'library' && (
        <div className="px-8 py-6 min-h-[760px]">
          {!initialLoaded && loading && (
            <div className="flex flex-col items-center justify-center py-20 text-text-muted">
              <span className="material-symbols-rounded animate-spin mb-3" style={{ fontSize: 32 }}>progress_activity</span>
              <p className="text-[13px]">Loading library…</p>
            </div>
          )}
          {visibleSeries.length > 0 && (
            <div key={`series-${activeType}`} className="mb-8 library-grid-fade">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px' }}>{isMissingFilter ? 'Incomplete TV Shows' : 'TV Shows'}</h2>
                <span style={{ fontSize: 12, color: 'rgba(235,235,245,0.50)', fontVariantNumeric: 'tabular-nums' }}>{visibleSeries.length}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16 }}>
                {visibleSeries.map(s => <SeriesCard key={s.id} series={s} onClick={() => setDetailView({ type: 'series', id: s.id })} queued={queuedSeriesIds.has(s.id)} />)}
              </div>
            </div>
          )}
          {visibleMovies.length > 0 && (
            <div key={`movies-${activeType}`} className="mb-8 library-grid-fade">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px' }}>{isMissingFilter ? 'Missing Films' : 'Films'}</h2>
                <span style={{ fontSize: 12, color: 'rgba(235,235,245,0.50)', fontVariantNumeric: 'tabular-nums' }}>{visibleMovies.length}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16 }}>
                {visibleMovies.map(m => <MovieCard key={m.id} movie={m} onClick={() => setDetailView({ type: 'movie', data: m })} queued={queuedMovieIds.has(m.id)} />)}
              </div>
            </div>
          )}
          {visibleArtists.length > 0 && (
            <div key={`artists-${activeType}`} className="mb-8 library-grid-fade">
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px' }}>Music</h2>
                <span style={{ fontSize: 12, color: 'rgba(235,235,245,0.50)', fontVariantNumeric: 'tabular-nums' }}>{visibleArtists.length}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16 }}>
                {visibleArtists.map(a => <ArtistCard key={a.id} artist={a} onClick={() => setDetailView({ type: 'artist', id: a.id })} />)}
              </div>
            </div>
          )}
          {initialLoaded && !loading && totalLibrary === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-text-muted">
              <span className="material-symbols-rounded mb-3" style={{ fontSize: 48, fontVariationSettings: "'FILL' 1" }}>
                {isLibraryEmptyWelcome ? 'playlist_add' : libraryError || isServiceIssueStatus(activeLibraryIssue?.status) ? 'cloud_off' : isMissingFilter ? 'task_alt' : 'search_off'}
              </span>
              <p className="text-[14px]">
                {isLibraryEmptyWelcome
                  ? 'Your library is empty.'
                  : libraryModeUnavailable
                  ? 'No library services are configured yet.'
                  : activeLibraryIssue?.status === 'unconfigured'
                    ? 'That library service is not configured yet.'
                    : libraryError || isServiceIssueStatus(activeLibraryIssue?.status)
                      ? 'Library data is temporarily unavailable for this view.'
                    : isMissingFilter
                    ? 'Nothing missing — library is complete!'
                      : `No media found${query ? ` for "${query}"` : ''}`}
              </p>
              {libraryModeUnavailable || activeLibraryIssue?.status === 'unconfigured' ? (
                <p className="text-[12px] mt-1">
                  Configure Radarr, Sonarr, or Lidarr through backend `.env` values, restart the API, then refresh this view.
                  <button onClick={() => onOpenSettings?.()} className="ml-1 text-accent-blue hover:underline">View setup status</button>
                </p>
              ) : libraryError || isServiceIssueStatus(activeLibraryIssue?.status) ? (
                  <p className="text-[12px] mt-1">
                    Existing results stay visible when possible, but this request did not complete cleanly.
                    <button onClick={handleRefresh} className="ml-1 text-accent-blue hover:underline">Retry now</button>
                  </p>
              ) : isLibraryEmptyWelcome ? (
                <p className="text-[12px] mt-1">
                  Get started by searching and adding something to your library.
                  <button onClick={jumpToAddMode} className="ml-1 text-accent-blue hover:underline">Add New</button>
                </p>
              ) : !isMissingFilter && (
                <p className="text-[12px] mt-1">Try a different search, or switch to <button onClick={jumpToAddMode} className="text-accent-blue hover:underline">Add New</button></p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add New Results */}
      {mode === 'add' && (
        <div className="px-8 py-6 min-h-[760px]">
          {addModeUnavailable && (
            <div className="flex flex-col items-center justify-center py-20 text-text-muted">
              <span className="material-symbols-rounded mb-3" style={{ fontSize: 48, fontVariationSettings: "'FILL' 1" }}>settings</span>
              <p className="text-[14px]">No add services are configured yet.</p>
              <p className="text-[12px] mt-1">Configure Radarr, Sonarr, or Lidarr through backend `.env` values, restart the API, then <button onClick={() => onOpenSettings?.()} className="text-accent-blue hover:underline">view setup status</button>.</p>
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center py-20">
              <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 32 }}>progress_activity</span>
            </div>
          )}
          {!addModeUnavailable && !loading && query.trim() && lookupResults.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-text-muted">
              <span className="material-symbols-rounded mb-3" style={{ fontSize: 48, fontVariationSettings: "'FILL' 1" }}>search_off</span>
              <p className="text-[14px]">No results for "{query}"</p>
            </div>
          )}
          {!addModeUnavailable && !loading && !query.trim() && (
            <div className="flex flex-col items-center justify-center py-20 text-text-muted">
              <span className="material-symbols-rounded mb-3" style={{ fontSize: 48, fontVariationSettings: "'FILL' 1" }}>
                {addType === 'movie' ? 'movie' : addType === 'series' ? 'tv' : 'album'}
              </span>
              <p className="text-[14px]">Search for {addType === 'movie' ? 'movies' : addType === 'series' ? 'TV shows' : 'music'} to add</p>
              <p className="text-[12px] mt-1">Results from {addType === 'movie' ? 'Radarr' : addType === 'series' ? 'Sonarr' : 'Lidarr'}</p>
            </div>
          )}
          {!addModeUnavailable && !loading && lookupResults.length > 0 && (
            <div>
              {addType === 'music' && musicSections ? (() => {
                // Smart section ordering based on topCategory
                const sectionOrder = musicSections.topCategory === 'albums'
                  ? ['albums', 'artists', 'singles']
                  : musicSections.topCategory === 'singles'
                  ? ['singles', 'artists', 'albums']
                  : ['artists', 'albums', 'singles'];
                const sectionDefs = {
                  artists: { label: 'Artists', items: musicSections.artists, icon: 'person' },
                  albums: { label: 'Albums', items: musicSections.albums, icon: 'album' },
                  singles: { label: 'Singles & EPs', items: musicSections.singles, icon: 'music_note' },
                };
                return sectionOrder.map(key => {
                  const { label, items, icon } = sectionDefs[key];
                  if (!items || items.length === 0) return null;
                  return (
                    <div key={key} className="mb-8">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>{icon}</span>
                        <h3 className="text-[14px] font-semibold text-text-primary">{label}</h3>
                        <span className="text-[11px] text-text-muted">({items.length})</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
                        {items.map((item, i) => (
                          <ResultCard
                            key={`${item.foreignArtistId || item.foreignAlbumId || "x"}-${i}-${item.title || item.artistName || ""}`}
                            item={item}
                            mediaType={key === 'artists' ? 'music' : 'music-album'}
                            onClick={() => key === 'artists' ? setAddPanel(item) : setAddPanel({ ...item, _isAlbum: true, _albumType: key })}
                          />
                        ))}
                      </div>
                    </div>
                  );
                });
              })() : (
                <div>
                  <p className="text-[11px] text-text-muted mb-3">{lookupResults.length} result{lookupResults.length !== 1 ? 's' : ''}</p>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16 }}>
                    {lookupResults.map((item, i) => (
                      <ResultCard key={`${item.tmdbId || item.tvdbId || item.foreignArtistId || "x"}-${i}-${item.title || item.artistName || ""}`} item={item} mediaType={addType} onClick={() => setAddPanel(item)} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {detailView?.type === 'series' && <SeriesDetail seriesId={detailView.id} onClose={() => setDetailView(null)} onDelete={() => { setDetailView(null); doLibrarySearch('', activeType); }} />}
      {detailView?.type === 'artist' && <ArtistDetail artistId={detailView.id} onClose={() => setDetailView(null)} onDelete={() => { setDetailView(null); doLibrarySearch('', activeType); }} />}
      {detailView?.type === 'movie' && <MovieDownloadPanel movie={detailView.data} onClose={() => setDetailView(null)} onDelete={() => { setDetailView(null); doLibrarySearch('', activeType); }} />}
      {addPanel && <AddPanel item={addPanel} mediaType={addType} onClose={() => setAddPanel(null)} onAdded={handlePanelAdded} />}
    </div>
  );
}
