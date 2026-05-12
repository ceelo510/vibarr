import React, { useState, useMemo, useEffect } from 'react';
import { formatSpeed } from './utils';

/** Reactive prefers-reduced-motion hook. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e) => setReduced(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  return reduced;
}

const PIPELINE_STAGE_ORDER = ['queued', 'searching', 'grabbed', 'downloading', 'importing', 'complete'];
const PIPELINE_STAGE_LABELS = {
  queued: 'Queued', searching: 'Searching', grabbed: 'Grabbed',
  downloading: 'Downloading', importing: 'Importing', complete: 'Done',
};
const SVC_COLOR = { sonarr: '#3498db', radarr: '#e8b34b', lidarr: '#1db954' };
const SVC_LABEL_SHORT = { sonarr: 'TV', radarr: 'Movie', lidarr: 'Music' };

/** Formats a timestamp into relative time string (e.g. "3m ago"). */
function formatRelTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Formats milliseconds into a duration string (e.g. "2m 34s"). */
function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Collapsible card showing the auto-search/download lifecycle for one pipeline item.
 * @param {Object} item - Pipeline item from /api/pipeline
 * @param {boolean} expanded - Whether the step log is visible
 * @param {Function} onToggle - Toggle expanded state
 * @param {Function} onRetry - Retry the pipeline search
 * @param {Function} onCancel - Cancel and remove from pipeline
 * @param {Function} onMonitor - Mark item as monitored in the arr service
 * @param {Function} onManualSearch - Open manual search modal for this item
 * @param {Function} onDismiss - Dismiss completed/failed item
 */
function PipelineCard({ item, expanded, onToggle, onRetry, onCancel, onMonitor, onManualSearch, onDismiss }) {
  const [actionBusy, setActionBusy] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const reduced = useReducedMotion();

  const doCardAction = async (name, fn) => {
    setActionBusy(name);
    setActionMsg(null);
    try {
      await fn();
      setActionMsg({ ok: true, text: name === 'retry' ? 'Retrying…' : name === 'cancel' ? 'Removed' : name === 'monitor' ? 'Monitored' : 'Done' });
    } catch (e) {
      setActionMsg({ ok: false, text: e.message || 'Error' });
    }
    setActionBusy(null);
    setTimeout(() => setActionMsg(null), 3000);
  };

  const isStuck = item.stage === 'stuck';
  const isComplete = item.stage === 'complete';
  const isFailed = item.stage === 'failed';
  const isSearching = item.stage === 'searching';
  const isDownloading = item.stage === 'downloading';

  // Stuck/failed render against the searching node so the trail still points at a real stage.
  const activeStageIdx = isStuck || isFailed
    ? PIPELINE_STAGE_ORDER.indexOf('searching')
    : PIPELINE_STAGE_ORDER.indexOf(item.stage);

  const now = Date.now();
  const stageElapsedMs = now - item.stageStartedAt;
  const totalElapsedMs = now - item.startedAt;
  const stageElapsedStr = formatDuration(stageElapsedMs);
  const totalElapsedStr = formatDuration(totalElapsedMs);

  const svcColor = SVC_COLOR[item.service] || '#888';

  // Get most recent step message for prominent display
  // Steps append oldest -> newest, so the tail becomes the collapsed summary line.
  const latestStep = useMemo(() => item.steps?.length > 0 ? item.steps[item.steps.length - 1] : null, [item.steps]);

  // Stage dots for compact trail
  const stageDots = PIPELINE_STAGE_ORDER.filter(s => s !== 'complete');

  return (
    <div style={{
      borderRadius: 12,
      background: isStuck ? 'rgba(255,159,10,0.05)' : isComplete ? 'rgba(48,209,88,0.04)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${isStuck ? 'rgba(255,159,10,0.28)' : isComplete ? 'rgba(48,209,88,0.22)' : 'rgba(255,255,255,0.09)'}`,
      overflow: 'hidden',
      transition: reduced ? 'none' : 'border-color 400ms ease, background-color 400ms ease, box-shadow 400ms ease',
      animation: isStuck && !reduced ? 'pipeline-stuck-pulse 2.4s ease-in-out infinite' : 'none',
    }}>
      {/* Local keyframes (subtle stuck pulse) — kept inline to avoid new files */}
      <style>{`@keyframes pipeline-stuck-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,159,10,0.0)}50%{box-shadow:0 0 0 3px rgba(255,159,10,0.10)}}`}</style>
      {/* ── Main clickable row ── */}
      <div
        style={{ display: 'flex', gap: 12, padding: '12px 14px', cursor: 'pointer', alignItems: 'flex-start' }}
        onClick={onToggle}
      >
        {/* Poster */}
        <div style={{ width: 38, height: 54, borderRadius: 5, background: 'rgba(255,255,255,0.07)', flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
          {item.posterUrl
            ? <img src={item.posterUrl.startsWith('/api/') ? item.posterUrl : `/api/poster?url=${encodeURIComponent(item.posterUrl)}`}
                alt={item.title} decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span className="material-symbols-rounded" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: 'rgba(255,255,255,0.2)', fontVariationSettings: "'FILL' 1" }}>
                {item.service === 'sonarr' ? 'tv' : item.service === 'radarr' ? 'movie' : 'album'}
              </span>
          }
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Row 1: title + dismiss */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(235,235,245,0.92)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.title}
              </div>
              {item.subtitle && (
                <div style={{ fontSize: 10.5, color: 'rgba(235,235,245,0.40)', marginTop: 1 }}>
                  {SVC_LABEL_SHORT[item.service] || item.service}{item.subtitle ? ` · ${item.subtitle}` : ''}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {isComplete && (
                <span style={{ fontSize: 10, fontWeight: 700, color: '#30d158', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 12, fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                  Done
                </span>
              )}
              {!isComplete && !isStuck && (
                <span style={{ fontSize: 10, color: 'rgba(235,235,245,0.30)', fontVariantNumeric: 'tabular-nums' }}>
                  {stageElapsedStr}
                </span>
              )}
              <button
                onClick={e => { e.stopPropagation(); onDismiss?.(item.key); }}
                title="Dismiss"
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.22)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', display: 'flex', alignItems: 'center', transition: 'color 0.15s' }}
                onMouseEnter={e => e.target.style.color = 'rgba(255,255,255,0.5)'}
                onMouseLeave={e => e.target.style.color = 'rgba(255,255,255,0.22)'}
              >×</button>
            </div>
          </div>

          {/* Row 2: Stage trail */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 5 }}>
            {stageDots.map((stage, i) => {
              const stageIdx = PIPELINE_STAGE_ORDER.indexOf(stage);
              const isPast = !isStuck && stageIdx < activeStageIdx;
              const isActive = !isStuck && stage === item.stage;
              const isStuckHere = isStuck && stageIdx <= activeStageIdx;
              const dotColor = isComplete ? '#30d158'
                : isPast ? '#30d158'
                : isActive ? svcColor
                : isStuckHere && stageIdx === activeStageIdx ? '#ff9f0a'
                : 'rgba(255,255,255,0.18)';
              const textColor = isComplete ? '#30d158'
                : isPast ? 'rgba(48,209,88,0.7)'
                : isActive ? svcColor
                : isStuckHere && stageIdx === activeStageIdx ? '#ff9f0a'
                : 'rgba(255,255,255,0.22)';
              return (
                <span key={stage} style={{ display: 'flex', alignItems: 'center' }}>
                  {isActive && (
                    <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: svcColor, marginRight: 3, animation: reduced ? 'none' : 'pulse 1.5s ease-in-out infinite' }} />
                  )}
                  <span style={{ fontSize: 9.5, fontWeight: isActive || (isStuckHere && stageIdx === activeStageIdx) ? 700 : 400, color: textColor, letterSpacing: '0.01em', transition: reduced ? 'none' : 'color 400ms ease, font-weight 400ms ease' }}>
                    {PIPELINE_STAGE_LABELS[stage]}
                  </span>
                  {i < stageDots.length - 1 && (
                    <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.12)', margin: '0 4px' }}>›</span>
                  )}
                </span>
              );
            })}
          </div>

          {/* Row 3: Current activity message — most informative part */}
          {latestStep && !isComplete && !isStuck && (
            <div style={{
              fontSize: 11, color: isSearching ? 'rgba(235,235,245,0.55)' : 'rgba(235,235,245,0.45)',
              lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            }}>
              {isSearching && (
                <span style={{ display: 'inline-block', width: 4, height: 4, borderRadius: '50%', background: svcColor, marginRight: 5, verticalAlign: 'middle', animation: reduced ? 'none' : 'pulse 1.2s ease-in-out infinite' }} />
              )}
              {latestStep.message}
            </div>
          )}

          {/* Download progress bar */}
          {isDownloading && item.progress != null && (
            <div style={{ marginTop: 5 }}>
              <div style={{ height: 3, background: 'rgba(255,255,255,0.10)', borderRadius: 1.5, overflow: 'hidden' }}>
                <div style={{ width: `${item.progress}%`, height: '100%', background: svcColor, borderRadius: 1.5, transition: reduced ? 'none' : 'width 500ms ease, background-color 400ms ease' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                <span style={{ fontSize: 9.5, color: 'rgba(235,235,245,0.35)', fontVariantNumeric: 'tabular-nums' }}>{item.progress}%</span>
                {item.speed && <span style={{ fontSize: 9.5, color: svcColor, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatSpeed(item.speed)}</span>}
                {item.eta && <span style={{ fontSize: 9.5, color: 'rgba(235,235,245,0.35)', fontVariantNumeric: 'tabular-nums' }}>ETA {item.eta}</span>}
              </div>
            </div>
          )}

          {/* Stuck reason + actions */}
          {isStuck && item.stuckReason && (
            <div style={{ marginTop: 5, padding: '7px 10px', borderRadius: 7, background: 'rgba(255,159,10,0.08)', border: '1px solid rgba(255,159,10,0.18)' }}
              onClick={e => e.stopPropagation()}>
              <p style={{ fontSize: 10.5, color: 'rgba(255,200,80,0.9)', lineHeight: 1.4, margin: '0 0 6px 0' }}>{item.stuckReason}</p>
              {actionMsg && (
                <p style={{ fontSize: 10, color: actionMsg.ok ? '#30d158' : '#ff453a', marginBottom: 4, margin: 0 }}>{actionMsg.text}</p>
              )}
              <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
                {item.canRetry && (
                  <button disabled={!!actionBusy}
                    onClick={() => doCardAction('retry', () => onRetry?.(item.key))}
                    style={{ fontSize: 10, fontWeight: 600, color: '#ff9f0a', background: 'rgba(255,159,10,0.15)', border: '1px solid rgba(255,159,10,0.3)', borderRadius: 5, padding: '3px 8px', cursor: actionBusy ? 'not-allowed' : 'pointer', opacity: actionBusy && actionBusy !== 'retry' ? 0.5 : 1 }}>
                    {actionBusy === 'retry' ? '…' : 'Retry'}
                  </button>
                )}
                <button onClick={() => onManualSearch?.(item)}
                  style={{ fontSize: 10, fontWeight: 600, color: '#0a84ff', background: 'rgba(10,132,255,0.15)', border: '1px solid rgba(10,132,255,0.3)', borderRadius: 5, padding: '3px 8px', cursor: 'pointer' }}>
                  Manual Search
                </button>
                <button disabled={!!actionBusy}
                  onClick={() => doCardAction('monitor', () => onMonitor?.(item.key))}
                  style={{ fontSize: 10, fontWeight: 600, color: 'rgba(235,235,245,0.6)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 5, padding: '3px 8px', cursor: actionBusy ? 'not-allowed' : 'pointer', opacity: actionBusy && actionBusy !== 'monitor' ? 0.5 : 1 }}>
                  {actionBusy === 'monitor' ? '…' : 'Monitor'}
                </button>
                <button disabled={!!actionBusy}
                  onClick={() => doCardAction('cancel', () => onCancel?.(item.key))}
                  style={{ fontSize: 10, fontWeight: 600, color: '#ff453a', background: 'rgba(255,69,58,0.1)', border: '1px solid rgba(255,69,58,0.25)', borderRadius: 5, padding: '3px 8px', cursor: actionBusy ? 'not-allowed' : 'pointer', opacity: actionBusy && actionBusy !== 'cancel' ? 0.5 : 1 }}>
                  {actionBusy === 'cancel' ? '…' : 'Remove'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Expand chevron */}
        {item.steps?.length > 0 && (
          <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'rgba(255,255,255,0.2)', flexShrink: 0, marginTop: 2, transition: reduced ? 'none' : 'transform 200ms ease', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
            expand_more
          </span>
        )}
      </div>

      {/* ── Expanded detail drawer ── */}
      {expanded && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.18)' }}>
          {/* Stats row */}
          <div style={{ display: 'flex', gap: 16, padding: '10px 14px 6px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flex: 1, gap: 16, flexWrap: 'wrap', minWidth: 0 }}>
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.28)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Stage</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: isStuck ? '#ff9f0a' : isComplete ? '#30d158' : svcColor }}>
                  {isStuck ? 'Stuck' : PIPELINE_STAGE_LABELS[item.stage] || item.stage}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.28)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>In Stage</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(235,235,245,0.6)', fontVariantNumeric: 'tabular-nums' }}>{formatDuration(stageElapsedMs)}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.28)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Total</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(235,235,245,0.6)', fontVariantNumeric: 'tabular-nums' }}>{totalElapsedStr}</div>
              </div>
              {item.service && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.28)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Service</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: svcColor }}>{item.service}</div>
                </div>
              )}
              {isDownloading && item.speed && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.28)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Speed</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#30d158', fontVariantNumeric: 'tabular-nums' }}>{formatSpeed(item.speed)}</div>
                </div>
              )}
              {isDownloading && item.eta && (
                <div>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.28)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>ETA</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(235,235,245,0.6)', fontVariantNumeric: 'tabular-nums' }}>{item.eta}</div>
                </div>
              )}
            </div>
          </div>

          {/* Step log timeline */}
          {item.steps?.length > 0 && (
            <div style={{ padding: '10px 14px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(235,235,245,0.28)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Activity Log</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                {[...item.steps].reverse().map((step, i) => {
                  const isLatest = i === 0;
                  const relTime = formatRelTime(step.ts);
                  const absTime = new Date(step.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  return (
                    <div key={step.ts ?? i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      {/* Dot + line */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 12 }}>
                        <div style={{
                          width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                          background: isLatest ? (isStuck ? '#ff9f0a' : isComplete ? '#30d158' : svcColor) : 'rgba(255,255,255,0.18)',
                          boxShadow: isLatest && !isComplete && !isStuck ? `0 0 6px ${svcColor}60` : 'none',
                        }} />
                        {i < item.steps.length - 1 && (
                          <div style={{ width: 1, flex: 1, minHeight: 10, background: 'rgba(255,255,255,0.08)', marginTop: 3 }} />
                        )}
                      </div>
                      {/* Message + timestamp */}
                      <div style={{ flex: 1, minWidth: 0, paddingBottom: i < item.steps.length - 1 ? 4 : 0 }}>
                        <div style={{ fontSize: 11.5, color: isLatest ? 'rgba(235,235,245,0.80)' : 'rgba(235,235,245,0.42)', lineHeight: 1.4, fontWeight: isLatest ? 500 : 400 }}>
                          {step.message}
                        </div>
                        <div style={{ fontSize: 9.5, color: 'rgba(235,235,245,0.22)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }} title={absTime}>
                          {relTime} · {absTime}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Re-render only when visible card state changes; ignore stable callback churn from parent polling.
 */
function arePropsEqual(prev, next) {
  if (prev.expanded !== next.expanded) return false;
  const a = prev.item, b = next.item;
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.key !== b.key ||
    a.stage !== b.stage ||
    a.title !== b.title ||
    a.subtitle !== b.subtitle ||
    a.service !== b.service ||
    a.progress !== b.progress ||
    a.speed !== b.speed ||
    a.eta !== b.eta ||
    a.posterUrl !== b.posterUrl ||
    a.stuckReason !== b.stuckReason ||
    a.canRetry !== b.canRetry ||
    a.stageStartedAt !== b.stageStartedAt ||
    a.startedAt !== b.startedAt
  ) return false;
  // steps: compare length + last ts (cheap signature)
  const al = a.steps?.length || 0, bl = b.steps?.length || 0;
  if (al !== bl) return false;
  if (al > 0 && a.steps[al - 1]?.ts !== b.steps[bl - 1]?.ts) return false;
  return true;
}

export default React.memo(PipelineCard, arePropsEqual);
