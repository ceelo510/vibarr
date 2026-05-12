import { Router } from 'express';
import { Readable } from 'stream';
import { CONFIG } from '../config.js';
import { fetchWithTimeout, normalizeForMatch, pickArrImageUrl, qbFetchJson } from '../utils.js';
import { metadataCache } from '../state.js';

const router = Router();

const { RADARR_HOST, RADARR_API_KEY, SONARR_HOST, SONARR_API_KEY, LIDARR_HOST, LIDARR_API_KEY } = CONFIG;
const posterCache = new Map();

const POSTER_CACHE_TTL_MS = 60 * 60 * 1000;
const POSTER_CACHE_MAX = 250;
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;
const ARR_CATALOG_TTL_MS = 5 * 60 * 1000;
const SONARR_EPISODE_ART_TTL_MS = 60 * 60 * 1000;
const POSTER_ALLOWED_HOSTS = [
  'image.tmdb.org',
  'images.metadata.svc',
  'coverartarchive.org',
  'artworks.thetvdb.com',
  'thetvdb.com',
  'fanart.tv',
  'assets.fanart.tv',
  'images.lidarr.audio',
  'r2.theaudiodb.com',
  'www.theaudiodb.com',
  'itunes.apple.com',
  'is1-ssl.mzstatic.com',
  'is2-ssl.mzstatic.com',
  'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com',
  'is5-ssl.mzstatic.com',
];
const arrCatalogCache = {
  movies: { ts: 0, data: null, inflight: null },
  series: { ts: 0, data: null, inflight: null },
};
const sonarrEpisodeArtCache = new Map();

function isAllowedPosterHost(hostname) {
  return POSTER_ALLOWED_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

function getCachedPoster(url) {
  const hit = posterCache.get(url);
  if (!hit) return null;
  if ((Date.now() - hit.ts) > POSTER_CACHE_TTL_MS) {
    posterCache.delete(url);
    return null;
  }
  return hit;
}

function cachePoster(url, contentType, buffer) {
  if (posterCache.size >= POSTER_CACHE_MAX) {
    const oldestKey = posterCache.keys().next().value;
    if (oldestKey) posterCache.delete(oldestKey);
  }
  posterCache.set(url, { ts: Date.now(), contentType, buffer });
}

function getMetadataCacheEntry(hash) {
  const key = String(hash || '').toLowerCase();
  if (!key || !metadataCache.data?.[key]) return null;
  const entry = metadataCache.data[key];
  const age = Date.now() - (entry._fetchedAt || 0);
  return age < METADATA_CACHE_TTL_MS ? entry : null;
}

function setMetadataCacheEntry(hash, result) {
  const key = String(hash || '').toLowerCase();
  if (!key || !result) return;
  if (!metadataCache.data) metadataCache.data = {};
  metadataCache.data[key] = result;
  metadataCache.lastFetched = Date.now();
}

function compactForMatch(value) {
  return normalizeForMatch(value).replace(/\s+/g, '');
}

function uniqueSources(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeForMatch(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractMatchSources(torrent, files) {
  const names = [
    torrent?.name,
    torrent?.content_path,
    torrent?.save_path,
    ...(files || []).map((file) => file?.name),
  ];
  return uniqueSources(names);
}

function collectVariants(item, keys) {
  const variants = new Map();
  for (const key of keys) {
    const raw = item?.[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const normalized = normalizeForMatch(raw);
    const compact = compactForMatch(raw);
    if (normalized.length >= 3) variants.set(`norm:${normalized}`, { value: normalized, kind: 'normalized' });
    if (compact.length >= 5) variants.set(`compact:${compact}`, { value: compact, kind: 'compact' });
  }
  return [...variants.values()];
}

function scoreMatch(source, sourceCompact, variant, year) {
  let score = -1;
  if (variant.kind === 'normalized' && source.includes(variant.value)) {
    score = variant.value.length * 10;
  } else if (variant.kind === 'compact' && sourceCompact.includes(variant.value)) {
    score = variant.value.length * 9;
  }
  if (score < 0) return score;
  if (year && source.includes(String(year))) score += 30;
  if (variant.kind === 'normalized' && source.startsWith(variant.value)) score += 8;
  return score;
}

function findBestMatch(items, sources, titleKeys) {
  if (!Array.isArray(items) || items.length === 0 || sources.length === 0) return null;
  const compactSources = sources.map((source) => compactForMatch(source));
  let bestMatch = null;
  let bestScore = -1;

  for (const item of items) {
    const variants = collectVariants(item, titleKeys);
    if (variants.length === 0) continue;
    const itemYear = Number.isFinite(Number(item?.year)) ? Number(item.year) : null;

    for (let i = 0; i < sources.length; i += 1) {
      for (const variant of variants) {
        const score = scoreMatch(sources[i], compactSources[i], variant, itemYear);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = item;
        }
      }
    }
  }

  return bestMatch;
}

async function getArrCatalog(kind, url) {
  const cache = arrCatalogCache[kind];
  const now = Date.now();
  if (cache.data && (now - cache.ts) < ARR_CATALOG_TTL_MS) return cache.data;
  if (cache.inflight) return cache.inflight;

  // Reuse one Arr catalog fetch across concurrent torrent lookups.
  cache.inflight = (async () => {
    try {
      const data = await fetchWithTimeout(url, 8000);
      cache.data = Array.isArray(data) ? data : [];
      cache.ts = Date.now();
      return cache.data;
    } finally {
      cache.inflight = null;
    }
  })();

  return cache.inflight;
}

function getSonarrEpisodeArtCacheKey(seriesId, season, episode) {
  return `${seriesId}:${season}:${episode ?? 'season'}`;
}

async function getSonarrEpisodeArt(seriesId, season, episode) {
  if (!SONARR_API_KEY || !seriesId || season == null) return null;

  const key = getSonarrEpisodeArtCacheKey(seriesId, season, episode);
  const cached = sonarrEpisodeArtCache.get(key);
  if (cached && (Date.now() - cached.ts) < SONARR_EPISODE_ART_TTL_MS) {
    return cached.data;
  }

  const seasonEpisodes = await fetchWithTimeout(
    `${SONARR_HOST}/api/v3/episode?seriesId=${seriesId}&seasonNumber=${season}&apikey=${SONARR_API_KEY}`,
    8000,
  );
  if (!Array.isArray(seasonEpisodes) || seasonEpisodes.length === 0) {
    sonarrEpisodeArtCache.set(key, { ts: Date.now(), data: null });
    return null;
  }

  const episodeSummary = episode != null
    ? seasonEpisodes.find((entry) => entry.episodeNumber === episode)
    : seasonEpisodes.find((entry) => entry.episodeNumber >= 1) || seasonEpisodes[0];
  // Season packs borrow the first real episode's art when no episode number is present.
  if (!episodeSummary?.id) {
    sonarrEpisodeArtCache.set(key, { ts: Date.now(), data: null });
    return null;
  }

  const episodeDetail = await fetchWithTimeout(
    `${SONARR_HOST}/api/v3/episode/${episodeSummary.id}?apikey=${SONARR_API_KEY}`,
    8000,
  );

  const data = {
    posterUrl: pickArrImageUrl(episodeDetail?.images || [], 'screenshot', 'sonarr') || null,
    episodeTitle: episode != null ? episodeDetail?.title || null : null,
    overview: episode != null ? episodeDetail?.overview || null : null,
    runtime: episodeDetail?.runtime || null,
  };
  sonarrEpisodeArtCache.set(key, { ts: Date.now(), data });
  return data;
}

async function lookupMediaInfo(hash) {
  const cached = getMetadataCacheEntry(hash);
  if (cached) return cached;

  try {
    const torrentResp = await qbFetchJson(`/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`);
    const torrents = Array.isArray(torrentResp) ? torrentResp : [];
    if (torrents.length === 0) return null;

    const torrent = torrents[0];
    let matchSources = extractMatchSources(torrent, []);

    let result = null;

    try {
      if (CONFIG.RADARR_API_KEY) {
        const movies = await getArrCatalog('movies', `${CONFIG.RADARR_HOST}/api/v3/movie?apikey=${CONFIG.RADARR_API_KEY}`);
        if (Array.isArray(movies)) {
          const match = findBestMatch(movies, matchSources, ['title', 'originalTitle', 'cleanTitle', 'sortTitle']);
          if (match) {
            result = {
              title: match.title,
              posterUrl: pickArrImageUrl(match.images, 'poster', 'radarr'),
              type: 'movie',
              year: match.year,
              tmdbId: match.tmdbId,
              imdbId: match.imdbId,
              overview: match.overview,
              genres: match.genres || [],
              ratings: match.ratings || null,
              runtime: match.runtime || null,
              quality: match.movieFile?.quality?.quality?.name || null,
              _fetchedAt: Date.now(),
            };
          }
        }
      }
    } catch { /* radarr lookup failed */ }

    if (!result && CONFIG.SONARR_API_KEY) {
      try {
        if (matchSources.length <= 2) {
          const contentResp = await qbFetchJson(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`);
          const files = Array.isArray(contentResp) ? contentResp : [];
          // qB root names are often too generic for shows; file names give Sonarr better match text.
          matchSources = extractMatchSources(torrent, files);
        }

        const series = await getArrCatalog('series', `${CONFIG.SONARR_HOST}/api/v3/series?apikey=${CONFIG.SONARR_API_KEY}`);
        if (Array.isArray(series)) {
          const match = findBestMatch(series, matchSources, ['title', 'originalTitle', 'cleanTitle', 'sortTitle']);
          if (match) {
            const sourceText = matchSources.join(' ');
            const episodeMatch = sourceText.match(/\bs(\d{1,2})e(\d{1,2})\b/i);
            const seasonPackMatch = sourceText.match(/\bs(\d{1,2})(?:\b|(?=\s|$))/i);
            const season = episodeMatch ? parseInt(episodeMatch[1], 10) : seasonPackMatch ? parseInt(seasonPackMatch[1], 10) : null;
            const episode = episodeMatch ? parseInt(episodeMatch[2], 10) : null;
            let episodeArt = null;

            if (season != null) {
              try {
                episodeArt = await getSonarrEpisodeArt(match.id, season, episode);
              } catch {
                episodeArt = null;
              }
            }

            result = {
              title: match.title,
              posterUrl: episodeArt?.posterUrl || pickArrImageUrl(match.images, 'poster', 'sonarr'),
              type: 'tv',
              season,
              episode,
              episodeNumber: episodeMatch ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : season ? `S${String(season).padStart(2, '0')}` : null,
              episodeTitle: episodeArt?.episodeTitle || null,
              year: match.year,
              tvdbId: match.tvdbId,
              tvRageId: match.tvRageId,
              overview: episodeArt?.overview || match.overview,
              network: match.network || null,
              genres: match.genres || [],
              ratings: match.ratings || null,
              runtime: episodeArt?.runtime || match.runtime || null,
              _fetchedAt: Date.now(),
            };
          }
        }
      } catch { /* sonarr lookup failed */ }
    }

    if (result) {
      setMetadataCacheEntry(hash, result);
    }

    return result;
  } catch (err) {
    console.error(`[media] lookup error for ${hash}:`, err.message);
    return null;
  }
}

router.get('/media-info/batch', async (req, res) => {
  try {
    const hashes = (req.query.hashes || '').split(',').filter(Boolean);
    const results = {};
    await Promise.all(hashes.map(async (hash) => {
      const info = await lookupMediaInfo(hash);
      if (info) {
        const { _fetchedAt, ...clean } = info;
        results[hash] = clean;
      }
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/media-info/:hash', async (req, res) => {
  try {
    const info = await lookupMediaInfo(req.params.hash);
    if (!info) return res.status(404).json({ error: 'Not found' });
    const { _fetchedAt, ...clean } = info;
    res.json(clean);
  } catch (err) {
    console.error('[media-info] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/media-cache-stats', (req, res) => {
  const cache = metadataCache.data || {};
  const now = Date.now();
  let staleCount = 0;
  for (const entry of Object.values(cache)) {
    if (now - (entry._fetchedAt || 0) > 3600000) staleCount++;
  }
  res.json({
    size: Object.keys(cache).length,
    staleCount,
    posterCacheSize: posterCache.size,
    lastFetched: metadataCache.lastFetched || 0,
    age: metadataCache.lastFetched ? now - metadataCache.lastFetched : -1,
  });
});

router.get('/poster', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const parsed = new URL(url);
    if (!isAllowedPosterHost(parsed.hostname)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
    const cached = getCachedPoster(url);
    if (cached) {
      res.set('Content-Type', cached.contentType);
      res.set('Content-Length', String(cached.buffer.length));
      res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return res.end(cached.buffer);
    }
    const resp = await fetch(url, { headers: { 'User-Agent': 'vibarr/1.0' } });
    if (!resp.ok) return res.status(502).json({ error: 'Failed to fetch poster' });
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return res.status(502).json({ error: 'Poster upstream did not return an image' });
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    cachePoster(url, contentType, buffer);
    res.set('Content-Type', contentType);
    res.set('Content-Length', String(buffer.length));
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.end(buffer);
  } catch (err) {
    res.status(400).json({ error: 'Invalid URL' });
  }
});

router.get('/arr-image/:service/*', async (req, res) => {
  const { service } = req.params;
  const imagePath = req.params[0];
  if (!imagePath) return res.status(400).json({ error: 'Missing image path' });

  const config = {
    radarr: { host: RADARR_HOST, key: CONFIG.RADARR_API_KEY },
    sonarr: { host: SONARR_HOST, key: CONFIG.SONARR_API_KEY },
    lidarr: { host: CONFIG.LIDARR_HOST, key: CONFIG.LIDARR_API_KEY },
  }[service];

  if (!config) return res.status(400).json({ error: 'Unknown service' });
  if (!config.key) return res.status(503).json({ error: `${service} not configured` });

  try {
    const basePath = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const url = `${config.host}${basePath}${query}`;
    const resp = await fetch(url, { headers: { 'X-Api-Key': config.key } });
    if (!resp.ok) return res.status(502).json({ error: 'Failed to fetch image' });
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return res.status(502).json({ error: 'Arr image upstream did not return an image' });
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    Readable.fromWeb(resp.body).pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/sort-history', async (req, res) => {
  if (!CONFIG.MEDIA_SORTER_HOST) return res.json([]);
  try {
    const data = await fetchWithTimeout(`${CONFIG.MEDIA_SORTER_HOST}/api/history?limit=50`, 5000);
    res.json(Array.isArray(data) ? data : []);
  } catch {
    res.json([]);
  }
});

export default router;
