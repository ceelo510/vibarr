import { Router } from 'express';
import http from 'http';
import https from 'https';
import { qbittorrentLogin, qbAction } from '../utils.js';
import { readFileSync, existsSync } from 'fs';
import * as fs from 'fs';

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 16, timeout: 30000 });

const router = Router();

const BW_LIFETIME_PATH = '/app/bandwidth-lifetime.json';
let bwLifetime = { baseline: { dl: 0, ul: 0 }, lastSession: { dl: 0, ul: 0 } };
try {
  if (existsSync(BW_LIFETIME_PATH)) {
    bwLifetime = JSON.parse(readFileSync(BW_LIFETIME_PATH, 'utf8'));
  }
} catch (e) {
  console.error('[bw-lifetime] Failed to load:', e.message);
}
let bwSaveCounter = 0;
let bwSavePending = false;
async function saveBwLifetime() {
  // Overlapping flushes can race under fast polling; the next save writes the latest snapshot.
  if (bwSavePending) return;
  bwSavePending = true;
  try {
    await fs.promises.writeFile(BW_LIFETIME_PATH, JSON.stringify(bwLifetime));
  } catch (e) {
    console.error('[bw-lifetime] Failed to save:', e.message);
  } finally {
    bwSavePending = false;
  }
}

router.get('/bandwidth', async (req, res) => {
  let aborted = false;
  req.on('close', () => { aborted = true; });
  try {
    const { qbHost, cookie } = await qbittorrentLogin();
    if (aborted) return;
    const r = await fetch(`${qbHost}/api/v2/transfer/info`, {
      headers: { Cookie: cookie, Referer: qbHost }
    });
    if (!r.ok) throw new Error(`qBittorrent transfer/info HTTP ${r.status}`);
    const info = await r.json();
    const sessionDl = info.dl_info_data || 0;
    const sessionUl = info.up_info_data || 0;
    if (sessionDl < bwLifetime.lastSession.dl || sessionUl < bwLifetime.lastSession.ul) {
      // qBittorrent resets these counters on restart, so roll the previous session into the baseline.
      bwLifetime.baseline.dl += bwLifetime.lastSession.dl;
      bwLifetime.baseline.ul += bwLifetime.lastSession.ul;
      saveBwLifetime();
    }
    bwLifetime.lastSession.dl = sessionDl;
    bwLifetime.lastSession.ul = sessionUl;
    // This route is polled often enough that periodic flushes are cheaper than per-request writes.
    if (++bwSaveCounter >= 20) { bwSaveCounter = 0; saveBwLifetime(); }
    res.json({
      dlSpeed: info.dl_info_speed || 0,
      ulSpeed: info.up_info_speed || 0,
      dlTotal: sessionDl,
      ulTotal: sessionUl,
      lifetimeDl: bwLifetime.baseline.dl + sessionDl,
      lifetimeUl: bwLifetime.baseline.ul + sessionUl,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/bandwidth/lifetime', (req, res) => {
  bwLifetime = { baseline: { dl: 0, ul: 0 }, lastSession: { dl: 0, ul: 0 } };
  saveBwLifetime();
  res.json({ ok: true });
});

router.get('/qbittorrent/status', async (req, res) => {
  let aborted = false;
  req.on('close', () => { aborted = true; });
  try {
    const { qbHost, cookie } = await qbittorrentLogin();
    if (aborted) return;

    const torrentsResponse = await fetch(`${qbHost}/api/v2/torrents/info`, {
      headers: {
        'Cookie': cookie,
        'Referer': qbHost,
      }
    });

    if (!torrentsResponse.ok) {
      throw new Error(`Failed to fetch torrents: HTTP ${torrentsResponse.status}`);
    }

    const torrents = await torrentsResponse.json();

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
    console.error('Error fetching qBittorrent data:', error);
    res.status(500).json({
      error: 'Failed to fetch qBittorrent data',
      message: error.message
    });
  }
});

router.post('/qbittorrent/torrents/:hash/pause', async (req, res) => {
  try { await qbAction(req.params.hash, 'pause'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/qbittorrent/torrents/:hash/resume', async (req, res) => {
  try { await qbAction(req.params.hash, 'resume'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/qbittorrent/torrents/:hash', async (req, res) => {
  const deleteFiles = req.query.deleteFiles === 'true' ? 'true' : 'false';
  try { await qbAction(req.params.hash, 'delete', `deleteFiles=${deleteFiles}`); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/qbittorrent/torrents/:hash/detail', async (req, res) => {
  const { hash } = req.params;
  try {
    const { qbHost, cookie } = await qbittorrentLogin();
    const [tResp, pResp, trkResp] = await Promise.all([
      fetch(`${qbHost}/api/v2/torrents/info?hashes=${hash}`, { headers: { Cookie: cookie } }),
      fetch(`${qbHost}/api/v2/torrents/properties?hash=${hash}`, { headers: { Cookie: cookie } }),
      fetch(`${qbHost}/api/v2/torrents/trackers?hash=${hash}`, { headers: { Cookie: cookie } }),
    ]);
    const torrents = tResp.ok ? await tResp.json() : [];
    const props = pResp.ok ? await pResp.json() : {};
    const trackers = trkResp.ok ? await trkResp.json() : [];
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
