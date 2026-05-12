import { Router } from 'express';
import { CONFIG } from '../config.js';
import { fetchWithTimeout } from '../utils.js';
import {
  logActivity, updateLogEntry, addLogStep, getActivityLog, registerInterval,
} from '../state.js';

const router = Router();

const { SLSKD_HOST, SLSKD_API_KEY, LIDARR_HOST, LIDARR_API_KEY } = CONFIG;

async function slskdFetch(path, options = {}) {
  const url = `${SLSKD_HOST}${path}`;
  const resp = await fetch(url, {
    headers: { 'X-API-Key': SLSKD_API_KEY, ...options.headers },
    ...options,
  });
  if (!resp.ok) throw new Error(`SLSKD ${path} HTTP ${resp.status}`);
  return resp.json();
}

router.get('/slskd/downloads', async (req, res) => {
  try {
    const data = await slskdFetch('/api/v0/transfers/downloads');
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('slskd downloads error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.post('/slskd/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'Missing query' });
    const data = await slskdFetch(`/api/v0/search?query=${encodeURIComponent(query.trim())}`);
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('slskd search error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.post('/slskd/retry', async (req, res) => {
  try {
    const { username, filename } = req.body;
    if (!username || !filename) return res.status(400).json({ error: 'Missing username or filename' });
    await slskdFetch('/api/v0/transfers/downloads/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, filename }),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('slskd retry error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.delete('/slskd/downloads/:username', async (req, res) => {
  try {
    const { username } = req.params;
    if (!username) return res.status(400).json({ error: 'Missing username' });
    await slskdFetch(`/api/v0/transfers/downloads/${encodeURIComponent(username)}`, { method: 'DELETE' });
    res.json({ success: true });
  } catch (err) {
    console.error('slskd remove user downloads error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.delete('/slskd/downloads/:username/:fileId', async (req, res) => {
  try {
    const { username, fileId } = req.params;
    if (!username || !fileId) return res.status(400).json({ error: 'Missing username or fileId' });
    await slskdFetch(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(fileId)}`,
      { method: 'DELETE' }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('slskd remove single download error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

export async function searchAndDownloadSlskd(artistName, albumTitle, logId, artistId, albumId) {
  const query = `${artistName} ${albumTitle}`;
  if (logId) addLogStep(logId, `Searching Soulseek for "${query}"…`, 'info');

  try {
    const results = await slskdFetch(`/api/v0/search?query=${encodeURIComponent(query)}`);
    if (!Array.isArray(results) || results.length === 0) {
      if (logId) addLogStep(logId, `No Soulseek results for "${query}"`, 'warning');
      return { success: false, reason: 'no_results' };
    }

    const best = results[0];
    if (logId) addLogStep(logId, `Best Soulseek result: ${best.filename || 'unknown'} from ${best.username || 'unknown'}`, 'info');

    await slskdFetch('/api/v0/transfers/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: best.username, filename: best.filename }),
    });

    if (logId) addLogStep(logId, `Queued Soulseek download: ${best.filename}`, 'success');
    return { success: true };
  } catch (err) {
    const msg = `Soulseek search/download failed: ${err.message}`;
    if (logId) addLogStep(logId, msg, 'error');
    console.error('[searchAndDownloadSlskd]', msg);
    return { success: false, reason: err.message };
  }
}

export async function processCompletedSlskdDownloads() {
  if (!SLSKD_API_KEY || !LIDARR_API_KEY) return;
  try {
    const downloads = await slskdFetch('/api/v0/transfers/downloads');
    if (!Array.isArray(downloads)) return;

    const now = Date.now();
    const seen = new Set();
    const log = getActivityLog() || [];

    for (const dl of downloads) {
      if (dl.state !== 'Completed' && dl.state !== 'complete') continue;
      if (seen.has(dl.filename)) continue;
      seen.add(dl.filename);

      const alreadyLogged = log.some(e =>
        e.details?.slskdFilename === dl.filename && e.type === 'import'
      );
      if (alreadyLogged) continue;

      const match = dl.filename?.match(
        /(.+?)\s*[-–]\s*(.+?)\s*[\(\[]?\d{4}[\)\]]?/i
      );

      if (match) {
        const artistGuess = match[1].trim();
        const albumGuess = match[2].trim();

        try {
          // Soulseek completions lack Lidarr ids; infer artist/album from the folder name.
          await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'DownloadedAlbumsScan',
              artistName: artistGuess,
              albumTitle: albumGuess,
            }),
          });
        } catch (lidarrErr) {
          console.error('[slskd-completed] Lidarr import trigger failed:', lidarrErr.message);
        }

        logActivity('import', `Imported Soulseek download: ${dl.filename}`, {
          slskdFilename: dl.filename,
          artist: artistGuess,
          album: albumGuess,
          completedAt: dl.completedAt || new Date().toISOString(),
        }, 'success', { service: 'lidarr', title: `${artistGuess} - ${albumGuess}` });
      } else {
        logActivity('import', `Soulseek download completed: ${dl.filename}`, {
          slskdFilename: dl.filename,
          completedAt: dl.completedAt || new Date().toISOString(),
        }, 'success', { service: 'lidarr', title: dl.filename });
      }

      try {
        // Older SLSKD deletes by filename; newer builds expose an id.
        await slskdFetch(
          `/api/v0/transfers/downloads/${encodeURIComponent(dl.username)}/${encodeURIComponent(dl.id || dl.filename)}`,
          { method: 'DELETE' }
        );
      } catch (cleanupErr) {
        console.error('[slskd-completed] cleanup failed:', cleanupErr.message);
      }
    }
  } catch (err) {
    console.error('[processCompletedSlskdDownloads] error:', err.message);
  }
}

let lastActiveSnapshot = [];
let lastCompletedSnapshot = [];

export async function fetchSlskdDownloads() {
  if (!SLSKD_API_KEY) return { active: [], downloading: [], completed: [] };
  try {
    const downloads = await slskdFetch('/api/v0/transfers/downloads');
    if (!Array.isArray(downloads)) return { active: [], downloading: [], completed: [] };

    const formatted = downloads.map(dl => ({
      username: dl.username || 'unknown',
      file: dl.file || '',
      filename: dl.filename || '',
      bytes: dl.bytes || 0,
      state: dl.state || 'Unknown',
      progress: dl.bytes != null && dl.size != null && dl.size > 0
        ? Math.round((dl.bytes / dl.size) * 100) : 0,
      size: dl.size || 0,
      direction: dl.direction || 'Download',
      position: dl.position || 0,
      startTime: dl.startTime || null,
      endTime: dl.endTime || null,
      id: dl.id || dl.filename || '',
    }));

    const active = formatted.filter(d => d.state === 'Downloading' || d.state === 'Processing');
    const downloading = formatted.filter(d => d.state === 'Queued' || d.state === 'Pending' || d.state === 'InProgress');
    const completed = formatted.filter(d => d.state === 'Completed' || d.state === 'complete');

    lastActiveSnapshot = active;
    lastCompletedSnapshot = completed;

    return { active, downloading, completed };
  } catch (err) {
    console.error('[fetchSlskdDownloads] error:', err.message);
    // Keep the last successful snapshots visible during brief SLSKD outages.
    return { active: lastActiveSnapshot, downloading: [], completed: lastCompletedSnapshot };
  }
}

registerInterval(setInterval(() => {
  fetchSlskdDownloads();
}, 10000));

registerInterval(setInterval(() => {
  processCompletedSlskdDownloads();
}, 30000));

export default router;
