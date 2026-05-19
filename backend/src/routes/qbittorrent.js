import { Router } from 'express';
import { fetchWithTimeout, normalizeForMatch, pickImageUrl, qbAction, qbFetchJson } from '../utils.js';
import { CONFIG } from '../config.js';
import {
  getBwLifetimeState,
  getPipeline,
  libraryCache,
  logServerEvent,
  metadataCache,
  noteQbSessionTotals,
  saveBwLifetime as persistBwLifetime,
  resetBwLifetime,
  summarizeError,
} from '../state.js';

const router = Router();

let bwSaveCounter = 0;
let bwSavePending = false;
const TORRENT_POSTER_LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;
const TORRENT_POSTER_LOOKUP_TIMEOUT_MS = 3500;
const torrentPosterLookupCache = new Map();
const pollFailures = {
  bandwidth: false,
  status: false,
};

function summarizeHash(hash) {
  return typeof hash === 'string' && hash.length > 8 ? `${hash.slice(0, 8)}…` : hash || null;
}

function inferServiceFromCategory(category) {
  const value = String(category || '').toLowerCase();
  if (value.includes('radarr') || value.includes('movie')) return 'radarr';
  if (value.includes('sonarr') || value.includes('tv')) return 'sonarr';
  if (value.includes('lidarr') || value.includes('music')) return 'lidarr';
  return null;
}

function titleMatchesTorrent(title, torrentName) {
  const titleText = normalizeForMatch(title);
  const torrentText = normalizeForMatch(torrentName);
  if (titleText.length < 3) return false;
  if (torrentText.includes(titleText)) return true;
  const tokens = titleText
    .split(' ')
    .filter((token) => token.length >= 3 && !['and', 'the', 'for', 'with'].includes(token));
  return tokens.length >= 2 && tokens.every((token) => torrentText.includes(token));
}

function pickPosterFromItems(torrent, items, titleKeys = ['title']) {
  for (const item of items || []) {
    if (!item?.posterUrl) continue;
    if (titleKeys.some((key) => titleMatchesTorrent(item?.[key], torrent.name))) {
      return item.posterUrl;
    }
  }
  return null;
}

function compactSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanReleaseTitle(name) {
  return compactSpaces(String(name || '')
    .split('/')
    .pop()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\b(480p|576p|720p|1080p|2160p|4k|uhd|hdr|dv|web|webrip|webdl|web dl|bluray|blu ray|brrip|bdrip|remux|hdtv|amzn|nf|hulu|aac|ddp|dts|x264|x265|h264|h265|hevc|avc|proper|repack|internal|multi|yts|mx|bitsearch|to|leak|mp4|mkv)\b/gi, ' '));
}

function getPosterLookupTerms(name) {
  const cleaned = cleanReleaseTitle(name);
  const terms = [
    cleaned.match(/^(.+?)\s+s\d{1,2}(?:e\d{1,2})?\b/i)?.[1],
    cleaned.match(/^(.+?)\s+(?:19|20)\d{2}\b/)?.[1],
    cleaned,
  ]
    .map(compactSpaces)
    .filter((term) => term.length >= 3);
  return [...new Set(terms)];
}

async function lookupArrPoster(service, term) {
  if (service === 'movie' && CONFIG.RADARR_API_KEY) {
    const results = await fetchWithTimeout(
      `${CONFIG.RADARR_HOST}/api/v3/movie/lookup?term=${encodeURIComponent(term)}&apikey=${CONFIG.RADARR_API_KEY}`,
      TORRENT_POSTER_LOOKUP_TIMEOUT_MS,
    );
    return Array.isArray(results) ? pickImageUrl(results[0]?.images, 'poster') : null;
  }
  if (service === 'series' && CONFIG.SONARR_API_KEY) {
    const results = await fetchWithTimeout(
      `${CONFIG.SONARR_HOST}/api/v3/series/lookup?term=${encodeURIComponent(term)}&apikey=${CONFIG.SONARR_API_KEY}`,
      TORRENT_POSTER_LOOKUP_TIMEOUT_MS,
    );
    return Array.isArray(results) ? pickImageUrl(results[0]?.images, 'poster') : null;
  }
  return null;
}

async function lookupPosterForTorrent(torrent, service) {
  const terms = getPosterLookupTerms(torrent.name);
  if (terms.length === 0) return null;
  const cacheKey = `${service || 'any'}:${normalizeForMatch(terms[0])}`;
  const cached = torrentPosterLookupCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TORRENT_POSTER_LOOKUP_TTL_MS) {
    return cached.posterUrl;
  }
  if (cached?.inflight) return cached.inflight;

  const serviceOrder = service === 'radarr'
    ? ['movie', 'series']
    : service === 'sonarr'
      ? ['series', 'movie']
      : ['series', 'movie'];

  const inflight = (async () => {
    for (const kind of serviceOrder) {
      for (const term of terms) {
        try {
          const posterUrl = await lookupArrPoster(kind, term);
          if (posterUrl) {
            torrentPosterLookupCache.set(cacheKey, { ts: Date.now(), posterUrl });
            return posterUrl;
          }
        } catch {
          /* keep trying cheaper alternate terms/services */
        }
      }
    }
    torrentPosterLookupCache.set(cacheKey, { ts: Date.now(), posterUrl: null });
    return null;
  })();

  torrentPosterLookupCache.set(cacheKey, { ts: Date.now(), posterUrl: null, inflight });
  return inflight;
}

async function pickTorrentPosterUrl(torrent) {
  const hash = String(torrent.hash || '').toLowerCase();
  const cached = metadataCache.data?.[hash]?.posterUrl;
  if (cached) return cached;

  const service = inferServiceFromCategory(torrent.category);
  const pipelinePoster = pickPosterFromItems(
    torrent,
    getPipeline().filter((item) => !service || item.service === service),
  );
  if (pipelinePoster) return pipelinePoster;

  if (service === 'radarr') {
    return pickPosterFromItems(torrent, libraryCache.movies, ['title', 'sortTitle']) || lookupPosterForTorrent(torrent, service);
  }
  if (service === 'sonarr') {
    return pickPosterFromItems(torrent, libraryCache.series, ['title', 'sortTitle']) || lookupPosterForTorrent(torrent, service);
  }
  if (service === 'lidarr') {
    return pickPosterFromItems(torrent, libraryCache.artists, ['artistName', 'sortName']);
  }
  return pickPosterFromItems(torrent, [
    ...libraryCache.movies,
    ...libraryCache.series,
    ...libraryCache.artists,
  ], ['title', 'sortTitle', 'artistName', 'sortName']) || lookupPosterForTorrent(torrent, service);
}

function markPollFailure(key, event, error, fields = {}) {
  if (!pollFailures[key]) {
    logServerEvent('error', event, {
      ...fields,
      error: summarizeError(error),
    });
  }
  pollFailures[key] = true;
}

function markPollRecovery(key, event, fields = {}) {
  if (pollFailures[key]) {
    logServerEvent('info', event, fields);
  }
  pollFailures[key] = false;
}

function queueBwLifetimeSave() {
  // Overlapping flushes can race under fast polling; the next save writes the latest snapshot.
  if (bwSavePending) return;
  bwSavePending = true;
  try {
    persistBwLifetime();
  } finally {
    bwSavePending = false;
  }
}

router.get('/bandwidth', async (req, res) => {
  try {
    const info = await qbFetchJson('/api/v2/transfer/info');
    const sessionDl = info.dl_info_data || 0;
    const sessionUl = info.up_info_data || 0;
    const before = getBwLifetimeState();
    const after = noteQbSessionTotals(sessionDl, sessionUl);
    const rolledOver =
      sessionDl < before.lastSession.dl ||
      sessionUl < before.lastSession.ul;
    // qBittorrent resets these counters on restart, so roll the previous session into the baseline.
    if (rolledOver) {
      queueBwLifetimeSave();
      logServerEvent('info', 'state.bandwidth_lifetime.rollover_detected', {
        previousSession: before.lastSession,
        currentSession: { dl: sessionDl, ul: sessionUl },
        baseline: after.baseline,
      });
    }
    // This route is polled often enough that periodic flushes are cheaper than per-request writes.
    if (++bwSaveCounter >= 20) { bwSaveCounter = 0; queueBwLifetimeSave(); }
    markPollRecovery('bandwidth', 'qb.transfer.status_recovered');
    res.json({
      dlSpeed: info.dl_info_speed || 0,
      ulSpeed: info.up_info_speed || 0,
      dlTotal: sessionDl,
      ulTotal: sessionUl,
      lifetimeDl: after.baseline.dl + sessionDl,
      lifetimeUl: after.baseline.ul + sessionUl,
    });
  } catch (e) {
    markPollFailure('bandwidth', 'qb.transfer.status_failed', e, {
      route: '/api/bandwidth',
    });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/bandwidth/lifetime', (req, res) => {
  resetBwLifetime();
  queueBwLifetimeSave();
  logServerEvent('info', 'state.bandwidth_lifetime.reset', {
    route: '/api/bandwidth/lifetime',
  });
  res.json({ ok: true });
});

router.get('/qbittorrent/status', async (req, res) => {
  try {
    const torrents = await qbFetchJson('/api/v2/torrents/info');
    markPollRecovery('status', 'qb.torrents.status_recovered');

    const formattedTorrents = await Promise.all(torrents.map(async torrent => ({
      name: torrent.name,
      hash: torrent.hash,
      size: torrent.size,
      progress: Math.round(torrent.progress * 10000) / 100,
      downloadSpeed: torrent.dlspeed,
      uploadSpeed: torrent.upspeed,
      eta: torrent.eta,
      state: torrent.state,
      ratio: torrent.ratio,
      category: torrent.category,
      posterUrl: await pickTorrentPosterUrl(torrent),
      addedOn: new Date(torrent.added_on * 1000).toISOString(),
      completedOn: torrent.completion_on > 0
        ? new Date(torrent.completion_on * 1000).toISOString()
        : null
    })));

    res.json({
      torrents: formattedTorrents,
      count: formattedTorrents.length
    });
  } catch (error) {
    markPollFailure('status', 'qb.torrents.status_failed', error, {
      route: '/api/qbittorrent/status',
    });
    res.status(500).json({
      error: 'Failed to fetch qBittorrent data',
      message: error.message
    });
  }
});

router.post('/qbittorrent/torrents/:hash/pause', async (req, res) => {
  try {
    await qbAction(req.params.hash, 'pause');
    logServerEvent('info', 'qb.torrent.action_succeeded', {
      action: 'pause',
      hash: summarizeHash(req.params.hash),
    });
    res.json({ success: true });
  } catch (e) {
    logServerEvent('error', 'qb.torrent.action_failed', {
      action: 'pause',
      hash: summarizeHash(req.params.hash),
      error: summarizeError(e),
    });
    res.status(500).json({ error: e.message });
  }
});

router.post('/qbittorrent/torrents/:hash/resume', async (req, res) => {
  try {
    await qbAction(req.params.hash, 'resume');
    logServerEvent('info', 'qb.torrent.action_succeeded', {
      action: 'resume',
      hash: summarizeHash(req.params.hash),
    });
    res.json({ success: true });
  } catch (e) {
    logServerEvent('error', 'qb.torrent.action_failed', {
      action: 'resume',
      hash: summarizeHash(req.params.hash),
      error: summarizeError(e),
    });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/qbittorrent/torrents/:hash', async (req, res) => {
  const deleteFiles = req.query.deleteFiles === 'true' ? 'true' : 'false';
  try {
    await qbAction(req.params.hash, 'delete', `deleteFiles=${deleteFiles}`);
    logServerEvent('info', 'qb.torrent.action_succeeded', {
      action: 'delete',
      hash: summarizeHash(req.params.hash),
      deleteFiles: deleteFiles === 'true',
    });
    res.json({ success: true });
  } catch (e) {
    logServerEvent('error', 'qb.torrent.action_failed', {
      action: 'delete',
      hash: summarizeHash(req.params.hash),
      deleteFiles: deleteFiles === 'true',
      error: summarizeError(e),
    });
    res.status(500).json({ error: e.message });
  }
});

router.get('/qbittorrent/torrents/:hash/detail', async (req, res) => {
  const { hash } = req.params;
  try {
    const [torrentsResult, propsResult, trackersResult] = await Promise.allSettled([
      qbFetchJson(`/api/v2/torrents/info?hashes=${hash}`),
      qbFetchJson(`/api/v2/torrents/properties?hash=${hash}`),
      qbFetchJson(`/api/v2/torrents/trackers?hash=${hash}`),
    ]);
    const torrents = torrentsResult.status === 'fulfilled' ? torrentsResult.value : [];
    const props = propsResult.status === 'fulfilled' ? propsResult.value : {};
    const trackers = trackersResult.status === 'fulfilled' ? trackersResult.value : [];
    const t = torrents[0];
    if (!t) return res.status(404).json({ error: 'Torrent not found' });
    res.json({
      hash: t.hash,
      name: t.name,
      state: t.state,
      progress: Math.round(t.progress * 10000) / 100,
      dlspeed: t.dlspeed,
      upspeed: t.upspeed,
      size: t.size,
      downloaded: t.downloaded,
      uploaded: t.uploaded,
      ratio: t.ratio,
      savePath: t.save_path,
      numSeeds: t.num_seeds,
      numLeechs: t.num_leechs,
      eta: t.eta,
      addedOn: t.added_on,
      completedOn: t.completion_on,
      category: t.category,
      tags: t.tags,
      tracker: props.current_tracker || trackers.find(tr => tr.status === 2)?.url || t.tracker,
      pieceSize: props.piece_size,
      comment: props.comment,
      createdBy: props.created_by,
    });
  } catch (err) {
    logServerEvent('error', 'qb.torrent.detail_failed', {
      hash: summarizeHash(hash),
      error: summarizeError(err),
    });
    res.status(500).json({ error: err.message });
  }
});

export default router;
