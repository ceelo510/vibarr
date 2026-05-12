import { Router } from 'express';
import { CONFIG, TIMING } from './config.js';
import { fetchWithTimeout, pickArrImageUrl, qbittorrentLogin } from './utils.js';
import {
  getPipeline, getPipelineItem, addPipelineItem, advancePipeline,
  completePipeline, removePipelineItem, setPipelineStuck,
  addLogStep, updateLogEntry, logActivity,
  getActivityLog, registerInterval,
} from './state.js';

const router = Router();

const { RADARR_HOST, RADARR_API_KEY, SONARR_HOST, SONARR_API_KEY, LIDARR_HOST, LIDARR_API_KEY, SLSKD_API_KEY, SLSKD_HOST, PROWLARR_HOST, PROWLARR_API_KEY } = CONFIG;

// Transient watcher state lingers past pipeline updates so /pending-searches can expose terminal search outcomes.
const pendingSearches = new Map();

const STUCK_THRESHOLDS = {
  searching:   5 * 60 * 1000,
  grabbed:     2 * 60 * 1000,
  downloading: 5 * 60 * 1000,
  importing:   5 * 60 * 1000,
};

const STUCK_REASONS = {
  searching_timeout:    'No releases found. Content may not be available digitally yet, or the quality profile is too restrictive.',
  searching_no_results: 'No releases grabbed. Content may not have a digital release yet. Radarr/Sonarr will retry automatically when indexers find a release.',
  grabbed_timeout:      'Grabbed release not appearing in download client. Check qBittorrent connection and logs.',
  downloading_stalled:  'Download stalled — no active peers. This torrent may have very few seeders.',
  importing_timeout:    'Import taking longer than usual. Check available disk space and file permissions.',
};

async function fetchRejectionSummary(releaseUrl) {
  try {
    const releases = await fetchWithTimeout(releaseUrl, 30000);
    if (!Array.isArray(releases) || releases.length === 0) return null;
    const rejected = releases.filter(r => r.rejected);
    const approved = releases.filter(r => !r.rejected);
    if (approved.length > 0) {
      return `${approved.length} release${approved.length !== 1 ? 's' : ''} found — may be grabbing now, check downloads`;
    }
    const counts = {};
    for (const r of rejected) {
      for (const rej of (r.rejections || [])) {
        const cat = rej.includes('alias') ? 'title alias conflict'
          : rej.includes('seeders') ? 'no seeders'
          : rej.includes('not wanted in profile') ? 'quality profile mismatch'
          : rej.includes('Unknown') ? 'unrecognized release'
          : rej.includes('Wrong season') ? 'wrong season'
          : rej.includes('Existing file') ? 'already at cutoff quality'
          : rej.includes('Episode wasn') ? 'episode not monitored'
          : 'other';
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
    const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v} ${k}`);
    return `${rejected.length} found, all rejected — ${parts.join(', ')}`;
  } catch {
    return null;
  }
}

function addPipelineStep(key, message) {
  const item = getPipelineItem(key);
  if (!item) return;
  if (!item.steps) item.steps = [];
  item.steps.push({ ts: Date.now(), message });
}

export async function watchSonarrSearch(pendingKey, commandId, seriesId, seasonNumber, logId, seriesTitle) {
  const searchStart = Date.now();
  const deadline = searchStart + 4 * 60 * 1000;

  addPipelineStep(pendingKey, 'Sonarr command submitted — polling for completion…');

  let commandCompleted = false;
  let firstPoll = true;
  while (Date.now() < deadline) {
    if (!firstPoll) await new Promise(r => setTimeout(r, 15000));
    firstPoll = false;
    try {
      const cmd = await fetchWithTimeout(`${SONARR_HOST}/api/v3/command/${commandId}?apikey=${SONARR_API_KEY}`, 8000);
      if (cmd.state === 'failed') {
        const msg = cmd.exception || 'Search command failed';
        addLogStep(logId, `Sonarr search failed: ${msg}`, 'error');
        const entry = pendingSearches.get(pendingKey);
        if (entry) Object.assign(entry, { status: 'error', error: msg });
        setPipelineStuck(pendingKey, msg);
        const item = getPipelineItem(pendingKey);
        if (item) item.canRetry = true;
        setTimeout(() => pendingSearches.delete(pendingKey), 30000);
        return;
      }
      if (cmd.state === 'completed') { commandCompleted = true; break; }
    } catch { /* continue polling */ }
  }

  if (!commandCompleted) {
    const timeoutMsg = 'Sonarr search command timed out — indexers may be slow or unavailable';
    addLogStep(logId, timeoutMsg, 'warning');
    addPipelineStep(pendingKey, timeoutMsg);
    const entry = pendingSearches.get(pendingKey);
    if (entry) Object.assign(entry, { status: 'no_results' });
    setPipelineStuck(pendingKey, timeoutMsg);
    const item = getPipelineItem(pendingKey);
    if (item) item.canRetry = true;
    setTimeout(() => pendingSearches.delete(pendingKey), 120000);
    return;
  }

  addPipelineStep(pendingKey, 'Sonarr finished querying indexers — waiting for grab history…');
  let grabs = [];
  const historyDeadline = Date.now() + 30000;
  // Sonarr can finish the search command before the matching grab shows up in history.
  while (Date.now() < historyDeadline && grabs.length === 0) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const histCheck = await fetchWithTimeout(
        `${SONARR_HOST}/api/v3/history?pageSize=50&includeSeries=true&includeEpisode=true&apikey=${SONARR_API_KEY}`,
        8000
      );
      grabs = (histCheck.records || []).filter(h => {
        if (h.eventType !== 'grabbed') return false;
        if (new Date(h.date).getTime() < searchStart) return false;
        if (h.seriesId !== seriesId) return false;
        if (seasonNumber != null && h.episode?.seasonNumber !== seasonNumber) return false;
        return true;
      });
    } catch { /* continue polling */ }
  }

  if (grabs.length === 0) {
    try {
      const history = await fetchWithTimeout(
        `${SONARR_HOST}/api/v3/history?pageSize=50&includeSeries=true&includeEpisode=true&apikey=${SONARR_API_KEY}`,
        8000
      );
      grabs = (history.records || []).filter(h => {
        if (h.eventType !== 'grabbed') return false;
        if (new Date(h.date).getTime() < searchStart) return false;
        if (h.seriesId !== seriesId) return false;
        if (seasonNumber != null && h.episode?.seasonNumber !== seasonNumber) return false;
        return true;
      });
    } catch { /* ignore */ }
  }

  try {
    const entry = pendingSearches.get(pendingKey);
    if (grabs.length > 0) {
      const titles = grabs.map(g => g.sourceTitle || 'release').slice(0, 2).join(', ');
      addLogStep(logId, `Grabbed ${grabs.length} episode(s): ${titles}`, 'success');
      addPipelineStep(pendingKey, `Grabbed ${grabs.length} release(s) — sending to qBittorrent`);
      if (entry) Object.assign(entry, { status: 'grabbed' });
      advancePipeline(pendingKey, 'grabbed');
      setTimeout(() => pendingSearches.delete(pendingKey), 90000);
    } else {
      const releaseUrl = seasonNumber != null
        ? `${SONARR_HOST}/api/v3/release?seriesId=${seriesId}&seasonNumber=${seasonNumber}&apikey=${SONARR_API_KEY}`
        : `${SONARR_HOST}/api/v3/release?seriesId=${seriesId}&apikey=${SONARR_API_KEY}`;
      const rejSummary = await fetchRejectionSummary(releaseUrl);
      const noResultsMsg = rejSummary ? `No grab — ${rejSummary}` : 'No matching releases found — check indexers or episode availability';
      addLogStep(logId, noResultsMsg, rejSummary ? 'warning' : 'warning');
      addPipelineStep(pendingKey, noResultsMsg);
      if (entry) Object.assign(entry, { status: 'no_results' });
      setPipelineStuck(pendingKey, rejSummary || STUCK_REASONS.searching_no_results);
      const item = getPipelineItem(pendingKey);
      if (item) item.canRetry = true;
      setTimeout(() => pendingSearches.delete(pendingKey), 120000);
    }
  } catch (err) {
    console.error('watchSonarrSearch history check failed:', err.message);
    setTimeout(() => pendingSearches.delete(pendingKey), 60000);
  }
}

export async function watchRadarrSearch(pipelineKey, commandId, movieId, logId, movieTitle) {
  const searchStart = Date.now();
  const deadline = searchStart + 4 * 60 * 1000;

  addPipelineStep(pipelineKey, 'Radarr command submitted — polling for completion…');

  let commandCompleted = false;
  let firstPoll = true;
  while (Date.now() < deadline) {
    if (!firstPoll) await new Promise(r => setTimeout(r, 15000));
    firstPoll = false;
    try {
      const cmd = await fetchWithTimeout(`${RADARR_HOST}/api/v3/command/${commandId}?apikey=${RADARR_API_KEY}`, 8000);
      if (cmd.state === 'failed') {
        const msg = cmd.exception || 'Radarr search command failed';
        setPipelineStuck(pipelineKey, msg);
        const item = getPipelineItem(pipelineKey);
        if (item) item.canRetry = true;
        if (logId) addLogStep(logId, `Radarr search failed: ${msg}`, 'error');
        return;
      }
      if (cmd.state === 'completed') { commandCompleted = true; break; }
    } catch { /* continue polling */ }
  }

  if (!commandCompleted) {
    const timeoutMsg = 'Radarr search command timed out — indexers may be slow or unavailable';
    if (logId) addLogStep(logId, timeoutMsg, 'warning');
    addPipelineStep(pipelineKey, timeoutMsg);
    setPipelineStuck(pipelineKey, timeoutMsg);
    const item = getPipelineItem(pipelineKey);
    if (item) item.canRetry = true;
    return;
  }

  addPipelineStep(pipelineKey, 'Radarr finished querying indexers — waiting for grab history…');
  let grabs = [];
  const historyDeadline = Date.now() + 30000;
  // Radarr can finish the search command before the matching grab shows up in history.
  while (Date.now() < historyDeadline && grabs.length === 0) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const histCheck = await fetchWithTimeout(
        `${RADARR_HOST}/api/v3/history?pageSize=50&includeMovie=true&apikey=${RADARR_API_KEY}`,
        8000
      );
      grabs = (histCheck.records || []).filter(h => {
        if (h.eventType !== 'grabbed') return false;
        if (new Date(h.date).getTime() < searchStart) return false;
        if (h.movieId !== movieId) return false;
        return true;
      });
    } catch { /* continue polling */ }
  }

  if (grabs.length === 0) {
    try {
      const history = await fetchWithTimeout(
        `${RADARR_HOST}/api/v3/history?pageSize=50&includeMovie=true&apikey=${RADARR_API_KEY}`,
        8000
      );
      grabs = (history.records || []).filter(h => {
        if (h.eventType !== 'grabbed') return false;
        if (new Date(h.date).getTime() < searchStart) return false;
        if (h.movieId !== movieId) return false;
        return true;
      });
    } catch { /* ignore */ }
  }

  try {
    if (grabs.length > 0) {
      const sourceTitle = grabs[0].sourceTitle || 'release';
      addPipelineStep(pipelineKey, `Grabbed: ${sourceTitle} — sending to qBittorrent`);
      advancePipeline(pipelineKey, 'grabbed');
      if (logId) addLogStep(logId, `Grabbed: ${sourceTitle}`, 'success');
    } else {
      const releaseUrl = `${RADARR_HOST}/api/v3/release?movieId=${movieId}&apikey=${RADARR_API_KEY}`;
      const rejSummary = await fetchRejectionSummary(releaseUrl);
      const noResultsMsg = rejSummary ? `No grab — ${rejSummary}` : 'No matching releases found — check indexers or availability';
      addPipelineStep(pipelineKey, noResultsMsg);
      setPipelineStuck(pipelineKey, rejSummary || STUCK_REASONS.searching_no_results);
      const item = getPipelineItem(pipelineKey);
      if (item) item.canRetry = true;
      if (logId) addLogStep(logId, noResultsMsg, 'warning');
    }
  } catch (err) {
    console.error('watchRadarrSearch history check failed:', err.message);
  }
}

export async function arrGrab({ service, host, apiKey, guid, indexerId, downloadUrl, title }) {
  const endpoint = downloadUrl ? 'release/push' : 'release';
  const body = downloadUrl
    ? { title, downloadUrl, protocol: 'torrent', ...(indexerId ? { indexerId } : {}) }
    : { guid, indexerId };
  console.log(`[grab] ${service} ${endpoint}`, {
    hasGuid: Boolean(guid),
    hasDownloadUrl: Boolean(downloadUrl),
    indexerId: indexerId ?? null,
  });
  const resp = await fetch(`${host}/api/v3/${endpoint}?apikey=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error(`[grab] ${service} ${endpoint} ${resp.status}:`, errBody);
    let msg;
    try { const j = JSON.parse(errBody); msg = (Array.isArray(j) ? j[0]?.errorMessage : j?.message) || errBody; } catch { msg = errBody; }
    throw new Error(msg || `${service} grab failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

function checkPipelineStuck() {
  try {
    const now = Date.now();
    const items = getPipeline();
    for (const item of items) {
      if (item.stage === 'complete' || item.stage === 'failed') continue;
      if (item.stage === 'stuck' && item.stuckAt && (now - item.stuckAt > 30 * 60 * 1000)) {
        removePipelineItem(item.key);
        continue;
      }
      if (item.stage === 'stuck') continue;
      const threshold = STUCK_THRESHOLDS[item.stage];
      if (!threshold) continue;
      const stageStartedAt = item.stageStartedAt || item.stageChangedAt || item.startedAt || item.createdAt || now;
      if (now - stageStartedAt > threshold) {
        const reason = STUCK_REASONS[`${item.stage}_timeout`] || `Taking longer than expected at stage: ${item.stage}`;
        setPipelineStuck(item.key, reason);
        // Leave stuck cards visible for manual retry/debug before aging them out separately.
        const i = getPipelineItem(item.key);
        if (i) { i.canRetry = item.stage === 'searching' || item.stage === 'grabbed'; i.stuckAt = Date.now(); }
        if (item.logId) addLogStep(item.logId, `Stuck at "${item.stage}": ${reason}`, 'warning');
      }
    }
  } catch (e) {
    console.error('[checkPipelineStuck] error:', e.message);
  }
}

registerInterval(setInterval(checkPipelineStuck, TIMING.CHECK_STUCK_INTERVAL_MS || 30000));

const queueAlerts = new Map();

export function restoreQueueAlertsFromActivityLog() {
  queueAlerts.clear();
  for (const entry of getActivityLog()) {
    if (entry?.type !== 'queue' || entry?.status !== 'error') continue;
    const service = entry.details?.service || entry.context?.service;
    const discriminator = entry.details?.downloadId || entry.details?.queueId || null;
    if (!service || !discriminator) continue;
    const key = `${service}-q-${discriminator}`;
    if (!queueAlerts.has(key)) {
      queueAlerts.set(key, { logId: entry.id, status: 'error' });
    }
  }
}

export async function monitorQueues() {
  const tasks = [];

  if (LIDARR_API_KEY) {
    tasks.push((async () => {
      try {
        const data = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/queue?page=1&pageSize=100&includeArtist=true&includeAlbum=true&apikey=${LIDARR_API_KEY}`, 8000);
        const lidarrCounts = new Map();
        for (const r of (data.records || [])) {
          const dlid = r.downloadId || `__id_${r.id}`;
          lidarrCounts.set(dlid, (lidarrCounts.get(dlid) || 0) + 1);
        }
        const seenLidarr = new Set();
        for (const item of (data.records || [])) {
          const dlid = item.downloadId || `__id_${item.id}`;
          if (seenLidarr.has(dlid)) continue;
          seenLidarr.add(dlid);
          const key = `lidarr-q-${dlid}`;
          const artist = item.artist?.artistName || 'Unknown';
          const album = item.album?.title || 'Unknown';
          const trackCount = lidarrCounts.get(dlid) || 1;
          const label = trackCount > 1 ? `${artist} - ${album} (${trackCount} tracks)` : `${artist} - ${album}`;
          const hasError = item.status === 'warning' || item.status === 'error' || item.trackedDownloadStatus === 'warning' || item.trackedDownloadStatus === 'error' || (item.statusMessages?.length > 0);
          const msgs = (item.statusMessages || []).map(m => m.title || m.messages?.join(', ')).filter(Boolean);
          const errorDetail = item.errorMessage || msgs.join('; ') || '';

          if (hasError && !queueAlerts.has(key)) {
            const errorDetails = {
              status: item.status,
              trackedDownloadStatus: item.trackedDownloadStatus,
              trackedDownloadState: item.trackedDownloadState,
              protocol: item.protocol,
              errorMessage: item.errorMessage || null,
              statusMessages: (item.statusMessages || []).map(m => ({
                title: m.title,
                messages: m.messages || [],
              })),
            };
            const logId = logActivity('queue', `${label}: ${errorDetail || 'download issue'}`, errorDetails, 'error', { service: 'lidarr', artistName: artist, title: album });
            queueAlerts.set(key, { logId, status: 'error' });
          } else if (!hasError && queueAlerts.has(key)) {
            const alert = queueAlerts.get(key);
            updateLogEntry(alert.logId, { status: 'success', message: `${label}: resolved` });
            queueAlerts.delete(key);
          }

          if (item.status === 'downloading' && item.trackedDownloadStatus === 'ok') {
            const pKey = `lidarr-dl-${dlid}`;
            if (!queueAlerts.has(pKey)) {
              const protocol = item.protocol === 'torrent' ? 'torrent' : 'Soulseek';
              const logId = logActivity('download', `Downloading ${label} via ${protocol}`, { service: 'lidarr', queueId: item.id, downloadId: item.downloadId, protocol: item.protocol }, 'pending', { service: 'lidarr', artistName: artist, title: album });
              queueAlerts.set(pKey, { logId, status: 'pending' });
            }
          }
        }

        const activeLidarrDlids = new Set((data.records || []).map(r => r.downloadId || `__id_${r.id}`));
        for (const [key, alert] of queueAlerts) {
          if (key.startsWith('lidarr-dl-') && alert.status === 'pending') {
            const trackedDlid = key.replace('lidarr-dl-', '');
            const stillInQueue = activeLidarrDlids.has(trackedDlid);
            if (!stillInQueue) {
              const logEntry = getActivityLog().find(e => e.id === alert.logId);
              updateLogEntry(alert.logId, { status: 'success', message: logEntry?.message?.replace('Downloading', 'Downloaded') || 'Download completed' });
              queueAlerts.delete(key);
            }
          }
        }
      } catch (err) { console.error('Lidarr queue monitor:', err.message); }
    })());
  }

  if (SONARR_API_KEY) {
    tasks.push((async () => {
      try {
        const data = await fetchWithTimeout(`${SONARR_HOST}/api/v3/queue?page=1&pageSize=100&includeSeries=true&includeEpisode=true&apikey=${SONARR_API_KEY}`, 8000);
        const sonarrCounts = new Map();
        for (const r of (data.records || [])) {
          const dlid = r.downloadId || `__id_${r.id}`;
          sonarrCounts.set(dlid, (sonarrCounts.get(dlid) || 0) + 1);
        }
        const seenSonarr = new Set();
        for (const item of (data.records || [])) {
          const dlid = item.downloadId || `__id_${item.id}`;
          const isFirstForDlid = !seenSonarr.has(dlid);
          if (isFirstForDlid) seenSonarr.add(dlid);
          const key = `sonarr-q-${dlid}`;
          const series = item.series?.title || 'Unknown';
          const ep = item.episode ? `S${String(item.episode.seasonNumber).padStart(2,'0')}E${String(item.episode.episodeNumber).padStart(2,'0')}` : '';
          const epCount = sonarrCounts.get(dlid) || 1;
          const label = epCount > 1 ? `${series} (${epCount} episodes)` : `${series} ${ep}`.trim();
          const hasError = item.status === 'warning' || item.status === 'error' || item.trackedDownloadStatus === 'warning' || item.trackedDownloadStatus === 'error' || (item.statusMessages?.length > 0);
          const msgs = (item.statusMessages || []).map(m => m.title || m.messages?.join(', ')).filter(Boolean);
          const errorDetail = item.errorMessage || msgs.join('; ') || '';
          const queueSeriesId = item.seriesId || item.series?.id;
          const pipelineItems = getPipeline();
          const relatedPipelineItems = pipelineItems.filter(
            pItem => pItem.service === 'sonarr' && pItem.seriesId && pItem.seriesId === queueSeriesId,
          );
          const shouldTrackQueueAlert = relatedPipelineItems.length > 0 || queueAlerts.has(key);

          if (isFirstForDlid && hasError && !queueAlerts.has(key) && shouldTrackQueueAlert) {
            const logId = logActivity('queue', `${label}: ${errorDetail || 'download issue'}`, { service: 'sonarr', queueId: item.id, downloadId: item.downloadId, recordCount: epCount }, 'error', { service: 'sonarr', title: series });
            queueAlerts.set(key, { logId, status: 'error' });
          } else if (isFirstForDlid && !hasError && queueAlerts.has(key)) {
            const alert = queueAlerts.get(key);
            updateLogEntry(alert.logId, { status: 'success', message: `${label}: resolved` });
            queueAlerts.delete(key);
          }

          for (const pItem of relatedPipelineItems) {
            if (pItem.stage === 'grabbed' || pItem.stage === 'searching' || pItem.stage === 'stuck') {
              const progress = (item.size > 0 && item.sizeleft != null)
                ? Math.round((1 - item.sizeleft / item.size) * 100) : 0;
              advancePipeline(pItem.key, 'downloading', { queueId: item.id, progress });
            } else if (pItem.stage === 'downloading' && pItem.queueId === item.id) {
              const progress = (item.size > 0 && item.sizeleft != null)
                ? Math.round((1 - item.sizeleft / item.size) * 100) : pItem.progress;
              const updated = getPipelineItem(pItem.key);
              if (updated) updated.progress = progress;
              if (hasError) {
                const statusMsgs = (item.statusMessages || []).flatMap(m => m.messages || [m.title]).filter(Boolean);
                setPipelineStuck(pItem.key, statusMsgs.join(' ') || 'Download issue — check Sonarr for details');
                if (pItem.logId) addLogStep(pItem.logId, `Queue warning: ${statusMsgs.join(' ')}`, 'warning');
              }
            }
          }
        }

        const pipelineItems = getPipeline();
        for (const pItem of pipelineItems) {
          if (pItem.service !== 'sonarr' || pItem.stage !== 'downloading' || !pItem.queueId) continue;
          const stillInQueue = (data.records || []).some(r => r.id === pItem.queueId);
          if (!stillInQueue) {
            // Queue disappearance is the earliest reliable handoff from downloading to import.
            advancePipeline(pItem.key, 'importing');
            if (pItem.logId) addLogStep(pItem.logId, 'Download complete — importing to library', 'success');
            setTimeout(() => completePipeline(pItem.key), 3 * 60 * 1000);
          }
        }
      } catch (err) { console.error('Sonarr queue monitor:', err.message); }
    })());
  }

  if (RADARR_API_KEY) {
    tasks.push((async () => {
      try {
        const data = await fetchWithTimeout(`${RADARR_HOST}/api/v3/queue?page=1&pageSize=100&includeMovie=true&apikey=${RADARR_API_KEY}`, 8000);
        const seenRadarr = new Set();
        for (const item of (data.records || [])) {
          const dlid = item.downloadId || `__id_${item.id}`;
          const isFirstForDlid = !seenRadarr.has(dlid);
          if (isFirstForDlid) seenRadarr.add(dlid);
          const key = `radarr-q-${dlid}`;
          const title = item.movie?.title || 'Unknown';
          const hasError = item.status === 'warning' || item.status === 'error' || item.trackedDownloadStatus === 'warning' || item.trackedDownloadStatus === 'error' || (item.statusMessages?.length > 0);
          const msgs = (item.statusMessages || []).map(m => m.title || m.messages?.join(', ')).filter(Boolean);
          const errorDetail = item.errorMessage || msgs.join('; ') || '';
          const queueMovieId = item.movieId || item.movie?.id;
          const pipelineItems = getPipeline();
          const relatedPipelineItems = pipelineItems.filter(
            pItem => pItem.service === 'radarr' && pItem.movieId && pItem.movieId === queueMovieId,
          );
          const shouldTrackQueueAlert = relatedPipelineItems.length > 0 || queueAlerts.has(key);

          if (isFirstForDlid && hasError && !queueAlerts.has(key) && shouldTrackQueueAlert) {
            const logId = logActivity('queue', `${title}: ${errorDetail || 'download issue'}`, { service: 'radarr', queueId: item.id, downloadId: item.downloadId }, 'error', { service: 'radarr', title });
            queueAlerts.set(key, { logId, status: 'error' });
          } else if (isFirstForDlid && !hasError && queueAlerts.has(key)) {
            const alert = queueAlerts.get(key);
            updateLogEntry(alert.logId, { status: 'success', message: `${title}: resolved` });
            queueAlerts.delete(key);
          }

          for (const pItem of relatedPipelineItems) {
            if (pItem.stage === 'grabbed' || pItem.stage === 'searching' || pItem.stage === 'stuck') {
              const progress = (item.size > 0 && item.sizeleft != null)
                ? Math.round((1 - item.sizeleft / item.size) * 100) : 0;
              advancePipeline(pItem.key, 'downloading', { queueId: item.id, progress });
              if (pItem.logId) addLogStep(pItem.logId, 'Release grabbed — now downloading', 'success');
            } else if (pItem.stage === 'downloading' && pItem.queueId === item.id) {
              const progress = (item.size > 0 && item.sizeleft != null)
                ? Math.round((1 - item.sizeleft / item.size) * 100) : pItem.progress;
              const updated = getPipelineItem(pItem.key);
              if (updated) updated.progress = progress;
              if (hasError) {
                const statusMsgs = (item.statusMessages || []).flatMap(m => m.messages || [m.title]).filter(Boolean);
                setPipelineStuck(pItem.key, statusMsgs.join(' ') || 'Download issue — check Radarr for details');
                if (pItem.logId) addLogStep(pItem.logId, `Queue warning: ${statusMsgs.join(' ')}`, 'warning');
              }
            }
          }
        }

        const pipelineItems = getPipeline();
        for (const pItem of pipelineItems) {
          if (pItem.service !== 'radarr' || pItem.stage !== 'downloading' || !pItem.queueId) continue;
          const stillInQueue = (data.records || []).some(r => r.id === pItem.queueId);
          if (!stillInQueue) {
            advancePipeline(pItem.key, 'importing');
            if (pItem.logId) addLogStep(pItem.logId, 'Download complete — importing to library', 'success');
            setTimeout(() => completePipeline(pItem.key), 3 * 60 * 1000);
          }
        }
      } catch (err) { console.error('Radarr queue monitor:', err.message); }
    })());
  }

  await Promise.allSettled(tasks);
}

registerInterval(setInterval(monitorQueues, TIMING.MONITOR_QUEUES_INTERVAL_MS || 15000));

// ─── Routes ─────────────────────────────────────────────────────────────────

router.get('/pipeline', (req, res) => {
  const items = getPipeline();
  res.json(items.map(item => ({
    key: item.key,
    service: item.service,
    title: item.title,
    subtitle: item.subtitle,
    posterUrl: item.posterUrl,
    stage: item.stage,
    stageStartedAt: item.stageStartedAt || item.stageChangedAt || item.startedAt || item.createdAt,
    startedAt: item.startedAt || item.createdAt,
    stuckReason: item.stuckReason || item.error,
    stuckAt: item.stuckAt,
    canRetry: item.canRetry || false,
    progress: item.progress,
    speed: item.speed,
    eta: item.eta,
    logId: item.logId,
    steps: item.steps || [],
    seriesId: item.seriesId || null,
    movieId: item.movieId || null,
    artistId: item.artistId || null,
    seasonNumbers: item.seasonNumbers || null,
    queueId: item.queueId || null,
    retryId: item.retryId || null,
  })));
});

router.delete('/pipeline/:key', (req, res) => {
  removePipelineItem(req.params.key);
  res.json({ success: true });
});

router.post('/pipeline/:key/retry', async (req, res) => {
  const item = getPipelineItem(req.params.key);
  if (!item) return res.status(404).json({ error: 'Pipeline item not found' });
  try {
    if (item.service === 'sonarr' && item.retryId && SONARR_API_KEY) {
      const cmdBody = item.retrySeasonNumbers?.length
        ? { name: 'SeasonSearch', seriesId: item.retryId, seasonNumber: item.retrySeasonNumbers[0] }
        : { name: 'SeriesSearch', seriesId: item.retryId };
      const cmdResp = await fetch(`${SONARR_HOST}/api/v3/command?apikey=${SONARR_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmdBody),
      });
      if (!cmdResp.ok) throw new Error(`Sonarr command failed: HTTP ${cmdResp.status}`);
      const cmdData = await cmdResp.json();
      advancePipeline(item.key, 'searching');
      if (item.logId) addLogStep(item.logId, 'Retrying search…', 'info');
      watchSonarrSearch(item.key, cmdData.id, item.retryId, item.retrySeasonNumbers?.[0] ?? null, item.logId, item.title)
        .catch(e => console.error('watchSonarrSearch retry:', e.message));
    } else if (item.service === 'radarr' && item.retryId && RADARR_API_KEY) {
      const cmdResp = await fetch(`${RADARR_HOST}/api/v3/command?apikey=${RADARR_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'MoviesSearch', movieIds: [item.retryId] }),
      });
      if (!cmdResp.ok) throw new Error(`Radarr command failed: HTTP ${cmdResp.status}`);
      const cmdData = await cmdResp.json();
      advancePipeline(item.key, 'searching');
      if (item.logId) addLogStep(item.logId, 'Retrying search…', 'info');
      watchRadarrSearch(item.key, cmdData.id, item.retryId, item.logId, item.title)
        .catch(e => console.error('watchRadarrSearch retry:', e.message));
    } else {
      return res.status(400).json({ error: 'Cannot retry this item type' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pipeline/:key/cancel', async (req, res) => {
  const item = getPipelineItem(req.params.key);
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    if (item.torrentHash) {
      try {
        const { qbHost, cookie } = await qbittorrentLogin();
        await fetch(`${qbHost}/api/v2/torrents/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
          body: `hashes=${item.torrentHash}&deleteFiles=true`,
        });
      } catch {}
    }
    if (item.queueId) {
      try {
        if (item.service === 'sonarr' && SONARR_API_KEY) {
          await fetch(`${SONARR_HOST}/api/v3/queue/${item.queueId}?removeFromClient=true&blocklist=false&apikey=${SONARR_API_KEY}`, { method: 'DELETE' });
        } else if (item.service === 'radarr' && RADARR_API_KEY) {
          await fetch(`${RADARR_HOST}/api/v3/queue/${item.queueId}?removeFromClient=true&blocklist=false&apikey=${RADARR_API_KEY}`, { method: 'DELETE' });
        }
      } catch {}
    }
    removePipelineItem(req.params.key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pipeline/:key/monitor', (req, res) => {
  const item = getPipelineItem(req.params.key);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.logId) addLogStep(item.logId, 'Set to monitor — will grab automatically when released', 'info');
  removePipelineItem(req.params.key);
  res.json({ success: true });
});

router.post('/command/search', async (req, res) => {
  const { service, id, seasonNumbers, albumIds } = req.body;
  if (!service) return res.status(400).json({ error: 'Missing service' });
  if (!id && service !== 'lidarr') return res.status(400).json({ error: 'Missing id' });

  try {
    if (service === 'sonarr' && SONARR_API_KEY) {
      const seriesResp = await fetch(`${SONARR_HOST}/api/v3/series/${id}?apikey=${SONARR_API_KEY}`);
      if (!seriesResp.ok) throw new Error(`Failed to fetch series from Sonarr: HTTP ${seriesResp.status}`);
      const seriesData = await seriesResp.json();
      const seriesTitle = seriesData.title || 'Unknown';
      const seriesPosterUrl = pickArrImageUrl(seriesData.images || [], 'poster', 'sonarr');

      let monitoringChanged = false;
      if (!seriesData.monitored) { seriesData.monitored = true; monitoringChanged = true; }
      for (const season of (seriesData.seasons || [])) {
        if (season.seasonNumber === 0) continue;
        const targeted = seasonNumbers?.length ? seasonNumbers.includes(season.seasonNumber) : true;
        if (targeted && !season.monitored) { season.monitored = true; monitoringChanged = true; }
      }
      if (monitoringChanged) {
        const putResp = await fetch(`${SONARR_HOST}/api/v3/series/${id}?apikey=${SONARR_API_KEY}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(seriesData),
        });
        if (!putResp.ok) console.error(`Failed to enable monitoring for series ${id}: HTTP ${putResp.status}`);
      }

      if (seasonNumbers?.length) {
        for (const sn of seasonNumbers) {
          const snLabel = seasonNumbers.length > 1 ? `${seriesTitle} S${sn}` : `${seriesTitle} Season ${sn}`;
          const logId = logActivity('download', `Searching: ${snLabel}`, { seriesId: id, season: sn }, 'pending', { service: 'sonarr', seriesId: id, season: sn, title: seriesTitle });
          if (monitoringChanged) addLogStep(logId, `Auto-enabled monitoring for ${snLabel}`, 'info');
          const cmdResp = await fetch(`${SONARR_HOST}/api/v3/command?apikey=${SONARR_API_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'SeasonSearch', seriesId: id, seasonNumber: sn }),
          });
          if (!cmdResp.ok) throw new Error(`Sonarr command failed: HTTP ${cmdResp.status}`);
          const cmdData = await cmdResp.json();
          updateLogEntry(logId, { status: 'info', message: `Sonarr searching: ${snLabel}` });
          const pendingKey = `sonarr-${id}-${sn}-${Date.now()}`;
          pendingSearches.set(pendingKey, { key: pendingKey, service: 'sonarr', title: seriesTitle, subtitle: `Season ${sn}`, seasons: [sn], logId, seriesId: id, posterUrl: seriesPosterUrl, startedAt: Date.now(), status: 'searching' });
          addPipelineItem(pendingKey, { service: 'sonarr', title: seriesTitle, subtitle: `Season ${sn}`, posterUrl: seriesPosterUrl, logId, seriesId: id, seasonNumbers: [sn], retryId: id });
          advancePipeline(pendingKey, 'searching');
          watchSonarrSearch(pendingKey, cmdData.id, id, sn, logId, seriesTitle).catch(e => console.error('watchSonarrSearch:', e.message));
        }
      } else {
        const logId = logActivity('download', `Searching: ${seriesTitle}`, { seriesId: id }, 'pending', { service: 'sonarr', seriesId: id, title: seriesTitle });
        if (monitoringChanged) addLogStep(logId, `Auto-enabled monitoring for ${seriesTitle}`, 'info');
        const cmdResp = await fetch(`${SONARR_HOST}/api/v3/command?apikey=${SONARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'SeriesSearch', seriesId: id }),
        });
        if (!cmdResp.ok) throw new Error(`Sonarr command failed: HTTP ${cmdResp.status}`);
        const cmdData = await cmdResp.json();
        updateLogEntry(logId, { status: 'info', message: `Sonarr searching: ${seriesTitle}` });
        const pendingKey = `sonarr-${id}-all-${Date.now()}`;
        pendingSearches.set(pendingKey, { key: pendingKey, service: 'sonarr', title: seriesTitle, subtitle: 'All seasons', seasons: null, logId, seriesId: id, posterUrl: seriesPosterUrl, startedAt: Date.now(), status: 'searching' });
        addPipelineItem(pendingKey, { service: 'sonarr', title: seriesTitle, subtitle: 'All seasons', posterUrl: seriesPosterUrl, logId, seriesId: id, seasonNumbers: null, retryId: id });
        advancePipeline(pendingKey, 'searching');
        watchSonarrSearch(pendingKey, cmdData.id, id, null, logId, seriesTitle).catch(e => console.error('watchSonarrSearch:', e.message));
      }
      res.json({ success: true });

    } else if (service === 'radarr' && RADARR_API_KEY) {
      let movieTitle = 'Unknown';
      let moviePosterUrl = null;
      try {
        const movieResp = await fetch(`${RADARR_HOST}/api/v3/movie/${id}?apikey=${RADARR_API_KEY}`);
        if (movieResp.ok) {
          const movieData = await movieResp.json();
          movieTitle = movieData.title || 'Unknown';
          moviePosterUrl = pickArrImageUrl(movieData.images || [], 'poster', 'radarr');
        }
      } catch {}
      const logId = logActivity('download', `Searching for "${movieTitle}"`, { movieId: id }, 'pending', { service: 'radarr', title: movieTitle, movieId: id });
      const pipelineKey = `radarr-${id}-${Date.now()}`;
      addPipelineItem(pipelineKey, { service: 'radarr', title: movieTitle, subtitle: 'Movie', posterUrl: moviePosterUrl, logId, movieId: id, retryId: id });
      advancePipeline(pipelineKey, 'searching');
      const resp = await fetch(`${RADARR_HOST}/api/v3/command?apikey=${RADARR_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'MoviesSearch', movieIds: [id] }),
      });
      if (!resp.ok) throw new Error(`Radarr command failed: HTTP ${resp.status}`);
      const cmdData = await resp.json();
      updateLogEntry(logId, { status: 'info', message: `Radarr searching for "${movieTitle}"` });
      pendingSearches.set(pipelineKey, { key: pipelineKey, title: movieTitle, service: 'radarr', type: 'movie', startedAt: Date.now(), status: 'searching' });
      watchRadarrSearch(pipelineKey, cmdData.id, id, logId, movieTitle).catch(e => console.error('watchRadarrSearch:', e.message));
      res.json({ success: true });

    } else if (service === 'lidarr' && LIDARR_API_KEY) {
      if (albumIds?.length) {
        let albumNames = [];
        try {
          const albumDetails = await Promise.all(albumIds.map(aid => fetchWithTimeout(`${LIDARR_HOST}/api/v1/album/${aid}?apikey=${LIDARR_API_KEY}`)));
          albumNames = albumDetails.map(a => a.title || 'Unknown');
        } catch {}
        const logId = logActivity('download', `Searching Lidarr for ${albumIds.length} album(s): ${albumNames.join(', ') || albumIds.join(', ')}`, { albumIds, albumNames }, 'pending', { service: 'lidarr', albumNames, albumIds });
        const resp = await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'AlbumSearch', albumIds }),
        });
        if (!resp.ok) throw new Error(`Lidarr command failed: HTTP ${resp.status}`);
        updateLogEntry(logId, { status: 'success', message: `Lidarr searching for ${albumIds.length} album(s): ${albumNames.join(', ') || 'unknown'}` });
      } else {
        const logId = logActivity('download', 'Searching Lidarr for artist', { artistId: id }, 'pending');
        const resp = await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'ArtistSearch', artistId: id }),
        });
        if (!resp.ok) throw new Error(`Lidarr command failed: HTTP ${resp.status}`);
        updateLogEntry(logId, { status: 'success', message: 'Lidarr artist search triggered' });
      }
      res.json({ success: true });

    } else {
      return res.status(400).json({ error: 'Unknown service or not configured' });
    }
  } catch (err) {
    logActivity('error', `Search command failed: ${err.message}`, { service, id }, 'error');
    console.error('Command/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/grab', async (req, res) => {
  const { service, guid, indexerId, pipelineKey, downloadUrl, title } = req.body;
  if (!guid && !downloadUrl) return res.status(400).json({ error: 'Missing guid or downloadUrl' });
  if (downloadUrl && !title) return res.status(400).json({ error: 'Missing title for downloadUrl grab' });
  const cfg = service === 'radarr' && RADARR_API_KEY
    ? { service: 'Radarr', host: RADARR_HOST, apiKey: RADARR_API_KEY }
    : service === 'sonarr' && SONARR_API_KEY
    ? { service: 'Sonarr', host: SONARR_HOST, apiKey: SONARR_API_KEY }
    : null;
  if (!cfg) return res.status(400).json({ error: 'Unknown service' });
  try {
    await arrGrab({ ...cfg, guid, indexerId, downloadUrl, title });
    if (pipelineKey) advancePipeline(pipelineKey, 'grabbed');
    res.json({ success: true });
  } catch (err) {
    console.error('Grab error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/arr-queue', async (req, res) => {
  const results = [];
  const tasks = [];
  if (SONARR_API_KEY) {
    tasks.push((async () => {
      try {
        const data = await fetchWithTimeout(`${SONARR_HOST}/api/v3/queue?page=1&pageSize=100&includeSeries=true&includeEpisode=true&apikey=${SONARR_API_KEY}`, 8000);
        for (const item of (data.records || [])) {
          const ep = item.episode ? `S${String(item.episode.seasonNumber).padStart(2,'0')}E${String(item.episode.episodeNumber).padStart(2,'0')}` : null;
          const msgs = (item.statusMessages || []).map(m => m.title || (m.messages || []).join(', ')).filter(Boolean);
          results.push({
            id: `sonarr-${item.id}`, service: 'sonarr',
            seriesId: item.seriesId || item.series?.id || null,
            title: item.series?.title || 'Unknown', episode: ep,
            seasonNumber: item.episode?.seasonNumber,
            status: item.status, trackedStatus: item.trackedDownloadStatus,
            progress: item.size > 0 ? Math.round((1 - item.sizeleft / item.size) * 100) : 0,
            size: item.size, sizeleft: item.sizeleft,
            errorMessage: item.errorMessage || msgs.join('; ') || null,
            addedAt: item.added,
            posterUrl: pickArrImageUrl(item.series?.images || [], 'poster', 'sonarr'),
          });
        }
      } catch (err) { console.error('arr-queue sonarr:', err.message); }
    })());
  }
  if (RADARR_API_KEY) {
    tasks.push((async () => {
      try {
        const data = await fetchWithTimeout(`${RADARR_HOST}/api/v3/queue?page=1&pageSize=100&includeMovie=true&apikey=${RADARR_API_KEY}`, 8000);
        for (const item of (data.records || [])) {
          const msgs = (item.statusMessages || []).map(m => m.title || (m.messages || []).join(', ')).filter(Boolean);
          results.push({
            id: `radarr-${item.id}`, service: 'radarr',
            movieId: item.movieId || item.movie?.id || null,
            title: item.movie?.title || 'Unknown', episode: null, seasonNumber: null,
            status: item.status, trackedStatus: item.trackedDownloadStatus,
            progress: item.size > 0 ? Math.round((1 - item.sizeleft / item.size) * 100) : 0,
            size: item.size, sizeleft: item.sizeleft,
            errorMessage: item.errorMessage || msgs.join('; ') || null,
            addedAt: item.added,
            posterUrl: pickArrImageUrl(item.movie?.images || [], 'poster', 'radarr'),
          });
        }
      } catch (err) { console.error('arr-queue radarr:', err.message); }
    })());
  }
  await Promise.allSettled(tasks);
  res.json(results);
});

router.get('/pending-searches', (req, res) => {
  res.json([...pendingSearches.values()].map(s => ({
    key: s.key, service: s.service, title: s.title, subtitle: s.subtitle,
    seasons: s.seasons, startedAt: s.startedAt, status: s.status,
    posterUrl: s.posterUrl, error: s.error || null,
  })));
});

export default router;
