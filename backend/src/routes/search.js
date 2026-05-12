import { Router } from 'express';
import { CONFIG } from '../config.js';
import { fetchWithTimeout } from '../utils.js';
import { fastSearchCache } from '../state.js';

const router = Router();

const { PROWLARR_HOST, PROWLARR_API_KEY, RADARR_HOST, RADARR_API_KEY, SONARR_HOST, SONARR_API_KEY } = CONFIG;

function detectQualityFromTitle(t) {
  if (!t) return 'Unknown';
  const l = t.toLowerCase();
  const res = /2160p|4k(?!\w)/i.test(l) ? '2160p' : /1080p/i.test(l) ? '1080p' : /720p/i.test(l) ? '720p' : /480p/i.test(l) ? '480p' : '';
  const src = /remux/i.test(l) ? 'Remux' : /blu-?ray|bdrip|brrip/i.test(l) ? 'Bluray' : /web-?dl/i.test(l) ? 'WEBDL' : /webrip/i.test(l) ? 'WEBRip' : /hdtv/i.test(l) ? 'HDTV' : /dvdrip|dvdscr/i.test(l) ? 'DVD' : '';
  return src && res ? `${src}-${res}` : src || res || 'Unknown';
}

let prowlarrToSonarrIndexer = {};
let prowlarrToRadarrIndexer = {};

async function buildIndexerMaps() {
  try {
    if (CONFIG.SONARR_API_KEY) {
      const idxs = await fetchWithTimeout(`${CONFIG.SONARR_HOST}/api/v3/indexer?apikey=${CONFIG.SONARR_API_KEY}`, 5000);
      if (Array.isArray(idxs)) {
        prowlarrToSonarrIndexer = {};
        for (const idx of idxs) {
          const base = idx.fields?.find(f => f.name === 'baseUrl')?.value || '';
          // Arr only exposes the backing Prowlarr indexer id inside the proxied baseUrl suffix.
          const m = base.match(/\/(\d+)\/$/);
          if (m) prowlarrToSonarrIndexer[parseInt(m[1])] = idx.id;
        }
      }
    }
    if (CONFIG.RADARR_API_KEY) {
      const idxs = await fetchWithTimeout(`${CONFIG.RADARR_HOST}/api/v3/indexer?apikey=${CONFIG.RADARR_API_KEY}`, 5000);
      if (Array.isArray(idxs)) {
        prowlarrToRadarrIndexer = {};
        for (const idx of idxs) {
          const base = idx.fields?.find(f => f.name === 'baseUrl')?.value || '';
          const m = base.match(/\/(\d+)\/$/);
          if (m) prowlarrToRadarrIndexer[parseInt(m[1])] = idx.id;
        }
      }
    }
  } catch (e) {
    console.warn('buildIndexerMaps error:', e.message);
  }
}

buildIndexerMaps().catch(e => console.warn('buildIndexerMaps startup failed:', e.message));

router.get('/fast-search', async (req, res) => {
  const { query, service } = req.query;
  if (!query?.trim()) return res.status(400).json({ error: 'Missing query' });
  if (!PROWLARR_API_KEY) return res.status(503).json({ error: 'Prowlarr not configured' });

  const cacheKey = `${query.trim().toLowerCase()}|${service || 'any'}`;
  const cached = fastSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 5 * 60 * 1000) return res.json(cached.results);
  for (const [k, v] of fastSearchCache) {
    if (Date.now() - v.ts >= 5 * 60 * 1000) fastSearchCache.delete(k);
  }

  try {
    const catParam = service === 'sonarr' ? '&categories=5000' : service === 'radarr' ? '&categories=2000' : '';
    const prowlarrUrl = `${PROWLARR_HOST}/api/v1/search?query=${encodeURIComponent(query.trim())}&type=search${catParam}&limit=100`;
    const raw = await fetchWithTimeout(prowlarrUrl, 15000, { 'X-Api-Key': PROWLARR_API_KEY });
    if (!Array.isArray(raw)) throw new Error('Unexpected Prowlarr response format');

    const results = raw.flatMap(r => {
      const pid = r.indexerId;
      const sid = prowlarrToSonarrIndexer[pid] ?? null;
      const rid = prowlarrToRadarrIndexer[pid] ?? null;
      // Grab requests need the downstream Arr indexer id, not Prowlarr's search id.
      const indexerId = service === 'sonarr' ? sid : service === 'radarr' ? rid : (sid ?? rid);
      if (indexerId === null) return [];
      return [{
        guid: r.guid,
        title: r.title,
        indexer: r.indexer,
        indexerId,
        prowlarrIndexerId: pid,
        seeders: r.seeders || 0,
        leechers: r.leechers || 0,
        size: r.size || 0,
        quality: detectQualityFromTitle(r.title),
        ageHours: r.ageHours || 0,
        rejected: false,
        rejections: [],
        releaseGroup: null,
        protocol: r.protocol || 'torrent',
        downloadUrl: r.downloadUrl || null,
      }];
    }).sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

    fastSearchCache.set(cacheKey, { results, ts: Date.now() });
    res.json(results);
  } catch (err) {
    console.error('fast-search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/manual-search', async (req, res) => {
  const { service, id, seasonNumber } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    let releases = [];
    if (service === 'radarr' && RADARR_API_KEY) {
      const data = await fetchWithTimeout(
        `${RADARR_HOST}/api/v3/release?movieId=${id}&apikey=${RADARR_API_KEY}`,
        90000
      );
      releases = Array.isArray(data) ? data : [];
    } else if (service === 'sonarr' && SONARR_API_KEY) {
      const url = seasonNumber
        ? `${SONARR_HOST}/api/v3/release?seriesId=${id}&seasonNumber=${seasonNumber}&apikey=${SONARR_API_KEY}`
        : `${SONARR_HOST}/api/v3/release?seriesId=${id}&apikey=${SONARR_API_KEY}`;
      const data = await fetchWithTimeout(url, 90000);
      releases = Array.isArray(data) ? data : [];
    } else {
      return res.status(400).json({ error: 'Unknown service or not configured' });
    }
    releases.sort((a, b) => (b.seeders || 0) - (a.seeders || 0) || (b.size || 0) - (a.size || 0));
    res.json(releases.map(r => ({
      guid: r.guid,
      title: r.title,
      indexer: r.indexer,
      seeders: r.seeders || 0,
      leechers: r.leechers || 0,
      size: r.size || 0,
      quality: r.quality?.quality?.name || r.qualityVersion || 'Unknown',
      ageHours: r.ageHours || 0,
      rejected: r.rejected || false,
      rejections: r.rejections || [],
      indexerId: r.indexerId,
      releaseGroup: r.releaseGroup || null,
      protocol: r.protocol || 'torrent',
    })));
  } catch (err) {
    console.error('Manual search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
