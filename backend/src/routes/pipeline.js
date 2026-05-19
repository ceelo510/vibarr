import { Router } from 'express';
import { CONFIG, TIMING } from '../config.js';
import { fetchWithTimeout, pickArrImageUrl, qbittorrentLogin } from '../utils.js';
import { scheduleLibraryRefresh } from '../libraryRefresh.js';
import {
  getPipeline, getPipelineItem, addPipelineItem, advancePipeline,
  completePipeline, removePipelineItem, setPipelineStuck,
  addLogStep, updateLogEntry, logActivity,
  getActivityLog, logServerEvent, registerInterval, summarizeError,
} from '../state.js';

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

const ARR_COMMAND_POLL_INTERVAL_MS = 5000;
const ARR_COMMAND_STATUS_STEP_INTERVAL_MS = 20000;
const DIRECT_RELEASE_TIMEOUT_MS = 45000;
const LIBRARY_REFRESH_DELAY_MS = 15000;

function releaseQualityName(release) {
  return release?.quality?.quality?.name || release?.quality?.name || release?.qualityVersion || 'Unknown';
}

function releaseShortTitle(release, max = 96) {
  const title = release?.title || release?.sourceTitle || 'release';
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function categorizeRejection(reason = '') {
  const lower = String(reason).toLowerCase();
  if (lower.includes('alias')) return 'title alias conflict';
  if (lower.includes('seeders')) return 'no seeders';
  if (lower.includes('not wanted in profile') || lower.includes('quality')) return 'quality profile mismatch';
  if (lower.includes('unknown')) return 'unrecognized release';
  if (lower.includes('wrong season')) return 'wrong season';
  if (lower.includes('existing file')) return 'already at cutoff quality';
  if (lower.includes('episode wasn')) return 'episode not monitored';
  return 'other';
}

function summarizeReleaseRejections(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  const approved = releases.filter(r => !r.rejected);
  if (approved.length > 0) {
    return `${approved.length} release${approved.length !== 1 ? 's' : ''} approved — may be grabbing now, check downloads`;
  }

  const counts = {};
  for (const r of releases) {
    const reasons = r.rejections?.length ? r.rejections : ['other'];
    for (const reason of reasons) {
      const cat = categorizeRejection(reason);
      counts[cat] = (counts[cat] || 0) + 1;
    }
  }

  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${v} ${k}`);
  const topSeeded = releases
    .slice()
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))[0];
  const topReasons = (topSeeded?.rejections || []).slice(0, 2).join('; ');
  const topBits = topSeeded
    ? [`top seeded: ${releaseShortTitle(topSeeded)}`, `${topSeeded.seeders || 0} seeders`, releaseQualityName(topSeeded), topReasons].filter(Boolean)
    : [];

  return `${releases.length} found, all rejected — ${parts.join(', ')}${topBits.length ? `. ${topBits.join(' — ')}` : ''}`;
}

async function fetchRejectionSummary(releaseUrl) {
  try {
    const releases = await fetchWithTimeout(releaseUrl, 30000);
    return summarizeReleaseRejections(releases);
  } catch {
    return null;
  }
}

function addPipelineStep(key, message) {
  const item = getPipelineItem(key);
  if (!item) return;
  if (!item.steps) item.steps = [];
  const now = Date.now();
  item.statusDetail = message;
  item.statusUpdatedAt = now;
  const latest = item.steps[item.steps.length - 1];
  if (latest?.message === message) {
    latest.ts = now;
    return;
  }
  item.steps.push({ ts: now, message });
  if (item.steps.length > 80) item.steps.shift();
}

function markPipelineNoResults(key, message, logId, retryable = true) {
  const entry = pendingSearches.get(key);
  if (entry) Object.assign(entry, { status: 'no_results', error: message });
  addPipelineStep(key, message);
  setPipelineStuck(key, message);
  const item = getPipelineItem(key);
  if (item) {
    item.canRetry = retryable;
    item.stuckAt = Date.now();
  }
  if (logId) addLogStep(logId, message, 'warning');
}

function getArrCommandState(cmd) {
  const raw = String(cmd?.state || cmd?.status || '').toLowerCase();
  if (raw === 'completed' || raw === 'complete') return 'completed';
  if (raw === 'failed' || raw === 'failure' || raw === 'error') return 'failed';
  return raw || 'running';
}

function describeArrCommand(serviceName, cmd) {
  const commandName = cmd?.name || cmd?.commandName || `${serviceName} command`;
  const state = getArrCommandState(cmd);
  const message = cmd?.message || cmd?.statusMessage || cmd?.body?.completionMessage || state;
  return `${serviceName} ${commandName}: ${message}`;
}

function maybeAddCommandProgress(key, serviceName, cmd, tracker) {
  const now = Date.now();
  const detail = describeArrCommand(serviceName, cmd);
  if (detail !== tracker.lastDetail || now - tracker.lastAt >= ARR_COMMAND_STATUS_STEP_INTERVAL_MS) {
    addPipelineStep(key, detail);
    tracker.lastDetail = detail;
    tracker.lastAt = now;
  }
}

function selectApprovedRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return releases
    .filter(release => !release.rejected && (release.seeders == null || release.seeders > 0))
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0) || (b.size || 0) - (a.size || 0))[0] || null;
}

function safeErrorMessage(error) {
  return summarizeError(error).message.replace(/apikey=[^&\s]+/gi, 'apikey=[redacted]');
}

function readPipelineContext(key, overrides = {}) {
  const item = getPipelineItem(key);
  return {
    pipelineKey: key,
    service: overrides.service || item?.service || null,
    title: overrides.title || item?.title || null,
    stage: overrides.stage || item?.stage || null,
    logId: overrides.logId || item?.logId || null,
    queueId: overrides.queueId || item?.queueId || null,
    retryId: overrides.retryId || item?.retryId || null,
    ...overrides,
  };
}

function markPipelineFailure(key, {
  event,
  message,
  error,
  logId,
  pendingStatus = 'error',
  retryable = true,
  context = {},
}) {
  const effectiveMessage = message || summarizeError(error).message;
  const entry = pendingSearches.get(key);
  if (entry) Object.assign(entry, { status: pendingStatus, error: effectiveMessage });
  setPipelineStuck(key, effectiveMessage);
  const item = getPipelineItem(key);
  if (item) {
    item.canRetry = retryable;
    item.stuckAt = Date.now();
  }
  addPipelineStep(key, effectiveMessage);
  const targetLogId = logId || item?.logId;
  if (targetLogId) addLogStep(targetLogId, effectiveMessage, 'error');
  logServerEvent('error', event, {
    ...readPipelineContext(key, { ...context, logId: targetLogId }),
    error: summarizeError(error),
  });
}

function handleWatcherCrash(key, watcher, error, context = {}) {
  markPipelineFailure(key, {
    event: 'pipeline.watcher.unhandled_error',
    message: `${watcher} watcher crashed: ${summarizeError(error).message}`,
    error,
    context: { watcher, ...context },
  });
  setTimeout(() => pendingSearches.delete(key), 60000);
}

async function readUpstreamErrorMessage(resp, fallback) {
  const text = await resp.text().catch(() => '');
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    const message = Array.isArray(parsed)
      ? parsed[0]?.errorMessage || parsed[0]?.message
      : parsed?.message || parsed?.errorMessage;
    if (message) return summarizeError(new Error(message)).message;
  } catch {
    // Fall through to the raw text summary.
  }
  return summarizeError(new Error(text)).message || fallback;
}

function hasEpisodeAired(episode, now = Date.now()) {
  const airValue = episode?.airDateUtc || episode?.airDate;
  if (!airValue) return false;
  const airTime = Date.parse(airValue);
  return Number.isFinite(airTime) && airTime <= now;
}

export async function prepareSonarrSearch(seriesId, seasonNumbers = null) {
  const normalizedSeasonNumbers = Array.isArray(seasonNumbers) && seasonNumbers.length > 0
    ? [...new Set(seasonNumbers.map(Number).filter(Number.isFinite))]
    : null;
  const seasonSet = normalizedSeasonNumbers ? new Set(normalizedSeasonNumbers) : null;

  const seriesResp = await fetch(`${SONARR_HOST}/api/v3/series/${seriesId}?apikey=${SONARR_API_KEY}`);
  if (!seriesResp.ok) {
    throw new Error(await readUpstreamErrorMessage(seriesResp, `Failed to fetch series from Sonarr: HTTP ${seriesResp.status}`));
  }
  const seriesData = await seriesResp.json();

  let seriesMonitoringChanged = false;
  if (!seriesData.monitored) {
    seriesData.monitored = true;
    seriesMonitoringChanged = true;
  }
  for (const season of (seriesData.seasons || [])) {
    if (season.seasonNumber === 0) continue;
    const targeted = seasonSet ? seasonSet.has(season.seasonNumber) : true;
    if (targeted && !season.monitored) {
      season.monitored = true;
      seriesMonitoringChanged = true;
    }
  }
  if (seriesMonitoringChanged) {
    const putResp = await fetch(`${SONARR_HOST}/api/v3/series/${seriesId}?apikey=${SONARR_API_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(seriesData),
    });
    if (!putResp.ok) {
      throw new Error(await readUpstreamErrorMessage(putResp, `Failed to update Sonarr monitoring: HTTP ${putResp.status}`));
    }
  }

  const allEpisodes = await fetchWithTimeout(`${SONARR_HOST}/api/v3/episode?seriesId=${seriesId}&apikey=${SONARR_API_KEY}`, 15000);
  const targetEpisodes = (Array.isArray(allEpisodes) ? allEpisodes : []).filter((episode) => (
    episode?.seasonNumber > 0 && (!seasonSet || seasonSet.has(episode.seasonNumber))
  ));
  const episodeIdsToMonitor = targetEpisodes
    .filter((episode) => !episode.monitored)
    .map((episode) => episode.id)
    .filter(Number.isFinite);

  if (episodeIdsToMonitor.length > 0) {
    const monitorResp = await fetch(`${SONARR_HOST}/api/v3/episode/monitor?apikey=${SONARR_API_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIds: episodeIdsToMonitor, monitored: true }),
    });
    if (!monitorResp.ok) {
      throw new Error(await readUpstreamErrorMessage(monitorResp, `Failed to update Sonarr episode monitoring: HTTP ${monitorResp.status}`));
    }
  }

  const episodesBySeason = new Map();
  for (const episode of targetEpisodes) {
    const effectiveEpisode = episodeIdsToMonitor.includes(episode.id)
      ? { ...episode, monitored: true }
      : episode;
    const seasonBucket = episodesBySeason.get(effectiveEpisode.seasonNumber) || [];
    seasonBucket.push(effectiveEpisode);
    episodesBySeason.set(effectiveEpisode.seasonNumber, seasonBucket);
  }

  const continuingSeries = seriesData.status === 'continuing' || seriesData.ended === false;
  const requestedSeasons = normalizedSeasonNumbers || [...episodesBySeason.keys()].sort((a, b) => a - b);
  const seasonSearches = requestedSeasons.map((seasonNumber) => {
    const seasonEpisodes = episodesBySeason.get(seasonNumber) || [];
    const missingReleasedEpisodeIds = seasonEpisodes
      .filter((episode) => episode.monitored && !episode.hasFile && hasEpisodeAired(episode))
      .map((episode) => episode.id)
      .filter(Number.isFinite);
    const useEpisodeSearch = continuingSeries && missingReleasedEpisodeIds.length > 0;
    return {
      seasonNumber,
      mode: useEpisodeSearch ? 'episode' : 'season',
      missingReleasedEpisodeIds,
      cmdBody: useEpisodeSearch
        ? { name: 'EpisodeSearch', episodeIds: missingReleasedEpisodeIds }
        : { name: 'SeasonSearch', seriesId, seasonNumber },
    };
  });

  return {
    seriesData,
    seriesMonitoringChanged,
    episodeMonitoringChanged: episodeIdsToMonitor.length > 0,
    seasonSearches,
  };
}

export async function watchSonarrSearch(pendingKey, commandId, seriesId, seasonNumber, logId, seriesTitle) {
  const searchStart = Date.now();
  const deadline = searchStart + 4 * 60 * 1000;

  addPipelineStep(pendingKey, 'Sonarr command submitted — polling for completion…');

  let commandCompleted = false;
  let firstPoll = true;
  const progressTracker = { lastDetail: '', lastAt: 0 };
  while (Date.now() < deadline) {
    if (!firstPoll) await new Promise(r => setTimeout(r, ARR_COMMAND_POLL_INTERVAL_MS));
    firstPoll = false;
    try {
      const cmd = await fetchWithTimeout(`${SONARR_HOST}/api/v3/command/${commandId}?apikey=${SONARR_API_KEY}`, 8000);
      maybeAddCommandProgress(pendingKey, 'Sonarr', cmd, progressTracker);
      const cmdState = getArrCommandState(cmd);
      if (cmdState === 'failed') {
        const msg = cmd.exception || cmd.message || 'Search command failed';
        addLogStep(logId, `Sonarr search failed: ${msg}`, 'error');
        const entry = pendingSearches.get(pendingKey);
        if (entry) Object.assign(entry, { status: 'error', error: msg });
        setPipelineStuck(pendingKey, msg);
        const item = getPipelineItem(pendingKey);
        if (item) item.canRetry = true;
        setTimeout(() => pendingSearches.delete(pendingKey), 30000);
        return;
      }
      if (cmdState === 'completed') { commandCompleted = true; break; }
    } catch { /* continue polling */ }
  }

  if (!commandCompleted) {
    const timeoutMsg = 'Sonarr search command timed out — indexers may be slow or unavailable';
    addLogStep(logId, timeoutMsg, 'warning');
    markPipelineNoResults(pendingKey, timeoutMsg, null);
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
      markPipelineNoResults(pendingKey, noResultsMsg, logId);
      setTimeout(() => pendingSearches.delete(pendingKey), 120000);
    }
  } catch (err) {
    markPipelineFailure(pendingKey, {
      event: 'pipeline.search.transition_failed',
      message: 'Sonarr search finished, but grab history could not be confirmed',
      error: err,
      logId,
      context: {
        service: 'sonarr',
        title: seriesTitle,
        commandId,
        seriesId,
        seasonNumber,
        phase: 'history_confirmation',
      },
    });
    setTimeout(() => pendingSearches.delete(pendingKey), 120000);
  }
}

export async function watchRadarrSearch(pipelineKey, commandId, movieId, logId, movieTitle) {
  const searchStart = Date.now();
  const deadline = searchStart + 4 * 60 * 1000;

  addPipelineStep(pipelineKey, 'Radarr command submitted — polling for completion…');

  let commandCompleted = false;
  let firstPoll = true;
  const progressTracker = { lastDetail: '', lastAt: 0 };
  while (Date.now() < deadline) {
    if (!firstPoll) await new Promise(r => setTimeout(r, ARR_COMMAND_POLL_INTERVAL_MS));
    firstPoll = false;
    try {
      const cmd = await fetchWithTimeout(`${RADARR_HOST}/api/v3/command/${commandId}?apikey=${RADARR_API_KEY}`, 8000);
      maybeAddCommandProgress(pipelineKey, 'Radarr', cmd, progressTracker);
      const cmdState = getArrCommandState(cmd);
      if (cmdState === 'failed') {
        const msg = cmd.exception || cmd.message || 'Radarr search command failed';
        const entry = pendingSearches.get(pipelineKey);
        if (entry) Object.assign(entry, { status: 'error', error: msg });
        setPipelineStuck(pipelineKey, msg);
        const item = getPipelineItem(pipelineKey);
        if (item) item.canRetry = true;
        if (logId) addLogStep(logId, `Radarr search failed: ${msg}`, 'error');
        setTimeout(() => pendingSearches.delete(pipelineKey), 30000);
        return;
      }
      if (cmdState === 'completed') { commandCompleted = true; break; }
    } catch { /* continue polling */ }
  }

  if (!commandCompleted) {
    const timeoutMsg = 'Radarr search command timed out — indexers may be slow or unavailable';
    if (logId) addLogStep(logId, timeoutMsg, 'warning');
    markPipelineNoResults(pipelineKey, timeoutMsg, null);
    setTimeout(() => pendingSearches.delete(pipelineKey), 120000);
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
    const entry = pendingSearches.get(pipelineKey);
    if (grabs.length > 0) {
      const sourceTitle = grabs[0].sourceTitle || 'release';
      addPipelineStep(pipelineKey, `Grabbed: ${sourceTitle} — sending to qBittorrent`);
      if (entry) Object.assign(entry, { status: 'grabbed' });
      advancePipeline(pipelineKey, 'grabbed');
      if (logId) addLogStep(logId, `Grabbed: ${sourceTitle}`, 'success');
      setTimeout(() => pendingSearches.delete(pipelineKey), 90000);
    } else {
      const releaseUrl = `${RADARR_HOST}/api/v3/release?movieId=${movieId}&apikey=${RADARR_API_KEY}`;
      const rejSummary = await fetchRejectionSummary(releaseUrl);
      const noResultsMsg = rejSummary ? `No grab — ${rejSummary}` : 'No matching releases found — check indexers or availability';
      markPipelineNoResults(pipelineKey, noResultsMsg, logId);
      setTimeout(() => pendingSearches.delete(pipelineKey), 120000);
    }
  } catch (err) {
    markPipelineFailure(pipelineKey, {
      event: 'pipeline.search.transition_failed',
      message: 'Radarr search finished, but grab history could not be confirmed',
      error: err,
      logId,
      context: {
        service: 'radarr',
        title: movieTitle,
        commandId,
        movieId,
        phase: 'history_confirmation',
      },
    });
    setTimeout(() => pendingSearches.delete(pipelineKey), 120000);
  }
}

export async function arrGrab({ service, host, apiKey, guid, indexerId, downloadUrl, title }) {
  const endpoint = downloadUrl ? 'release/push' : 'release';
  const body = downloadUrl
    ? { title, downloadUrl, protocol: 'torrent', ...(indexerId ? { indexerId } : {}) }
    : { guid, indexerId };
  const resp = await fetch(`${host}/api/v3/${endpoint}?apikey=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const msg = await readUpstreamErrorMessage(resp, `${service} grab failed: HTTP ${resp.status}`);
    logServerEvent('error', 'pipeline.grab.request_failed', {
      service: service.toLowerCase(),
      endpoint,
      status: resp.status,
      title: title || null,
      hasDownloadUrl: Boolean(downloadUrl),
      indexerId: indexerId || null,
      error: summarizeError(new Error(msg)),
    });
    throw new Error(msg || `${service} grab failed: HTTP ${resp.status}`);
  }
  logServerEvent('info', 'pipeline.grab.requested', {
    service: service.toLowerCase(),
    endpoint,
    title: title || null,
    hasDownloadUrl: Boolean(downloadUrl),
    indexerId: indexerId || null,
  });
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
    logServerEvent('error', 'pipeline.monitor.stuck_check_failed', {
      error: summarizeError(e),
    });
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
      } catch (err) {
        logServerEvent('error', 'pipeline.queue_monitor.failed', {
          service: 'lidarr',
          error: summarizeError(err),
        });
      }
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

          if (isFirstForDlid && hasError && !queueAlerts.has(key)) {
            const logId = logActivity('queue', `${label}: ${errorDetail || 'download issue'}`, { service: 'sonarr', queueId: item.id, downloadId: item.downloadId, recordCount: epCount }, 'error', { service: 'sonarr', title: series });
            queueAlerts.set(key, { logId, status: 'error' });
          } else if (isFirstForDlid && !hasError && queueAlerts.has(key)) {
            const alert = queueAlerts.get(key);
            updateLogEntry(alert.logId, { status: 'success', message: `${label}: resolved` });
            queueAlerts.delete(key);
          }

          const queueSeriesId = item.seriesId || item.series?.id;
          const pipelineItems = getPipeline();
          for (const pItem of pipelineItems) {
            if (pItem.service !== 'sonarr' || !pItem.seriesId || pItem.seriesId !== queueSeriesId) continue;
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
            scheduleLibraryRefresh(pItem.service + ' queue cleared for ' + (pItem.title || pItem.key), LIBRARY_REFRESH_DELAY_MS);
            setTimeout(() => {
              completePipeline(pItem.key);
              scheduleLibraryRefresh(pItem.service + ' pipeline completed for ' + (pItem.title || pItem.key), 0);
            }, 3 * 60 * 1000);
          }
        }
      } catch (err) {
        logServerEvent('error', 'pipeline.queue_monitor.failed', {
          service: 'sonarr',
          error: summarizeError(err),
        });
      }
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

          if (isFirstForDlid && hasError && !queueAlerts.has(key)) {
            const logId = logActivity('queue', `${title}: ${errorDetail || 'download issue'}`, { service: 'radarr', queueId: item.id, downloadId: item.downloadId }, 'error', { service: 'radarr', title });
            queueAlerts.set(key, { logId, status: 'error' });
          } else if (isFirstForDlid && !hasError && queueAlerts.has(key)) {
            const alert = queueAlerts.get(key);
            updateLogEntry(alert.logId, { status: 'success', message: `${title}: resolved` });
            queueAlerts.delete(key);
          }

          const queueMovieId = item.movieId || item.movie?.id;
          const pipelineItems = getPipeline();
          for (const pItem of pipelineItems) {
            if (pItem.service !== 'radarr' || !pItem.movieId || pItem.movieId !== queueMovieId) continue;
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
            scheduleLibraryRefresh(pItem.service + ' queue cleared for ' + (pItem.title || pItem.key), LIBRARY_REFRESH_DELAY_MS);
            setTimeout(() => {
              completePipeline(pItem.key);
              scheduleLibraryRefresh(pItem.service + ' pipeline completed for ' + (pItem.title || pItem.key), 0);
            }, 3 * 60 * 1000);
          }
        }
      } catch (err) {
        logServerEvent('error', 'pipeline.queue_monitor.failed', {
          service: 'radarr',
          error: summarizeError(err),
        });
      }
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
    statusDetail: item.statusDetail || null,
    statusUpdatedAt: item.statusUpdatedAt || null,
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
      const retrySeasonNumbers = item.retrySeasonNumbers || item.seasonNumbers || null;
      let cmdBody = { name: 'SeriesSearch', seriesId: item.retryId };
      let retrySeasonNumber = null;
      if (retrySeasonNumbers?.length) {
        const searchPlan = await prepareSonarrSearch(item.retryId, retrySeasonNumbers);
        const plannedSeasonSearch = searchPlan.seasonSearches[0];
        cmdBody = plannedSeasonSearch?.cmdBody || { name: 'SeasonSearch', seriesId: item.retryId, seasonNumber: retrySeasonNumbers[0] };
        retrySeasonNumber = plannedSeasonSearch?.seasonNumber ?? retrySeasonNumbers[0] ?? null;
        if (item.logId) {
          if (searchPlan.seriesMonitoringChanged || searchPlan.episodeMonitoringChanged) {
            addLogStep(item.logId, `Re-enabled Sonarr monitoring before retrying season ${retrySeasonNumber}`, 'info');
          }
          if (plannedSeasonSearch?.mode === 'episode') {
            addLogStep(item.logId, `Retrying released episodes individually for season ${retrySeasonNumber}`, 'info');
          }
        }
      }
      const cmdResp = await fetch(`${SONARR_HOST}/api/v3/command?apikey=${SONARR_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmdBody),
      });
      if (!cmdResp.ok) {
        throw new Error(await readUpstreamErrorMessage(cmdResp, `Sonarr command failed: HTTP ${cmdResp.status}`));
      }
      const cmdData = await cmdResp.json();
      advancePipeline(item.key, 'searching');
      addPipelineStep(item.key, 'Retry submitted — waiting for Sonarr search completion');
      if (item.logId) addLogStep(item.logId, 'Retrying search…', 'info');
      watchSonarrSearch(item.key, cmdData.id, item.retryId, retrySeasonNumber, item.logId, item.title)
        .catch((error) => handleWatcherCrash(item.key, 'sonarr-search-retry', error, {
          service: 'sonarr',
          title: item.title,
          retryId: item.retryId,
        }));
    } else if (item.service === 'radarr' && item.retryId && RADARR_API_KEY) {
      advancePipeline(item.key, 'searching');
      pendingSearches.set(item.key, { key: item.key, title: item.title, service: 'radarr', type: 'movie', startedAt: Date.now(), status: 'searching', posterUrl: item.posterUrl || null });
      addPipelineStep(item.key, 'Retry checking Radarr release results directly…');
      if (item.logId) addLogStep(item.logId, 'Retrying direct release check…', 'info');

      try {
        const releases = await fetchWithTimeout(`${RADARR_HOST}/api/v3/release?movieId=${item.retryId}&apikey=${RADARR_API_KEY}`, DIRECT_RELEASE_TIMEOUT_MS);
        const releaseList = Array.isArray(releases) ? releases : [];
        const approvedRelease = selectApprovedRelease(releaseList);
        const approvedCount = releaseList.filter(r => !r.rejected).length;
        addPipelineStep(item.key, `Radarr direct retry returned ${releaseList.length} release(s): ${approvedCount} auto-approved`);

        if (approvedRelease) {
          addPipelineStep(item.key, `Auto-grabbing ${releaseQualityName(approvedRelease)} with ${approvedRelease.seeders || 0} seeders: ${releaseShortTitle(approvedRelease)}`);
          await arrGrab({
            service: 'Radarr',
            host: RADARR_HOST,
            apiKey: RADARR_API_KEY,
            guid: approvedRelease.guid,
            indexerId: approvedRelease.indexerId,
            title: approvedRelease.title,
          });
          const entry = pendingSearches.get(item.key);
          if (entry) Object.assign(entry, { status: 'grabbed' });
          advancePipeline(item.key, 'grabbed');
          addPipelineStep(item.key, 'Direct retry grab accepted by Radarr — waiting for qBittorrent handoff');
          if (item.logId) addLogStep(item.logId, `Direct retry grab accepted: ${releaseShortTitle(approvedRelease)}`, 'success');
          setTimeout(() => monitorQueues().catch((error) => {
            logServerEvent('warn', 'pipeline.queue_monitor.after_direct_retry_failed', {
              ...readPipelineContext(item.key),
              error: summarizeError(error),
            });
          }), 1500);
          setTimeout(() => pendingSearches.delete(item.key), 90000);
          return res.json({ success: true, accelerated: true, grabbed: true });
        }

        if (releaseList.length > 0) {
          const rejSummary = summarizeReleaseRejections(releaseList);
          const noResultsMsg = rejSummary
            ? `No grab — ${rejSummary}`
            : 'No matching releases found — check indexers or availability';
          markPipelineNoResults(item.key, noResultsMsg, item.logId);
          setTimeout(() => pendingSearches.delete(item.key), 120000);
          return res.json({ success: true, accelerated: true, grabbed: false, noResults: true });
        }

        addPipelineStep(item.key, 'Radarr direct retry returned no releases — starting full Radarr command search…');
      } catch (directErr) {
        addPipelineStep(item.key, `Direct retry did not finish: ${safeErrorMessage(directErr)}. Starting full Radarr command search…`);
        logServerEvent('warn', 'pipeline.radarr_direct_retry.failed', {
          ...readPipelineContext(item.key),
          error: summarizeError(directErr),
        });
      }

      const cmdResp = await fetch(`${RADARR_HOST}/api/v3/command?apikey=${RADARR_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'MoviesSearch', movieIds: [item.retryId] }),
      });
      if (!cmdResp.ok) {
        throw new Error(await readUpstreamErrorMessage(cmdResp, `Radarr command failed: HTTP ${cmdResp.status}`));
      }
      const cmdData = await cmdResp.json();
      addPipelineStep(item.key, 'Retry submitted — waiting for Radarr search completion');
      if (item.logId) addLogStep(item.logId, 'Retrying full Radarr search…', 'info');
      watchRadarrSearch(item.key, cmdData.id, item.retryId, item.logId, item.title)
        .catch((error) => handleWatcherCrash(item.key, 'radarr-search-retry', error, {
          service: 'radarr',
          title: item.title,
          retryId: item.retryId,
        }));
    } else {
      return res.status(400).json({ error: 'Cannot retry this item type' });
    }
    res.json({ success: true });
  } catch (err) {
    if (item.logId) addLogStep(item.logId, `Retry failed: ${err.message}`, 'error');
    logServerEvent('error', 'pipeline.retry.failed', {
      ...readPipelineContext(item.key, {
        service: item.service,
        title: item.title,
        retryId: item.retryId,
      }),
      error: summarizeError(err),
    });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pipeline/:key/cancel', async (req, res) => {
  const item = getPipelineItem(req.params.key);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const warnings = [];
  try {
    if (item.torrentHash) {
      try {
        const { qbHost, cookie } = await qbittorrentLogin();
        const resp = await fetch(`${qbHost}/api/v2/torrents/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
          body: `hashes=${item.torrentHash}&deleteFiles=true`,
        });
        if (!resp.ok) {
          const warning = `qBittorrent delete failed: HTTP ${resp.status}`;
          warnings.push(warning);
          logServerEvent('warn', 'pipeline.cancel.qb_delete_failed', {
            ...readPipelineContext(item.key),
            status: resp.status,
          });
        }
      } catch (error) {
        const warning = `qBittorrent delete failed: ${summarizeError(error).message}`;
        warnings.push(warning);
        logServerEvent('warn', 'pipeline.cancel.qb_delete_failed', {
          ...readPipelineContext(item.key),
          error: summarizeError(error),
        });
      }
    }
    if (item.queueId) {
      try {
        let resp = null;
        if (item.service === 'sonarr' && SONARR_API_KEY) {
          resp = await fetch(`${SONARR_HOST}/api/v3/queue/${item.queueId}?removeFromClient=true&blocklist=false&apikey=${SONARR_API_KEY}`, { method: 'DELETE' });
        } else if (item.service === 'radarr' && RADARR_API_KEY) {
          resp = await fetch(`${RADARR_HOST}/api/v3/queue/${item.queueId}?removeFromClient=true&blocklist=false&apikey=${RADARR_API_KEY}`, { method: 'DELETE' });
        }
        if (resp && !resp.ok) {
          const warning = `${item.service} queue cleanup failed: HTTP ${resp.status}`;
          warnings.push(warning);
          logServerEvent('warn', 'pipeline.cancel.queue_delete_failed', {
            ...readPipelineContext(item.key),
            status: resp.status,
          });
        }
      } catch (error) {
        const warning = `${item.service} queue cleanup failed: ${summarizeError(error).message}`;
        warnings.push(warning);
        logServerEvent('warn', 'pipeline.cancel.queue_delete_failed', {
          ...readPipelineContext(item.key),
          error: summarizeError(error),
        });
      }
    }
    removePipelineItem(req.params.key);
    if (warnings.length > 0) {
      logServerEvent('warn', 'pipeline.cancel.partial_cleanup', {
        ...readPipelineContext(item.key, {
          stage: item.stage,
        }),
        warnings,
      });
    }
    res.json({ success: true, warnings });
  } catch (err) {
    logServerEvent('error', 'pipeline.cancel.failed', {
      ...readPipelineContext(item.key),
      error: summarizeError(err),
    });
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

  let activeLogId = null;
  let activePipelineKey = null;
  let activeTitle = null;
  try {
    if (service === 'sonarr' && SONARR_API_KEY) {
      const searchPlan = await prepareSonarrSearch(id, seasonNumbers || null);
      const { seriesData, seriesMonitoringChanged, episodeMonitoringChanged } = searchPlan;
      const seriesTitle = seriesData.title || 'Unknown';
      const seriesPosterUrl = pickArrImageUrl(seriesData.images || [], 'poster', 'sonarr');
      activeTitle = seriesTitle;

      if (seasonNumbers?.length) {
        for (const seasonSearch of searchPlan.seasonSearches) {
          const sn = seasonSearch.seasonNumber;
          const snLabel = seasonNumbers.length > 1 ? `${seriesTitle} S${sn}` : `${seriesTitle} Season ${sn}`;
          const logId = logActivity('download', `Searching: ${snLabel}`, { seriesId: id, season: sn }, 'pending', { service: 'sonarr', seriesId: id, season: sn, title: seriesTitle });
          activeLogId = logId;
          if (seriesMonitoringChanged || episodeMonitoringChanged) {
            addLogStep(logId, `Auto-enabled monitoring for ${snLabel}`, 'info');
          }
          if (seasonSearch.mode === 'episode') {
            addLogStep(logId, `Searching ${seasonSearch.missingReleasedEpisodeIds.length} released episode(s) individually for ${snLabel}`, 'info');
          }
          const cmdResp = await fetch(`${SONARR_HOST}/api/v3/command?apikey=${SONARR_API_KEY}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(seasonSearch.cmdBody),
          });
          if (!cmdResp.ok) throw new Error(await readUpstreamErrorMessage(cmdResp, `Sonarr command failed: HTTP ${cmdResp.status}`));
          const cmdData = await cmdResp.json();
          updateLogEntry(logId, { status: 'info', message: `Sonarr searching: ${snLabel}` });
          const pendingKey = `sonarr-${id}-${sn}-${Date.now()}`;
          activePipelineKey = pendingKey;
          pendingSearches.set(pendingKey, { key: pendingKey, service: 'sonarr', title: seriesTitle, subtitle: `Season ${sn}`, seasons: [sn], logId, seriesId: id, posterUrl: seriesPosterUrl, startedAt: Date.now(), status: 'searching' });
          addPipelineItem(pendingKey, { service: 'sonarr', title: seriesTitle, subtitle: `Season ${sn}`, posterUrl: seriesPosterUrl, logId, seriesId: id, seasonNumbers: [sn], retryId: id });
          advancePipeline(pendingKey, 'searching');
          watchSonarrSearch(pendingKey, cmdData.id, id, sn, logId, seriesTitle).catch((error) => handleWatcherCrash(pendingKey, 'sonarr-search', error, {
            service: 'sonarr',
            title: seriesTitle,
            seriesId: id,
            seasonNumber: sn,
          }));
        }
      } else {
        const logId = logActivity('download', `Searching: ${seriesTitle}`, { seriesId: id }, 'pending', { service: 'sonarr', seriesId: id, title: seriesTitle });
        activeLogId = logId;
        if (seriesMonitoringChanged || episodeMonitoringChanged) addLogStep(logId, `Auto-enabled monitoring for ${seriesTitle}`, 'info');
        const cmdResp = await fetch(`${SONARR_HOST}/api/v3/command?apikey=${SONARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'SeriesSearch', seriesId: id }),
        });
        if (!cmdResp.ok) throw new Error(await readUpstreamErrorMessage(cmdResp, `Sonarr command failed: HTTP ${cmdResp.status}`));
        const cmdData = await cmdResp.json();
        updateLogEntry(logId, { status: 'info', message: `Sonarr searching: ${seriesTitle}` });
        const pendingKey = `sonarr-${id}-all-${Date.now()}`;
        activePipelineKey = pendingKey;
        pendingSearches.set(pendingKey, { key: pendingKey, service: 'sonarr', title: seriesTitle, subtitle: 'All seasons', seasons: null, logId, seriesId: id, posterUrl: seriesPosterUrl, startedAt: Date.now(), status: 'searching' });
        addPipelineItem(pendingKey, { service: 'sonarr', title: seriesTitle, subtitle: 'All seasons', posterUrl: seriesPosterUrl, logId, seriesId: id, seasonNumbers: null, retryId: id });
        advancePipeline(pendingKey, 'searching');
        watchSonarrSearch(pendingKey, cmdData.id, id, null, logId, seriesTitle).catch((error) => handleWatcherCrash(pendingKey, 'sonarr-search', error, {
          service: 'sonarr',
          title: seriesTitle,
          seriesId: id,
        }));
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
      activeTitle = movieTitle;
      const logId = logActivity('download', `Searching for "${movieTitle}"`, { movieId: id }, 'pending', { service: 'radarr', title: movieTitle, movieId: id });
      activeLogId = logId;
      const pipelineKey = `radarr-${id}-${Date.now()}`;
      activePipelineKey = pipelineKey;
      addPipelineItem(pipelineKey, { service: 'radarr', title: movieTitle, subtitle: 'Movie', posterUrl: moviePosterUrl, logId, movieId: id, retryId: id });
      advancePipeline(pipelineKey, 'searching');
      pendingSearches.set(pipelineKey, { key: pipelineKey, title: movieTitle, service: 'radarr', type: 'movie', startedAt: Date.now(), status: 'searching', posterUrl: moviePosterUrl });
      updateLogEntry(logId, { status: 'info', message: `Radarr checking direct release results for "${movieTitle}"` });
      addPipelineStep(pipelineKey, 'Checking Radarr release results directly before starting the slower command search…');

      try {
        const releases = await fetchWithTimeout(`${RADARR_HOST}/api/v3/release?movieId=${id}&apikey=${RADARR_API_KEY}`, DIRECT_RELEASE_TIMEOUT_MS);
        const releaseList = Array.isArray(releases) ? releases : [];
        const approvedRelease = selectApprovedRelease(releaseList);
        const approvedCount = releaseList.filter(r => !r.rejected).length;
        addPipelineStep(pipelineKey, `Radarr direct search returned ${releaseList.length} release(s): ${approvedCount} auto-approved`);

        if (approvedRelease) {
          addPipelineStep(pipelineKey, `Auto-grabbing ${releaseQualityName(approvedRelease)} with ${approvedRelease.seeders || 0} seeders: ${releaseShortTitle(approvedRelease)}`);
          await arrGrab({
            service: 'Radarr',
            host: RADARR_HOST,
            apiKey: RADARR_API_KEY,
            guid: approvedRelease.guid,
            indexerId: approvedRelease.indexerId,
            title: approvedRelease.title,
          });
          const entry = pendingSearches.get(pipelineKey);
          if (entry) Object.assign(entry, { status: 'grabbed' });
          advancePipeline(pipelineKey, 'grabbed');
          addPipelineStep(pipelineKey, 'Direct grab accepted by Radarr — waiting for qBittorrent handoff');
          addLogStep(logId, `Direct grab accepted: ${releaseShortTitle(approvedRelease)}`, 'success');
          setTimeout(() => monitorQueues().catch((error) => {
            logServerEvent('warn', 'pipeline.queue_monitor.after_direct_grab_failed', {
              ...readPipelineContext(pipelineKey),
              error: summarizeError(error),
            });
          }), 1500);
          setTimeout(() => pendingSearches.delete(pipelineKey), 90000);
          return res.json({ success: true, accelerated: true, grabbed: true, pipelineKey });
        }

        if (releaseList.length > 0) {
          const rejSummary = summarizeReleaseRejections(releaseList);
          const noResultsMsg = rejSummary
            ? `No grab — ${rejSummary}`
            : 'No matching releases found — check indexers or availability';
          markPipelineNoResults(pipelineKey, noResultsMsg, logId);
          setTimeout(() => pendingSearches.delete(pipelineKey), 120000);
          return res.json({ success: true, accelerated: true, grabbed: false, noResults: true, pipelineKey });
        }

        addPipelineStep(pipelineKey, 'Radarr direct search returned no releases — starting full Radarr command search…');
      } catch (directErr) {
        addPipelineStep(pipelineKey, `Direct release check did not finish: ${safeErrorMessage(directErr)}. Starting full Radarr command search…`);
        logServerEvent('warn', 'pipeline.radarr_direct_search.failed', {
          ...readPipelineContext(pipelineKey),
          error: summarizeError(directErr),
        });
      }

      const resp = await fetch(`${RADARR_HOST}/api/v3/command?apikey=${RADARR_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'MoviesSearch', movieIds: [id] }),
      });
      if (!resp.ok) throw new Error(await readUpstreamErrorMessage(resp, `Radarr command failed: HTTP ${resp.status}`));
      const cmdData = await resp.json();
      updateLogEntry(logId, { status: 'info', message: `Radarr searching for "${movieTitle}"` });
      watchRadarrSearch(pipelineKey, cmdData.id, id, logId, movieTitle).catch((error) => handleWatcherCrash(pipelineKey, 'radarr-search', error, {
        service: 'radarr',
        title: movieTitle,
        movieId: id,
      }));
      res.json({ success: true, accelerated: false, pipelineKey });

    } else if (service === 'lidarr' && LIDARR_API_KEY) {
      if (albumIds?.length) {
        let albumNames = [];
        try {
          const albumDetails = await Promise.all(albumIds.map(aid => fetchWithTimeout(`${LIDARR_HOST}/api/v1/album/${aid}?apikey=${LIDARR_API_KEY}`)));
          albumNames = albumDetails.map(a => a.title || 'Unknown');
        } catch {}
        const logId = logActivity('download', `Searching Lidarr for ${albumIds.length} album(s): ${albumNames.join(', ') || albumIds.join(', ')}`, { albumIds, albumNames }, 'pending', { service: 'lidarr', albumNames, albumIds });
        activeLogId = logId;
        activeTitle = albumNames.join(', ') || `${albumIds.length} album(s)`;
        const resp = await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'AlbumSearch', albumIds }),
        });
        if (!resp.ok) throw new Error(await readUpstreamErrorMessage(resp, `Lidarr command failed: HTTP ${resp.status}`));
        updateLogEntry(logId, { status: 'success', message: `Lidarr searching for ${albumIds.length} album(s): ${albumNames.join(', ') || 'unknown'}` });
      } else {
        const logId = logActivity('download', 'Searching Lidarr for artist', { artistId: id }, 'pending');
        activeLogId = logId;
        const resp = await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'ArtistSearch', artistId: id }),
        });
        if (!resp.ok) throw new Error(await readUpstreamErrorMessage(resp, `Lidarr command failed: HTTP ${resp.status}`));
        updateLogEntry(logId, { status: 'success', message: 'Lidarr artist search triggered' });
      }
      res.json({ success: true });

    } else {
      return res.status(400).json({ error: 'Unknown service or not configured' });
    }
  } catch (err) {
    if (activeLogId) {
      updateLogEntry(activeLogId, { status: 'error', message: `Search command failed: ${err.message}` });
    }
    if (activePipelineKey) {
      markPipelineFailure(activePipelineKey, {
        event: 'pipeline.command.search_failed',
        message: `Search command failed: ${err.message}`,
        error: err,
        logId: activeLogId,
        context: {
          service,
          title: activeTitle,
          requestId: id,
        },
      });
    } else {
      logServerEvent('error', 'pipeline.command.search_failed', {
        service,
        requestId: id,
        title: activeTitle,
        error: summarizeError(err),
      });
    }
    logActivity('error', `Search command failed: ${err.message}`, { service, id }, 'error');
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
    scheduleLibraryRefresh('arr grab accepted for ' + service, LIBRARY_REFRESH_DELAY_MS);
    let pipelineTracked = null;
    if (pipelineKey) {
      const item = getPipelineItem(pipelineKey);
      pipelineTracked = Boolean(item);
      if (item) {
        advancePipeline(pipelineKey, 'grabbed');
        addPipelineStep(pipelineKey, 'Manual grab accepted by Arr — waiting for download client handoff');
        if (item.logId) addLogStep(item.logId, 'Manual grab accepted by Arr', 'success');
      } else {
        logServerEvent('warn', 'pipeline.grab.transition_missing', {
          pipelineKey,
          service,
          title: title || null,
        });
      }
    }
    res.json({ success: true, pipelineTracked });
  } catch (err) {
    if (pipelineKey && getPipelineItem(pipelineKey)) {
      markPipelineFailure(pipelineKey, {
        event: 'pipeline.grab.failed',
        message: `Grab failed: ${err.message}`,
        error: err,
        context: {
          service,
          title: title || null,
          indexerId: indexerId || null,
          hasDownloadUrl: Boolean(downloadUrl),
        },
      });
    } else {
      logServerEvent('error', 'pipeline.grab.failed', {
        pipelineKey: pipelineKey || null,
        service,
        title: title || null,
        indexerId: indexerId || null,
        hasDownloadUrl: Boolean(downloadUrl),
        error: summarizeError(err),
      });
    }
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
      } catch (err) {
        logServerEvent('error', 'pipeline.arr_queue_fetch_failed', {
          service: 'sonarr',
          error: summarizeError(err),
        });
      }
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
      } catch (err) {
        logServerEvent('error', 'pipeline.arr_queue_fetch_failed', {
          service: 'radarr',
          error: summarizeError(err),
        });
      }
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
