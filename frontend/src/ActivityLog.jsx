import { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';

// ─── Inject keyframes once (no new deps; uses existing CSS vars) ────────────
if (typeof document !== 'undefined' && !document.getElementById('activity-log-anim-style')) {
  const st = document.createElement('style');
  st.id = 'activity-log-anim-style';
  st.textContent = `
    @keyframes activity-log-slidein {
      from { opacity: 0; transform: translateY(-6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .activity-log-entry { animation: activity-log-slidein 250ms cubic-bezier(0.22, 1, 0.36, 1); }
    .activity-log-truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;
  document.head.appendChild(st);
}

import { formatBytes, formatSpeed, timeAgo } from './utils';

const STATUS_CONFIG = {
  success: { icon: 'check_circle', color: '#30d158', label: 'Completed' },
  error:   { icon: 'error', color: '#ff453a', label: 'Failed' },
  pending: { icon: 'progress_activity', color: '#ff9f0a', label: 'In Progress' },
  info:    { icon: 'info', color: '#0a84ff', label: 'Info' },
};

const SERVICE_ICONS = { lidarr: 'album', sonarr: 'tv', radarr: 'movie' };

const SLSKD_STATES = {
  'Completed, Succeeded': { color: '#30d158', icon: 'check_circle', short: 'Done' },
  'InProgress':           { color: '#ff9f0a', icon: 'downloading', short: 'Downloading' },
  'Completed, Rejected':  { color: '#ff453a', icon: 'cancel', short: 'Rejected' },
  'Completed, Errored':   { color: '#ff453a', icon: 'error', short: 'Error' },
  'Queued, Locally':      { color: '#636366', icon: 'schedule', short: 'Queued' },
  'Queued, Remotely':     { color: '#636366', icon: 'hourglass_top', short: 'Waiting' },
  'Completed, Cancelled': { color: '#8e8e93', icon: 'block', short: 'Cancelled' },
};

// ─── Detail Modal ───────────────────────────────────────────────────────────

function DetailModal({ entry, onClose, slskdDownloads, onDeleteSlskd, onRetry }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    fetch(`/api/activity-log/${entry.id}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => { setDetail(data); setLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') setLoading(false); });
    return () => controller.abort();
  }, [entry.id]);

  const relatedDownloads = slskdDownloads.filter(dl => {
    if (!entry.context) return false;
    const ctx = entry.context;
    if (ctx.service === 'lidarr' && ctx.artistName) {
      return dl.artistName.toLowerCase().includes(ctx.artistName.toLowerCase());
    }
    return false;
  });

  const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.info;
  const svcIcon = entry.context?.service ? SERVICE_ICONS[entry.context.service] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-bg-card rounded-t-xl sm:rounded-xl border border-border-subtle shadow-xl w-full sm:max-w-lg sm:mx-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-bg-surface rounded-t-xl">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`material-symbols-rounded flex-none ${entry.status === 'pending' ? 'animate-spin' : ''}`}
              style={{ fontSize: 18, fontVariationSettings: "'FILL' 1", color: cfg.color }}>{cfg.icon}</span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-text-primary truncate">{cfg.label}</p>
              <p className="text-[10px] text-text-muted font-mono">{new Date(entry.timestamp).toLocaleString()}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {svcIcon && <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>{svcIcon}</span>}
            <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors">
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scroll-area">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="material-symbols-rounded animate-spin text-text-muted" style={{ fontSize: 24 }}>progress_activity</span>
            </div>
          ) : (
            <div className="p-4 space-y-4">
              <div className="bg-bg-surface rounded-lg p-3 border border-border-subtle">
                <p className="text-[12px] text-text-primary leading-relaxed">{entry.message}</p>
                {entry.context?.albumNames?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {entry.context.albumNames.map((n, i) => (
                      <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-accent-blue/10 text-accent-blue font-medium">{n}</span>
                    ))}
                  </div>
                )}
              </div>
              {detail?.steps?.length > 1 && (
                <div>
                  <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">Timeline</h4>
                  {detail.steps.map((step, i) => {
                    const sc = STATUS_CONFIG[step.status] || STATUS_CONFIG.info;
                    return (
                      <div key={i} className="flex items-start gap-2.5 py-1.5">
                        <div className="flex flex-col items-center flex-none">
                          <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ backgroundColor: sc.color }} />
                          {i < detail.steps.length - 1 && <div className="w-px flex-1 min-h-[12px] bg-border-subtle mt-0.5" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-text-primary leading-snug">{step.message}</p>
                          <p className="text-[9px] text-text-muted font-mono mt-0.5">{timeAgo(step.timestamp)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {detail?.details && (() => {
                const d = detail.details;
                const hasStatusMsgs = d.statusMessages?.length > 0;
                const hasMeta = d.trackedDownloadStatus || d.trackedDownloadState || d.status || d.protocol || d.errorMessage;
                if (!hasStatusMsgs && !hasMeta) return null;
                return (
                  <div>
                    <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">Error Details</h4>
                    <div className="space-y-2">
                      {hasMeta && (
                        <div className="bg-bg-surface rounded-lg p-3 border border-border-subtle space-y-1">
                          {d.errorMessage && (
                            <p className="text-[11px] text-accent-red font-medium">{d.errorMessage}</p>
                          )}
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                            {d.status && <span className="text-[10px] font-mono text-text-muted">status: <span className="text-text-secondary">{d.status}</span></span>}
                            {d.trackedDownloadStatus && <span className="text-[10px] font-mono text-text-muted">tracked: <span className="text-text-secondary">{d.trackedDownloadStatus}</span></span>}
                            {d.trackedDownloadState && <span className="text-[10px] font-mono text-text-muted">state: <span className="text-text-secondary">{d.trackedDownloadState}</span></span>}
                            {d.protocol && <span className="text-[10px] font-mono text-text-muted">via: <span className="text-text-secondary">{d.protocol}</span></span>}
                          </div>
                        </div>
                      )}
                      {hasStatusMsgs && d.statusMessages.map((sm, i) => (
                        <div key={i} className="bg-bg-surface rounded-lg p-3 border border-border-subtle">
                          {sm.title && <p className="text-[11px] font-semibold text-text-primary mb-1">{sm.title}</p>}
                          {sm.messages?.map((msg, j) => (
                            <p key={j} className="text-[11px] text-text-secondary leading-snug">{msg}</p>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {relatedDownloads.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">Soulseek Downloads</h4>
                  {relatedDownloads.map((dl, i) => (
                    <SlskdCard key={i} dl={dl} onDelete={onDeleteSlskd} onRetry={onRetry} />
                  ))}
                </div>
              )}
              {relatedDownloads.length === 0 && entry.context?.service === 'lidarr' && (
                <div className="bg-bg-surface rounded-lg p-3 border border-border-subtle flex items-center gap-2">
                  <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>cloud_queue</span>
                  <p className="text-[11px] text-text-muted">Soularr will search Soulseek. Downloads appear here once they begin.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SLSKD Card ─────────────────────────────────────────────────────────────

export function SlskdCard({ dl, onDelete, onRetry, compact }) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(null);
  const hasFailed = dl.failed > 0;
  const isActive = dl.inProgress > 0;
  const isQueued = dl.queued > 0 && dl.inProgress === 0 && dl.completed === 0;

  const handleDelete = async (e) => {
    e.stopPropagation();
    setDeleting(true);
    await onDelete(dl.username);
    setDeleting(false);
  };

  const handleRetry = async (username, fileId) => {
    setRetrying(fileId || username);
    await onRetry(username, fileId);
    setTimeout(() => setRetrying(null), 2000);
  };

  // Determine real state label
  let stateLabel, stateColor;
  if (dl.overallState === 'completed') { stateLabel = 'Complete'; stateColor = '#30d158'; }
  else if (dl.overallState === 'failed') { stateLabel = 'Failed'; stateColor = '#ff453a'; }
  else if (dl.overallState === 'partial') { stateLabel = 'Partial'; stateColor = '#ff9f0a'; }
  else if (isQueued) { stateLabel = 'Waiting for peer'; stateColor = '#636366'; }
  else if (isActive) { stateLabel = `${dl.percentComplete}%`; stateColor = '#30d158'; }
  else { stateLabel = 'Queued'; stateColor = '#636366'; }

  return (
    <div className={`bg-bg-surface rounded-lg border border-border-subtle ${compact ? '' : 'mb-2'} overflow-hidden`}>
      <div className="flex items-center gap-2.5 px-3 py-2 group">
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2.5 flex-1 min-w-0 text-left">
          <span className="w-2 h-2 rounded-full flex-none" style={{ backgroundColor: stateColor }} />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-text-primary font-medium truncate">{dl.artistName} — {dl.albumName}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[9px] font-mono text-text-muted">
                {dl.completed}/{dl.fileCount} files
                {dl.failed > 0 && <span className="text-accent-red"> · {dl.failed} failed</span>}
              </span>
              <span className="text-[9px] font-mono" style={{ color: stateColor }}>{stateLabel}</span>
            </div>
          </div>
          <span className="material-symbols-rounded text-text-muted flex-none" style={{ fontSize: 14, transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'none' }}>expand_more</span>
        </button>
        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-none">
          {hasFailed && (
            <button onClick={(e) => { e.stopPropagation(); handleRetry(dl.username); }}
              disabled={retrying === dl.username}
              className="p-1 rounded hover:bg-accent-orange/10 text-accent-orange transition-colors disabled:opacity-50"
              title="Retry failed">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>refresh</span>
            </button>
          )}
          <button onClick={handleDelete} disabled={deleting}
            className="p-1 rounded hover:bg-accent-red/10 text-text-muted hover:text-accent-red transition-colors disabled:opacity-50"
            title="Remove download">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {(isActive || dl.overallState === 'partial') && (
        <div className="px-3 pb-2">
          <div className="h-1 rounded-full bg-bg-hover overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${dl.percentComplete}%`, backgroundColor: hasFailed ? '#ff9f0a' : '#30d158' }} />
          </div>
        </div>
      )}

      {/* Expanded file list */}
      {expanded && (
        <div className="border-t border-border-subtle max-h-48 overflow-y-auto scroll-area">
          {dl.files.map((file, fi) => {
            const sc = SLSKD_STATES[file.state] || { color: '#6b7280', icon: 'help', short: file.state };
            const isFailed = file.state.includes('Rejected') || file.state.includes('Errored');
            return (
              <div key={fi} className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle last:border-b-0 hover:bg-bg-hover/30">
                <span className={`material-symbols-rounded flex-none ${file.state === 'InProgress' ? 'animate-spin' : ''}`}
                  style={{ fontSize: 12, fontVariationSettings: "'FILL' 1", color: sc.color }}>{sc.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-text-primary truncate">{file.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[9px] font-mono text-text-muted">{formatBytes(file.size)}</span>
                    {file.state === 'InProgress' && file.averageSpeed > 0 && (
                      <span className="text-[9px] font-mono text-accent-green">{formatSpeed(file.averageSpeed)}</span>
                    )}
                    <span className="text-[9px] font-mono" style={{ color: sc.color }}>{sc.short}</span>
                  </div>
                </div>
                {isFailed && (
                  <button onClick={() => handleRetry(dl.username, file.id)}
                    disabled={retrying === file.id}
                    className="flex-none px-1.5 py-0.5 rounded text-[9px] font-medium bg-accent-red/10 text-accent-red hover:bg-accent-red/20 disabled:opacity-50 transition-colors">
                    {retrying === file.id ? '...' : 'Retry'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// Severity color via CSS variables (consistent palette).
function severityVar(status) {
  switch (status) {
    case 'error':   return 'var(--accent-red, #ff453a)';
    case 'pending':
    case 'warn':    return 'var(--accent-orange, #ff9f0a)';
    case 'success': return 'var(--accent-green, #30d158)';
    default:         return 'var(--text-muted, #8e8e93)';
  }
}
function bucketKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}
function bucketLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}


const ActivityEntry = memo(function ActivityEntry({ entry, onSelect, onClear }) {
  const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.info;
  const svcIcon = entry.context?.service ? SERVICE_ICONS[entry.context.service] : null;
  const sevColor = severityVar(entry.status);
  return (
    <div className="activity-log-entry flex items-start gap-2 px-3 py-2 border-b border-border-subtle last:border-b-0 hover:bg-bg-hover/50 transition-colors group">
      <button onClick={() => onSelect(entry)} className="flex items-start gap-2 flex-1 min-w-0 text-left">
        <span className={`material-symbols-rounded flex-none mt-0.5 ${entry.status === 'pending' ? 'animate-spin' : ''}`}
          style={{ fontSize: 14, fontVariationSettings: "'FILL' 1", color: sevColor }}>{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          <p className="activity-log-truncate text-[11px] text-text-primary leading-snug" title={entry.message}>{entry.message}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            {svcIcon && <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 10, fontVariationSettings: "'FILL' 1" }}>{svcIcon}</span>}
            {entry.context?.artistName && <span className="activity-log-truncate text-[9px] text-accent-blue max-w-[180px]" title={entry.context.artistName}>{entry.context.artistName}</span>}
            {entry.context?.title && <span className="activity-log-truncate text-[9px] text-accent-blue max-w-[180px]" title={entry.context.title}>{entry.context.title}</span>}
          </div>
        </div>
      </button>
      <div className="flex items-center gap-1 flex-none">
        <span className="text-[9px] font-mono text-text-muted whitespace-nowrap" title={new Date(entry.timestamp).toLocaleString()}>{timeAgo(entry.timestamp)}</span>
        <button onClick={(e) => onClear(e, entry.id)}
          className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-all"
          title="Clear">
          <span className="material-symbols-rounded" style={{ fontSize: 12 }}>close</span>
        </button>
      </div>
    </div>
  );
});

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ActivityLog({ slskdDownloads: slskdProp, onSlskdUpdate }) {
  const [entries, setEntries] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [slskdOwn, setSlskdOwn] = useState([]);
  const pollRef = useRef(null);
  const logScrollRef = useRef(null);
  const stickToBottomRef = useRef(true);

  const slskdDownloads = slskdProp ?? slskdOwn;

  // Keep a ref to the latest slskdProp so the poll interval never
  // captures a stale closure value.
  const slskdPropRef = useRef(slskdProp);
  slskdPropRef.current = slskdProp;

  const poll = () => {
    fetch('/api/activity-log?limit=30').then(r => r.ok ? r.json() : []).then(setEntries).catch(() => {});
    if (!slskdPropRef.current) fetch('/api/slskd/downloads').then(r => r.ok ? r.json() : []).then(setSlskdOwn).catch(() => {});
  };
  const pollFnRef = useRef(poll);
  pollFnRef.current = poll;

  useEffect(() => {
    pollFnRef.current();
    pollRef.current = setInterval(() => pollFnRef.current(), 15000);
    return () => clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    // Auto-follow new entries only while the user is still pinned to the bottom.
    if (!stickToBottomRef.current) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const handleLogScroll = useCallback((event) => {
    const el = event.currentTarget;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
  }, []);

  const handleDeleteSlskd = async (username) => {
    try {
      await fetch(`/api/slskd/downloads/${encodeURIComponent(username)}`, { method: 'DELETE' });
      poll();
      onSlskdUpdate?.();
    } catch {}
  };

  const handleRetry = async (username, fileId) => {
    try {
      await fetch('/api/slskd/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, fileId }),
      });
      setTimeout(() => { poll(); onSlskdUpdate?.(); }, 1000);
    } catch {}
  };

  const handleClearEntry = async (e, id) => {
    e.stopPropagation();
    try {
      await fetch(`/api/activity-log/${id}`, { method: 'DELETE' });
      setEntries(prev => prev.filter(en => en.id !== id));
    } catch {}
  };

  const handleClearAll = async () => {
    try {
      await fetch('/api/activity-log', { method: 'DELETE' });
      setEntries([]);
    } catch {}
  };

  const hasRecent = entries.length > 0 && entries.some(e => (Date.now() - new Date(e.timestamp).getTime()) < 600000);
  const hasSlskd = slskdDownloads.length > 0;
  if (!hasRecent && !hasSlskd && !expanded) return null;
  if (dismissed && !expanded) return null;

  const displayEntries = expanded ? entries.slice(0, 30) : entries.slice(0, 5);
  const pendingCount = entries.filter(e => e.status === 'pending').length;
  const activeDL = slskdDownloads.filter(d => d.inProgress > 0).length;
  const queuedDL = slskdDownloads.filter(d => d.queued > 0 && d.inProgress === 0 && d.completed === 0).length;
  const failedDL = slskdDownloads.filter(d => d.failed > 0).length;

  return (
    <>
      <div className="fixed bottom-14 right-4 z-40" style={{ maxWidth: 420, width: expanded ? 420 : 340 }}>
        <div className="bg-bg-card rounded-lg border border-border-subtle shadow-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-bg-surface">
            <div className="flex items-center gap-2">
              <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>terminal</span>
              <span className="text-[12px] font-semibold text-text-primary">Activity</span>
              {pendingCount > 0 && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-orange/10 text-accent-orange">{pendingCount} active</span>}
              {activeDL > 0 && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-green/10 text-accent-green">{activeDL} DL</span>}
              {queuedDL > 0 && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">{queuedDL} queued</span>}
              {failedDL > 0 && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-red/10 text-accent-red">{failedDL} err</span>}
            </div>
            <div className="flex items-center gap-1">
              {(entries.length > 0 || slskdDownloads.length > 0) && expanded && (
                <button onClick={handleClearAll}
                  className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
                  title="Clear all activity">
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete_sweep</span>
                </button>
              )}
              <button onClick={() => setExpanded(!expanded)}
                className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{expanded ? 'collapse_content' : 'expand_content'}</span>
              </button>
              <button onClick={() => { setDismissed(true); setExpanded(false); }}
                className="p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors">
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
              </button>
            </div>
          </div>

          {/* SLSKD Panel - always show if there are downloads */}
          {hasSlskd && (
            <div className={expanded ? '' : ''}>
              <div className="px-3 py-2 bg-bg-surface/50 flex items-center gap-2 border-b border-border-subtle">
                <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>cloud_download</span>
                <span className="text-[11px] font-semibold text-text-primary">Soulseek</span>
              </div>
              <div className={`overflow-y-auto scroll-area ${expanded ? 'max-h-52' : 'max-h-36'}`}>
                {slskdDownloads.map((dl, i) => (
                  <SlskdCard key={dl.username + dl.directory} dl={dl} onDelete={handleDeleteSlskd} onRetry={handleRetry} compact />
                ))}
              </div>
            </div>
          )}

          {/* Activity entries */}
          {displayEntries.length > 0 && (
            <>
              {hasSlskd && (
                <div className="px-3 py-2 bg-bg-surface/50 flex items-center gap-2 border-b border-border-subtle border-t">
                  <span className="material-symbols-rounded text-text-muted" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>history</span>
                  <span className="text-[11px] font-semibold text-text-primary">Log</span>
                </div>
              )}
              <div ref={logScrollRef} onScroll={handleLogScroll} className={`overflow-y-auto scroll-area ${expanded ? 'max-h-48' : 'max-h-32'}`}>
                {(() => {
                  const out = [];
                  let lastBucket = null;
                  for (const entry of displayEntries) {
                    const bk = bucketKey(entry.timestamp);
                    // Group bursts from the same minute under one compact timestamp header.
                    if (bk !== lastBucket) {
                      out.push(
                        <div key={`hdr-${bk}`} className="px-3 py-1 text-[9px] font-mono uppercase tracking-wider border-b border-border-subtle/60 bg-bg-surface/30" style={{ color: 'var(--text-muted, #8e8e93)' }}>
                          {bucketLabel(entry.timestamp)}
                        </div>
                      );
                      lastBucket = bk;
                    }
                    out.push(
                      <ActivityEntry key={entry.id} entry={entry} onSelect={setSelectedEntry} onClear={handleClearEntry} />
                    );
                  }
                  return out;
                })()}
              </div>
            </>
          )}

          {!hasSlskd && displayEntries.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-text-muted">No recent activity</div>
          )}
        </div>
      </div>

      {selectedEntry && (
        <DetailModal entry={selectedEntry} onClose={() => setSelectedEntry(null)}
          slskdDownloads={slskdDownloads} onDeleteSlskd={handleDeleteSlskd} onRetry={handleRetry} />
      )}
    </>
  );
}
