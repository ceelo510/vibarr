import { Router } from 'express';
import { qbAction, qbFetchJson } from '../utils.js';
import {
  getBwLifetimeState,
  logServerEvent,
  noteQbSessionTotals,
  saveBwLifetime as persistBwLifetime,
  resetBwLifetime,
  summarizeError,
} from '../state.js';

const router = Router();

let bwSaveCounter = 0;
let bwSavePending = false;
const pollFailures = {
  bandwidth: false,
  status: false,
};

function summarizeHash(hash) {
  return typeof hash === 'string' && hash.length > 8 ? `${hash.slice(0, 8)}…` : hash || null;
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

    const formattedTorrents = torrents.map(torrent => ({
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
      addedOn: new Date(torrent.added_on * 1000).toISOString(),
      completedOn: torrent.completion_on > 0
        ? new Date(torrent.completion_on * 1000).toISOString()
        : null
    }));

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
