import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { formatBytes, detectQualityLabel } from './utils';

const QUALITY_ORDER = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'HDTV': 4, 'WEB': 5, 'BluRay': 6, 'CAM': 7, 'Other': 8 };

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const ResultRow = memo(function ResultRow({ r, isGrabbing, isGrabbed, anyGrabbing, onGrabClick }) {
  return (
    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
      <td style={{ padding: '10px 12px', color: '#fff', maxWidth: 320 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 500 }}>{r.title}</div>
        <div style={{ fontSize: 10, color: 'rgba(235,235,245,0.35)', marginTop: 2 }}>{r.indexer}{r.rejections?.length > 0 && ` · ⚠ ${r.rejections[0]}`}</div>
      </td>
      <td style={{ padding: '10px 12px', color: 'rgba(235,235,245,0.7)', whiteSpace: 'nowrap' }}>{r.quality}</td>
      <td style={{ padding: '10px 12px', color: 'rgba(235,235,245,0.7)', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{formatBytes(r.size)}</td>
      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
        <span style={{ color: r.seeders >= 10 ? '#30d158' : r.seeders >= 3 ? '#ff9f0a' : '#ff453a', fontWeight: 700, fontFamily: 'monospace' }}>{r.seeders}</span>
        <span style={{ color: 'rgba(235,235,245,0.3)', marginLeft: 3, fontSize: 10 }}>/ {r.leechers}</span>
      </td>
      <td style={{ padding: '10px 12px', color: 'rgba(235,235,245,0.4)', whiteSpace: 'nowrap', fontSize: 10 }}>
        {r.ageHours < 24 ? `${Math.round(r.ageHours)}h` : `${Math.round(r.ageHours / 24)}d`}
      </td>
      <td style={{ padding: '10px 12px' }}>
        <button
          onClick={onGrabClick}
          disabled={anyGrabbing}
          style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: isGrabbing ? 'rgba(10,132,255,0.5)' : isGrabbed ? '#30d158' : '#0a84ff', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: anyGrabbing ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', minWidth: 46 }}>
          {isGrabbing ? '…' : isGrabbed ? '✓' : 'Grab'}
        </button>
      </td>
    </tr>
  );
});

/**
 * Full-screen modal for manual torrent/release searching and grabbing.
 * @param {Object} target - { service, title, retryId, seriesId, movieId, seasonNumbers }
 * @param {Array} results - Release objects from the search API
 * @param {boolean} loading - Whether a search is in progress
 * @param {Function} onClose - Called when the modal should close
 * @param {Function} onGrab - Called with a release object to grab
 */
export default function ManualSearchModal({ target, results, loading, onClose, onGrab }) {
  const [sortBy, setSortBy] = useState('seeders');
  const [sortDir, setSortDir] = useState('desc');
  const [exactMatchOnly, setExactMatchOnly] = useState(false);
  const [qualityFilters, setQualityFilters] = useState([]);
  const [minSeeders, setMinSeeders] = useState(0);
  const [showCount, setShowCount] = useState(50);
  const [grabbingGuid, setGrabbingGuid] = useState(null);
  const [grabResult, setGrabResult] = useState(null);
  const [grabError, setGrabError] = useState(null);
  const [open, setOpen] = useState(false); // for enter/exit transitions
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef(null);
  const closeTimerRef = useRef(null);
  const reduced = prefersReducedMotion();

  // Kick open one frame later so the enter transition has a closed starting point.
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const requestClose = useCallback(() => {
    if (closing) return;
    if (reduced) { onClose(); return; }
    setClosing(true);
    setOpen(false);
    closeTimerRef.current = setTimeout(() => onClose(), 200);
  }, [closing, onClose, reduced]);

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  // Keep focus inside the dialog while it is mounted.
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); requestClose(); return; }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    // initial focus
    const t = setTimeout(() => dialogRef.current?.focus(), 50);
    return () => { document.removeEventListener('keydown', handleKey); clearTimeout(t); };
  }, [requestClose]);

  const allQualities = [...new Set(results.map(r => detectQualityLabel(r)))]
    .sort((a, b) => (QUALITY_ORDER[a] ?? 99) - (QUALITY_ORDER[b] ?? 99));

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const toggleQuality = (q) => {
    setQualityFilters(prev => prev.includes(q) ? prev.filter(x => x !== q) : [...prev, q]);
    setShowCount(50);
  };

  // "Exact" means Arr accepted the release; rejected rows stay available behind the toggle.
  let filtered = exactMatchOnly ? results.filter(r => !r.rejected) : results;
  if (qualityFilters.length > 0) filtered = filtered.filter(r => qualityFilters.includes(detectQualityLabel(r)));
  if (minSeeders > 0) filtered = filtered.filter(r => (r.seeders || 0) >= minSeeders);

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'seeders') cmp = (b.seeders || 0) - (a.seeders || 0);
    else if (sortBy === 'size') cmp = (b.size || 0) - (a.size || 0);
    else if (sortBy === 'quality') cmp = (QUALITY_ORDER[detectQualityLabel(a)] ?? 99) - (QUALITY_ORDER[detectQualityLabel(b)] ?? 99);
    else cmp = (b.seeders || 0) - (a.seeders || 0) || (b.size || 0) - (a.size || 0);
    return sortDir === 'asc' ? -cmp : cmp;
  });

  const visible = sorted.slice(0, showCount);
  const hasMore = sorted.length > showCount;

  const handleGrabClick = useCallback((r) => {
    // Serialize grabs so repeat clicks cannot submit multiple releases at once.
    if (grabbingGuid) return;
    setGrabbingGuid(r.guid);
    setGrabResult(null);
    onGrab(r)
      .then(() => { setGrabResult({ success: true, title: r.title }); setGrabbingGuid(null); })
      .catch((err) => { setGrabError({ title: r.title, message: err?.message || 'Grab failed' }); setTimeout(() => setGrabError(null), 5000); setGrabbingGuid(null); });
  }, [grabbingGuid, onGrab]);

  const SortBtn = ({ col, label }) => {
    const active = sortBy === col;
    return (
      <button onClick={() => toggleSort(col)}
        style={{ fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, border: `1px solid ${active ? 'rgba(10,132,255,0.4)' : 'rgba(255,255,255,0.12)'}`, background: active ? 'rgba(10,132,255,0.15)' : 'transparent', color: active ? '#0a84ff' : 'rgba(235,235,245,0.5)' }}
      >
        {label}
        {active && <span style={{ fontSize: 9 }}>{sortDir === 'desc' ? '↓' : '↑'}</span>}
      </button>
    );
  };

  const transition = reduced ? 'none' : 'opacity 200ms ease, transform 200ms ease, backdrop-filter 200ms ease';
  const backdropOpacity = open ? 1 : 0;
  const dialogTransform = open ? 'scale(1)' : 'scale(0.96)';
  const dialogOpacity = open ? 1 : 0;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)', opacity: backdropOpacity, transition, willChange: 'opacity' }}
      onClick={requestClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Manual Search"
        style={{ background: '#1c1c1e', borderRadius: 16, border: '1px solid rgba(255,255,255,0.1)', width: '90%', maxWidth: 800, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', opacity: dialogOpacity, transform: dialogTransform, transition, willChange: 'opacity, transform', outline: 'none' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Manual Search</div>
            <div style={{ fontSize: 11, color: 'rgba(235,235,245,0.45)', marginTop: 2 }}>
              {target.title} · Showing {Math.min(visible.length, sorted.length)} of {results.length} result{results.length !== 1 ? 's' : ''}
              {(qualityFilters.length > 0 || minSeeders > 0 || exactMatchOnly) && sorted.length !== results.length ? ` (${sorted.length} after filters)` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              onClick={() => setExactMatchOnly(v => !v)}
              style={{ fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: `1px solid ${exactMatchOnly ? 'rgba(10,132,255,0.4)' : 'rgba(255,255,255,0.15)'}`, background: exactMatchOnly ? 'rgba(10,132,255,0.15)' : 'transparent', color: exactMatchOnly ? '#0a84ff' : 'rgba(235,235,245,0.5)' }}
            >Exact Match</button>
            <SortBtn col="seeders" label="Seeds" />
            <SortBtn col="size" label="Size" />
            <SortBtn col="quality" label="Quality" />
            <button onClick={requestClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 18, marginLeft: 4 }}>✕</button>
          </div>
        </div>

        {/* Quality chips + Seeders filter bar */}
        {!loading && results.length > 0 && (
          <div style={{ padding: '8px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {allQualities.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Quality:</span>
                {allQualities.map(q => (
                  <button key={q} onClick={() => toggleQuality(q)}
                    style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${qualityFilters.includes(q) ? 'rgba(10,132,255,0.4)' : 'rgba(255,255,255,0.12)'}`, background: qualityFilters.includes(q) ? 'rgba(10,132,255,0.2)' : 'rgba(255,255,255,0.05)', color: qualityFilters.includes(q) ? '#0a84ff' : 'rgba(235,235,245,0.5)' }}
                  >{q}</button>
                ))}
                {qualityFilters.length > 0 && (
                  <button onClick={() => setQualityFilters([])}
                    style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)', color: 'rgba(235,235,245,0.4)' }}
                  >✕ Clear</button>
                )}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Seeds:</span>
              {[[0,'Any'],[5,'5+'],[10,'10+'],[25,'25+']].map(([val, label]) => (
                <button key={val} onClick={() => { setMinSeeders(val); setShowCount(50); }}
                  style={{ fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, cursor: 'pointer', border: `1px solid ${minSeeders === val ? 'rgba(48,209,88,0.4)' : 'rgba(255,255,255,0.12)'}`, background: minSeeders === val ? 'rgba(48,209,88,0.15)' : 'rgba(255,255,255,0.05)', color: minSeeders === val ? '#30d158' : 'rgba(235,235,245,0.5)' }}
                >{label}</button>
              ))}
            </div>
          </div>
        )}

        {grabResult && (
          <div style={{ padding: '8px 20px', background: grabResult.success ? 'rgba(48,209,88,0.12)' : 'rgba(255,69,58,0.12)', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1", color: grabResult.success ? '#30d158' : '#ff453a' }}>{grabResult.success ? 'check_circle' : 'error'}</span>
            <span style={{ fontSize: 11, fontWeight: 500, color: grabResult.success ? '#30d158' : '#ff453a' }}>{grabResult.success ? `Grabbed — downloading shortly` : `Grab failed`}</span>
          </div>
        )}
        {loading ? (
          <div style={{ padding: '16px 20px' }} aria-busy="true" aria-label="Searching indexers">
            <style>{`@keyframes msm-shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}`}</style>
            {[0,1,2,3,4,5].map(i => (
              <div key={i} style={{
                height: 38, marginBottom: 8, borderRadius: 6,
                background: reduced
                  ? 'rgba(255,255,255,0.05)'
                  : 'linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.04) 100%)',
                backgroundSize: '800px 100%',
                animation: reduced ? 'none' : 'msm-shimmer 1.4s infinite linear',
                opacity: 1 - i * 0.12,
              }} />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: '32px 40px', textAlign: 'center' }}>
            <div style={{ color: 'rgba(235,235,245,0.4)', fontSize: 13, marginBottom: 12 }}>
              {exactMatchOnly && results.filter(r => r.rejected).length > 0
                ? `No exact matches — toggle filter to see ${results.length} rejected release${results.length !== 1 ? 's' : ''}`
                : 'No releases found from indexers'}
            </div>
            {(() => {
              const rejected = results.filter(r => r.rejected);
              // Collapse backend-specific rejection strings into one short empty-state summary.
              if (!exactMatchOnly || rejected.length === 0) return null;
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
                <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '10px 16px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(235,235,245,0.3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Why rejected</div>
                  {entries.map(([cat, count]) => (
                    <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#ff9f0a', fontFamily: 'monospace', minWidth: 28, textAlign: 'right' }}>{count}×</span>
                      <span style={{ fontSize: 11, color: 'rgba(235,235,245,0.55)' }}>{cat}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          <div style={{ overflowY: 'auto', overflowX: 'auto', flex: 1 }}>
            {grabError && (
              <div style={{ padding: 12, marginBottom: 12, background: 'rgba(255, 69, 58, 0.15)', border: '1px solid rgba(255, 69, 58, 0.5)', borderRadius: 8, fontSize: 12, color: '#ff453a' }}>
                <strong>{grabError.title}</strong>: {grabError.message}
              </div>
            )}
            <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                  {['Release', 'Quality', 'Size', 'Seeds', 'Age', ''].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'rgba(235,235,245,0.4)', fontWeight: 600, fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => (
                  <ResultRow
                    key={r.guid || i}
                    r={r}
                    isGrabbing={grabbingGuid === r.guid}
                    isGrabbed={grabResult?.success && grabResult?.title === r.title}
                    anyGrabbing={!!grabbingGuid}
                    onGrabClick={() => handleGrabClick(r)}
                  />
                ))}
              </tbody>
            </table>
            {hasMore && (
              <div style={{ padding: '10px 12px', textAlign: 'center' }}>
                <button onClick={() => setShowCount(c => c + 50)}
                  style={{ fontSize: 11, fontWeight: 600, color: 'rgba(235,235,245,0.5)', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 20px', cursor: 'pointer' }}
                >
                  Show more ({sorted.length - showCount} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
