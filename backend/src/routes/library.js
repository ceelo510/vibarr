import { Router } from 'express';
import { CONFIG, TIMING, getDefaultRootFolder } from '../config.js';
import {
  fetchWithTimeout, pickImageUrl, pickArrImageUrl,
  parseArrError, normalizeForMatch,
} from '../utils.js';
import {
  logActivity, updateLogEntry, addLogStep,
  libraryCache, setLibraryCache, itunesPosterCache,
  addPipelineItem, advancePipeline, registerInterval,
} from '../state.js';
import { searchAndDownloadSlskd } from './slskd.js';
import { execFileSync } from 'child_process';
import { statSync } from 'fs';

const router = Router();

const {
  RADARR_HOST, RADARR_API_KEY,
  SONARR_HOST, SONARR_API_KEY,
  LIDARR_HOST, LIDARR_API_KEY,
  SLSKD_API_KEY,
} = CONFIG;
const LIBRARY_SEARCH_TYPES = Object.freeze({
  series: { responseKey: 'series', stateKey: 'series', service: 'sonarr' },
  movie: { responseKey: 'movies', stateKey: 'movies', service: 'radarr' },
  music: { responseKey: 'artists', stateKey: 'artists', service: 'lidarr' },
});

function buildServiceErrorPayload(service, code, message, details, extra = {}) {
  return {
    error: message,
    service,
    code,
    details,
    retryable: code !== 'unconfigured',
    ...extra,
  };
}

function sendServiceError(res, service, statusCode, code, message, details, extra = {}) {
  return res.status(statusCode).json(buildServiceErrorPayload(service, code, message, details, extra));
}

function getRequestedLibrarySearchTypes(type) {
  if (type === 'all') return Object.keys(LIBRARY_SEARCH_TYPES);
  return LIBRARY_SEARCH_TYPES[type] ? [type] : [];
}

// ─── Library Cache Refresh ──────────────────────────────────────────────────

let libraryCacheRefreshInterval = null;
let libraryCacheRefreshPromise = null;

export async function refreshLibraryCache() {
  if (libraryCacheRefreshPromise) return libraryCacheRefreshPromise;

  libraryCacheRefreshPromise = (async () => {
    const nextCache = {
      movies: libraryCache.movies,
      series: libraryCache.series,
      artists: libraryCache.artists,
      albums: libraryCache.albums || [],
      lastRefresh: libraryCache.lastRefresh || null,
      serviceStates: {
        series: SONARR_API_KEY ? { status: 'stale', error: null } : { status: 'unconfigured', error: null },
        movies: RADARR_API_KEY ? { status: 'stale', error: null } : { status: 'unconfigured', error: null },
        artists: LIDARR_API_KEY ? { status: 'stale', error: null } : { status: 'unconfigured', error: null },
      },
    };
    let refreshedSectionCount = 0;
    const tasks = [];

    if (SONARR_API_KEY) {
      tasks.push((async () => {
        try {
          const series = await fetchWithTimeout(`${SONARR_HOST}/api/v3/series?apikey=${SONARR_API_KEY}`, 10000);
          nextCache.series = series.map(s => ({
            id: s.id, tvdbId: s.tvdbId, title: s.title, sortTitle: s.sortTitle,
            year: s.year, overview: s.overview, network: s.network,
            genres: s.genres || [], ratings: s.ratings,
            seasonCount: s.statistics?.seasonCount || s.seasonCount || 0,
            totalEpisodeCount: s.statistics?.totalEpisodeCount || 0,
            episodeFileCount: s.statistics?.episodeFileCount || 0,
            sizeOnDisk: s.statistics?.sizeOnDisk || 0,
            posterUrl: pickArrImageUrl(s.images, 'poster', 'sonarr'),
            status: s.status, path: s.path, monitored: s.monitored,
          }));
          nextCache.serviceStates.series = { status: 'ready', error: null };
          refreshedSectionCount++;
        } catch (err) {
          nextCache.serviceStates.series = { status: 'error', error: err.message };
          console.error('Library cache - Sonarr:', err.message);
        }
      })());
    }

    if (RADARR_API_KEY) {
      tasks.push((async () => {
        try {
          const movies = await fetchWithTimeout(`${RADARR_HOST}/api/v3/movie?apikey=${RADARR_API_KEY}`, 10000);
          nextCache.movies = movies.map(m => ({
            id: m.id, tmdbId: m.tmdbId, title: m.title, sortTitle: m.sortTitle,
            year: m.year, overview: m.overview, genres: m.genres || [],
            ratings: m.ratings, runtime: m.runtime,
            posterUrl: pickArrImageUrl(m.images, 'poster', 'radarr'),
            hasFile: m.hasFile, monitored: m.monitored, status: m.status,
            path: m.path, sizeOnDisk: m.sizeOnDisk || 0,
            quality: m.movieFile?.quality?.quality?.name || null,
          }));
          nextCache.serviceStates.movies = { status: 'ready', error: null };
          refreshedSectionCount++;
        } catch (err) {
          nextCache.serviceStates.movies = { status: 'error', error: err.message };
          console.error('Library cache - Radarr:', err.message);
        }
      })());
    }

    if (LIDARR_API_KEY) {
      tasks.push((async () => {
        try {
          const artists = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/artist?apikey=${LIDARR_API_KEY}`, 10000);
          const artistList = artists.map(a => ({
            id: a.id, foreignArtistId: a.foreignArtistId,
            artistName: a.artistName, sortName: a.sortName,
            overview: a.overview, genres: a.genres || [],
            posterUrl: pickImageUrl(a.images, 'poster') || pickImageUrl(a.images, 'cover') || null,
            monitored: a.monitored, status: a.status, path: a.path,
            albumCount: a.statistics?.albumCount || 0,
            trackFileCount: a.statistics?.trackFileCount || 0,
            trackCount: a.statistics?.trackCount || 0,
            sizeOnDisk: a.statistics?.sizeOnDisk || 0,
          }));
          const noPoster = artistList.filter(a => !a.posterUrl);
          if (noPoster.length > 0) {
            await Promise.allSettled(noPoster.map(async (a) => {
              try {
                const albums = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/album?artistId=${a.id}&apikey=${LIDARR_API_KEY}`, 10000);
                for (const alb of albums) {
                  const cover = pickImageUrl(alb.images, 'cover');
                  if (cover) { a.posterUrl = cover; break; }
                }
              } catch {}
            }));
          }
          // Lidarr artist records often lack art; borrow the first album cover so library cards stay populated.
          nextCache.artists = artistList;
          try {
            const allAlbums = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/album?apikey=${LIDARR_API_KEY}`, 15000);
            const downloadedByArtist = {};
            allAlbums.forEach(a => {
              if ((a.statistics?.trackFileCount || 0) > 0)
                downloadedByArtist[a.artistId] = (downloadedByArtist[a.artistId] || 0) + 1;
            });
            artistList.forEach(a => { a.downloadedAlbumCount = downloadedByArtist[a.id] || 0; });
            // Keep the lightweight library cache scoped to albums that already have files on disk.
            nextCache.albums = allAlbums
              .filter(a => (a.statistics?.trackFileCount || 0) > 0)
              .map(a => ({
                id: a.id, title: a.title, artistId: a.artistId,
                coverUrl: pickImageUrl(a.images, 'cover') || null,
              }));
          } catch (e) {
            console.error('Library cache - Lidarr albums:', e.message);
          }
          nextCache.serviceStates.artists = { status: 'ready', error: null };
          refreshedSectionCount++;
        } catch (err) {
          nextCache.serviceStates.artists = { status: 'error', error: err.message };
          console.error('Library cache - Lidarr:', err.message);
        }
      })());
    }

    await Promise.allSettled(tasks);
    if (refreshedSectionCount > 0) {
      nextCache.lastRefresh = new Date().toISOString();
    }
    setLibraryCache(nextCache);
    return nextCache;
  })().finally(() => {
    libraryCacheRefreshPromise = null;
  });

  return libraryCacheRefreshPromise;
}

refreshLibraryCache();
registerInterval(setInterval(refreshLibraryCache, 60000));

// ─── Routes ─────────────────────────────────────────────────────────────────

router.get('/library/refresh', async (req, res) => {
  const cache = await refreshLibraryCache();
  res.json({ ok: true, lastRefresh: cache.lastRefresh, serviceStates: cache.serviceStates });
});

router.get('/library/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const type = req.query.type || 'all';
  const results = { series: [], movies: [], artists: [] };

  if (type === 'all' || type === 'series') {
    results.series = libraryCache.series
      .filter(s => !q || s.title.toLowerCase().includes(q))
      .sort((a, b) => a.sortTitle.localeCompare(b.sortTitle))
      .slice(0, 50);
  }
  if (type === 'all' || type === 'movie') {
    results.movies = libraryCache.movies
      .filter(m => !q || m.title.toLowerCase().includes(q))
      .sort((a, b) => a.sortTitle.localeCompare(b.sortTitle))
      .slice(0, 50);
  }
  if (type === 'all' || type === 'music') {
    results.artists = libraryCache.artists
      .filter(a => !q || a.artistName.toLowerCase().includes(q))
      .sort((a, b) => (a.sortName || a.artistName).localeCompare(b.sortName || b.artistName))
      .slice(0, 50);
  }
  const requestedTypes = getRequestedLibrarySearchTypes(type);
  const serviceErrors = {};
  for (const requestedType of requestedTypes) {
    const mapping = LIBRARY_SEARCH_TYPES[requestedType];
    const state = libraryCache.serviceStates?.[mapping.stateKey];
    if (!state || !['error', 'unconfigured'].includes(state.status)) continue;
    if ((results[mapping.responseKey] || []).length > 0) continue;
    serviceErrors[mapping.responseKey] = {
      service: mapping.service,
      status: state.status,
      error: state.error,
    };
  }
  res.json({
    ...results,
    serviceStates: libraryCache.serviceStates,
    serviceErrors,
    hasServiceErrors: Object.keys(serviceErrors).length > 0,
    requestedTypes,
    lastRefresh: libraryCache.lastRefresh || null,
  });
});

router.get('/library/series/:id/episodes', async (req, res) => {
  if (!SONARR_API_KEY) return res.status(503).json({ error: 'Sonarr not configured' });
  try {
    const sid = encodeURIComponent(req.params.id);
    const [episodes, episodeFiles] = await Promise.all([
      fetchWithTimeout(`${SONARR_HOST}/api/v3/episode?seriesId=${sid}&apikey=${SONARR_API_KEY}`, 10000),
      fetchWithTimeout(`${SONARR_HOST}/api/v3/episodefile?seriesId=${sid}&apikey=${SONARR_API_KEY}`, 10000),
    ]);
    const fileMap = {};
    (Array.isArray(episodeFiles) ? episodeFiles : []).forEach(f => { fileMap[f.id] = f; });
    const seasons = {};
    episodes.forEach(ep => {
      const sn = ep.seasonNumber;
      if (!seasons[sn]) seasons[sn] = [];
      const ef = ep.episodeFileId ? fileMap[ep.episodeFileId] : null;
      const mi = ef?.mediaInfo || {};
      seasons[sn].push({
        id: ep.id, episodeNumber: ep.episodeNumber, title: ep.title,
        airDate: ep.airDateUtc, hasFile: ep.hasFile, monitored: ep.monitored,
        overview: ep.overview,
        runtime: ep.runtime || null,
        quality: ef?.quality?.quality?.name || null,
        size: ef?.size || 0,
        filePath: ef?.path || null,
        relativePath: ef?.relativePath || null,
        videoCodec: mi.videoCodec || null,
        videoFps: mi.videoFps || null,
        resolution: mi.resolution || null,
        audioCodec: mi.audioCodec || null,
        audioChannels: mi.audioChannels || null,
        audioLanguages: mi.audioLanguages || null,
        runTime: mi.runTime || null,
        subtitles: mi.subtitles || null,
        dynamicRange: mi.videoDynamicRangeType || null,
        imageUrl: null,
      });
    });
    Object.values(seasons).forEach(eps => eps.sort((a, b) => a.episodeNumber - b.episodeNumber));

    // Sonarr only exposes screenshot URLs on the per-episode resource, so enrich file-backed episodes in a second pass.
    const epIdsNeedingImages = [];
    for (const eps of Object.values(seasons)) {
      for (const ep of eps) {
        if (ep.hasFile && ep.id) epIdsNeedingImages.push(ep.id);
      }
    }
    if (epIdsNeedingImages.length > 0) {
      const imageMap = {};
      const BATCH_SIZE = 15;
      for (let i = 0; i < epIdsNeedingImages.length; i += BATCH_SIZE) {
        const batch = epIdsNeedingImages.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(eid => fetchWithTimeout(SONARR_HOST + '/api/v3/episode/' + eid + '?apikey=' + SONARR_API_KEY, 5000))
        );
        results.forEach((result, j) => {
          if (result.status === 'fulfilled' && result.value && result.value.images && result.value.images.length > 0) {
            const sshot = result.value.images.find(img => img.coverType === 'screenshot');
            if (sshot && sshot.remoteUrl) {
              imageMap[batch[j]] = '/api/poster?url=' + encodeURIComponent(sshot.remoteUrl);
            }
          }
        });
      }
      for (const eps of Object.values(seasons)) {
        for (const ep of eps) {
          if (imageMap[ep.id]) ep.imageUrl = imageMap[ep.id];
        }
      }
    }

    res.json({ seasons });
  } catch (err) {
    console.error('Episode fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch episodes' });
  }
});

router.get('/library/movie/:id/file', async (req, res) => {
  if (!RADARR_API_KEY) return res.status(503).json({ error: 'Radarr not configured' });
  try {
    const files = await fetchWithTimeout(
      `${RADARR_HOST}/api/v3/moviefile?movieId=${encodeURIComponent(req.params.id)}&apikey=${RADARR_API_KEY}`, 8000
    );
    const f = Array.isArray(files) ? files[0] : files;
    if (!f) return res.json(null);
    const mi = f.mediaInfo || {};
    res.json({
      path: f.path || null,
      relativePath: f.relativePath || null,
      size: f.size || 0,
      quality: f.quality?.quality?.name || null,
      videoCodec: mi.videoCodec || null,
      videoFps: mi.videoFps || null,
      resolution: mi.resolution || null,
      audioCodec: mi.audioCodec || null,
      audioChannels: mi.audioChannels || null,
      audioLanguages: mi.audioLanguages || null,
      runTime: mi.runTime || null,
      subtitles: mi.subtitles || null,
      videoBitDepth: mi.videoBitDepth || null,
      dynamicRange: mi.videoDynamicRangeType || null,
    });
  } catch (err) {
    console.error('Movie file info error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.get('/library/artists/:id/files', async (req, res) => {
  if (!LIDARR_API_KEY) return res.status(503).json({ error: 'Lidarr not configured' });
  try {
    const artist = await fetchWithTimeout(
      `${LIDARR_HOST}/api/v1/artist/${encodeURIComponent(req.params.id)}?apikey=${LIDARR_API_KEY}`, 10000
    );
    const artistPath = artist.path;
    if (!artistPath) return res.json({ path: null, folders: [] });

    const hostPath = artistPath.replace(/^\/data\//, '/hostdocker/');
    let folders = [];
    try {
      const lsOut = execFileSync('find', [hostPath, '-type', 'f'], { encoding: 'utf8', timeout: 10000 });
      const files = lsOut.trim().split('\n').filter(Boolean);
      const grouped = {};
      for (const f of files) {
        const rel = f.replace(hostPath + '/', '');
        const parts = rel.split('/');
        const folder = parts.length > 1 ? parts[0] : '.';
        if (!grouped[folder]) grouped[folder] = [];
        grouped[folder].push({
          name: parts[parts.length - 1],
          path: rel,
          size: (() => { try { return statSync(f).size; } catch { return 0; } })(),
        });
      }
      folders = Object.entries(grouped).map(([name, files]) => ({
        name,
        fileCount: files.length,
        totalSize: files.reduce((s, f) => s + f.size, 0),
        files,
      })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.error('File tree error:', e.message);
    }
    res.json({ path: artistPath, folders });
  } catch (err) {
    console.error('Artist file tree error:', err.message);
    res.status(502).json({ error: 'Failed to fetch file tree' });
  }
});

router.get('/library/artists/:id/albums', async (req, res) => {
  if (!LIDARR_API_KEY) return res.status(503).json({ error: 'Lidarr not configured' });
  try {
    const [albums, artist] = await Promise.all([
      fetchWithTimeout(`${LIDARR_HOST}/api/v1/album?artistId=${encodeURIComponent(req.params.id)}&apikey=${LIDARR_API_KEY}`, 10000),
      fetchWithTimeout(`${LIDARR_HOST}/api/v1/artist/${encodeURIComponent(req.params.id)}?apikey=${LIDARR_API_KEY}`, 10000).catch(() => null),
    ]);
    const formatted = albums.map(a => ({
      id: a.id, title: a.title, releaseDate: a.releaseDate,
      genres: a.genres || [], overview: a.overview, monitored: a.monitored,
      albumType: a.albumType || 'Album',
      coverUrl: pickImageUrl(a.images, 'cover'),
      trackCount: a.statistics?.trackCount || 0,
      trackFileCount: a.statistics?.trackFileCount || 0,
      sizeOnDisk: a.statistics?.sizeOnDisk || 0,
      percentOfTracks: a.statistics?.percentOfTracks || 0,
    }));
    formatted.sort((a, b) => new Date(b.releaseDate || 0) - new Date(a.releaseDate || 0));
    res.json({
      albums: formatted,
      artist: artist ? {
        id: artist.id,
        foreignArtistId: artist.foreignArtistId,
        artistName: artist.artistName,
        metadataProfileId: artist.metadataProfileId,
      } : null,
    });
  } catch (err) {
    console.error('Album fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch albums' });
  }
});

async function ensureExtendedMetadataProfile() {
  const profiles = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/metadataprofile?apikey=${LIDARR_API_KEY}`, 10000);
  // Selective album adds depend on Lidarr seeing EPs and singles, not just the default album set.
  const wantPrimary = new Set(['Album', 'EP', 'Single']);
  const matching = profiles.find(p => {
    const primAllowed = new Set((p.primaryAlbumTypes || []).filter(t => t.allowed).map(t => t.albumType?.name));
    return [...wantPrimary].every(n => primAllowed.has(n));
  });
  if (matching) return matching.id;
  const base = profiles[0];
  if (!base) throw new Error('No Lidarr metadata profile to clone');
  const newProf = {
    name: 'Standard Extended',
    primaryAlbumTypes: (base.primaryAlbumTypes || []).map(t => ({
      ...t,
      allowed: ['Album', 'EP', 'Single'].includes(t.albumType?.name),
    })),
    secondaryAlbumTypes: (base.secondaryAlbumTypes || []).map(t => ({
      ...t,
      allowed: t.albumType?.name === 'Studio' ? true : !!t.allowed,
    })),
    releaseStatuses: (base.releaseStatuses || []).map(t => ({
      ...t,
      allowed: t.releaseStatus?.name === 'Official' ? true : !!t.allowed,
    })),
  };
  const resp = await fetch(`${LIDARR_HOST}/api/v1/metadataprofile?apikey=${LIDARR_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newProf),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Create metadata profile failed: HTTP ${resp.status} ${txt.substring(0, 120)}`);
  }
  const created = await resp.json();
  return created.id;
}

router.post('/library/artists/:id/albums/add', async (req, res) => {
  if (!LIDARR_API_KEY) return res.status(503).json({ error: 'Lidarr not configured' });
  const { selectedAlbumTitles } = req.body || {};
  if (!Array.isArray(selectedAlbumTitles) || selectedAlbumTitles.length === 0) {
    return res.status(400).json({ error: 'selectedAlbumTitles required' });
  }
  const artistId = req.params.id;
  let logId = null;

  try {
    const artist = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/artist/${encodeURIComponent(artistId)}?apikey=${LIDARR_API_KEY}`, 10000);
    if (!artist?.id) return res.status(404).json({ error: 'Artist not found' });

    logId = logActivity('add', `Adding ${selectedAlbumTitles.length} extra album(s) to "${artist.artistName}"...`,
      { artistId: artist.id, count: selectedAlbumTitles.length }, 'pending',
      { service: 'lidarr', artistName: artist.artistName });

    let profileBumped = false;
    try {
      const extId = await ensureExtendedMetadataProfile();
      if (artist.metadataProfileId !== extId) {
        artist.metadataProfileId = extId;
        const putResp = await fetch(`${LIDARR_HOST}/api/v1/artist/${artist.id}?apikey=${LIDARR_API_KEY}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(artist),
        });
        if (putResp.ok) { profileBumped = true; addLogStep(logId, 'Switched artist to extended metadata profile (Album+EP+Single)', 'success'); }
        else addLogStep(logId, `Warning: could not switch metadata profile (HTTP ${putResp.status})`, 'warning');
      }
    } catch (e) {
      addLogStep(logId, `Metadata profile setup failed: ${e.message}`, 'warning');
    }

    if (profileBumped) {
      try {
        const r = await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'RefreshArtist', artistId: artist.id }),
        });
        if (!r.ok) addLogStep(logId, `Warning: RefreshArtist HTTP ${r.status}`, 'warning');
        else addLogStep(logId, 'Refreshing artist metadata...', 'pending');
      } catch (e) {
        addLogStep(logId, `RefreshArtist failed: ${e.message}`, 'warning');
      }
    }

    const normalize = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\[.*?\]\s*/g, ' ')
      .replace(/ - (single|ep)$/i, '').replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ').trim();

    const targetNorms = selectedAlbumTitles.map(t => ({ original: t, norm: normalize(t) }));

    let albums = [];
    const pollCount = profileBumped ? 15 : 1;
    for (let attempt = 0; attempt < pollCount; attempt++) {
      try {
        albums = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/album?artistId=${artist.id}&apikey=${LIDARR_API_KEY}`, 10000);
      } catch (e) { }
      const matchedAll = targetNorms.every(sel =>
        albums.some(a => {
          const an = normalize(a.title);
          if (an === sel.norm) return true;
          if (sel.norm.length < 3 || an.length < 3) return false;
          const shorter = sel.norm.length <= an.length ? sel.norm : an;
          const longer = sel.norm.length > an.length ? sel.norm : an;
          if (shorter.length / longer.length < 0.6) return false;
          return longer.includes(shorter);
        })
      );
      if (matchedAll) break;
      if (attempt < pollCount - 1) await new Promise(r => setTimeout(r, 2000));
    }
    addLogStep(logId, `Lidarr now reports ${albums.length} total album(s) for artist`, 'pending');

    const matched = [];
    const matchedOriginals = new Set();
    const albumsWithMatches = albums.map(album => {
      const albumNorm = normalize(album.title || '');
      const matchEntry = targetNorms.find(sel => sel.norm === albumNorm) ||
        targetNorms.find(sel => {
          if (sel.norm.length < 3 || albumNorm.length < 3) return false;
          const shorter = sel.norm.length <= albumNorm.length ? sel.norm : albumNorm;
          const longer = sel.norm.length > albumNorm.length ? sel.norm : albumNorm;
          if (shorter.length / longer.length < 0.6) return false;
          return longer.includes(shorter);
        });
      return { album, matchEntry };
    }).filter(({ matchEntry }) => matchEntry != null);

    const albumsToSearch = [];
    await Promise.all(albumsWithMatches.map(async ({ album, matchEntry }) => {
      matchedOriginals.add(matchEntry.original);
      if (!album.monitored) {
        album.monitored = true;
        try {
          await fetch(`${LIDARR_HOST}/api/v1/album/${album.id}?apikey=${LIDARR_API_KEY}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(album),
          });
        } catch (e) {
          addLogStep(logId, `Failed to monitor "${album.title}": ${e.message}`, 'error');
          return;
        }
      }
      matched.push(album.title);
      albumsToSearch.push({ id: album.id, title: album.title });
    }));

    const unmatchedAlbumTitles = selectedAlbumTitles.filter(t => !matchedOriginals.has(t));
    if (matched.length > 0) addLogStep(logId, `Monitoring ${matched.length} album(s): ${matched.join(', ')}`, 'success');
    if (unmatchedAlbumTitles.length > 0) addLogStep(logId, `${unmatchedAlbumTitles.length} not in Lidarr (will try Soulseek): ${unmatchedAlbumTitles.join(', ')}`, 'warning');

    if (albumsToSearch.length > 0) {
      try {
        const r = await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'AlbumSearch', albumIds: albumsToSearch.map(a => a.id) }),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => '');
          addLogStep(logId, `Lidarr search HTTP ${r.status} ${txt.substring(0, 100)}`, 'error');
        } else {
          addLogStep(logId, `Lidarr search triggered for ${albumsToSearch.length} album(s)`, 'success');
        }
      } catch (e) {
        addLogStep(logId, `Lidarr search failed: ${e.message}`, 'error');
      }
    }

    if (SLSKD_API_KEY) {
      const searchAlbums = [
        ...albumsToSearch,
        ...unmatchedAlbumTitles.map(t => ({ id: null, title: t })),
      ];
      const resolvedArtistName = artist.artistName;
      (async () => {
        addLogStep(logId, `Starting Soulseek search for ${searchAlbums.length} album(s)...`, 'pending');
        let queued = 0; let failed = 0;
        for (const album of searchAlbums) {
          try {
            const dl = await searchAndDownloadSlskd(resolvedArtistName, album.title, logId, artist.id, album.id);
            if (dl.success) queued++; else failed++;
          } catch { failed++; }
          await new Promise(r => setTimeout(r, 1500));
        }
        if (queued > 0) {
          updateLogEntry(logId, { status: 'success', message: `"${resolvedArtistName}" — ${queued} extra album(s) downloading` });
        } else {
          addLogStep(logId, `Soulseek queued nothing (failed: ${failed})`, 'warning');
        }
      })().catch(err => {
        addLogStep(logId, `Soulseek background error: ${err.message}`, 'error');
      });
    }

    refreshLibraryCache();
    res.json({
      success: true,
      monitored: albumsToSearch.length,
      unmatched: unmatchedAlbumTitles,
      profileBumped,
    });
  } catch (err) {
    if (logId) updateLogEntry(logId, { status: 'error', message: `Add extra albums failed: ${err.message}` });
    console.error('Add extra albums error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// APPENDED ROUTES — Lookup, Profiles, Add, Delete
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Lookup ─────────────────────────────────────────────────────────────────

router.get('/lookup/movie', async (req, res) => {
  if (!RADARR_API_KEY) {
    return sendServiceError(res, 'radarr', 503, 'unconfigured', 'Radarr not configured', null);
  }
  const term = req.query.term;
  if (!term) return res.status(400).json({ error: 'Missing term' });
  try {
    const results = await fetchWithTimeout(
      `${RADARR_HOST}/api/v3/movie/lookup?term=${encodeURIComponent(term)}&apikey=${RADARR_API_KEY}`, 10000
    );
    res.json(results.slice(0, 20).map(m => ({
      tmdbId: m.tmdbId, imdbId: m.imdbId, title: m.title, year: m.year,
      overview: m.overview, genres: m.genres || [], ratings: m.ratings,
      runtime: m.runtime, studio: m.studio,
      posterUrl: pickImageUrl(m.images, 'poster'),
      inLibrary: libraryCache.movies.some(lm => lm.tmdbId === m.tmdbId),
    })));
  } catch (err) {
    console.error('Movie lookup error:', err.message);
    return sendServiceError(res, 'radarr', 502, 'lookup_failed', 'Radarr lookup failed', err.message);
  }
});

router.get('/lookup/series', async (req, res) => {
  if (!SONARR_API_KEY) {
    return sendServiceError(res, 'sonarr', 503, 'unconfigured', 'Sonarr not configured', null);
  }
  const term = req.query.term;
  if (!term) return res.status(400).json({ error: 'Missing term' });
  try {
    const results = await fetchWithTimeout(
      `${SONARR_HOST}/api/v3/series/lookup?term=${encodeURIComponent(term)}&apikey=${SONARR_API_KEY}`, 10000
    );
    res.json(results.slice(0, 20).map(s => ({
      tvdbId: s.tvdbId, title: s.title, year: s.year,
      overview: s.overview, genres: s.genres || [], ratings: s.ratings,
      network: s.network, seasonCount: s.seasonCount,
      posterUrl: pickImageUrl(s.images, 'poster'),
      inLibrary: libraryCache.series.some(ls => ls.tvdbId === s.tvdbId),
      seasons: (s.seasons || []).map(sn => ({
        seasonNumber: sn.seasonNumber,
        monitored: sn.monitored,
        episodeCount: sn.statistics?.totalEpisodeCount || 0,
      })),
    })));
  } catch (err) {
    console.error('Series lookup error:', err.message);
    return sendServiceError(res, 'sonarr', 502, 'lookup_failed', 'Sonarr lookup failed', err.message);
  }
});

router.get('/lookup/music', async (req, res) => {
  if (!LIDARR_API_KEY) {
    return sendServiceError(res, 'lidarr', 503, 'unconfigured', 'Lidarr not configured', null, {
      artists: [],
      albums: [],
      singles: [],
      topCategory: 'artists',
    });
  }
  const term = req.query.term;
  if (!term) return res.status(400).json({ error: 'Missing term' });

  const simScore = (query, target) => {
    const q = query.toLowerCase().trim();
    const t = target.toLowerCase().trim();
    if (q === t) return 1.0;
    if (t.startsWith(q) || q.startsWith(t)) return 0.9;
    if (t.includes(q) || q.includes(t)) return 0.8;
    const qw = new Set(q.split(/\s+/));
    const tw = new Set(t.split(/\s+/));
    const common = [...qw].filter(w => tw.has(w)).length;
    const union = new Set([...qw, ...tw]).size;
    return union > 0 ? common / union : 0;
  };

  try {
    const [rawArtists, rawAlbums] = await Promise.all([
      fetchWithTimeout(`${LIDARR_HOST}/api/v1/artist/lookup?term=${encodeURIComponent(term)}&apikey=${LIDARR_API_KEY}`, 10000),
      fetchWithTimeout(`${LIDARR_HOST}/api/v1/album/lookup?term=${encodeURIComponent(term)}&apikey=${LIDARR_API_KEY}`, 10000).catch(() => []),
    ]);

    const artistResults = (rawArtists || []).slice(0, 15).map(a => ({
      foreignArtistId: a.foreignArtistId, artistName: a.artistName,
      overview: a.overview, genres: a.genres || [],
      disambiguation: a.disambiguation, artistType: a.artistType,
      posterUrl: pickImageUrl(a.images, 'poster') || pickImageUrl(a.images, 'cover') || null,
      inLibrary: libraryCache.artists.some(la => la.foreignArtistId === a.foreignArtistId),
      score: simScore(term, a.artistName),
    }));

    const albumResults = [];
    const singleResults = [];
    for (const a of (rawAlbums || []).slice(0, 30)) {
      const artist = a.artist || {};
      const isInLibrary = libraryCache.artists.some(la => la.foreignArtistId === artist.foreignArtistId);
      const item = {
        foreignAlbumId: a.foreignAlbumId,
        title: a.title, disambiguation: a.disambiguation || '',
        releaseDate: a.releaseDate,
        albumType: a.albumType || 'Album',
        genres: a.genres || [],
        artistName: artist.artistName || '',
        foreignArtistId: artist.foreignArtistId || '',
        posterUrl: pickImageUrl(a.images, 'cover') || null,
        inLibrary: isInLibrary,
        score: simScore(term, a.title),
      };
      if (a.albumType === 'Single' || a.albumType === 'EP') singleResults.push(item);
      else albumResults.push(item);
    }

    const noPoster = artistResults.filter(r => !r.posterUrl).slice(0, 5);
    for (const artist of noPoster) {
      const hit = itunesPosterCache.get(artist.artistName);
      if (hit && (Date.now() - hit.ts < 3600000)) { if (hit.url) artist.posterUrl = hit.url; continue; }
      try {
        const itunes = await fetchWithTimeout(
          'https://itunes.apple.com/search?term=' + encodeURIComponent(artist.artistName) + '&entity=album&limit=1', 5000
        );
        const url = (itunes.results && itunes.results[0] && itunes.results[0].artworkUrl100)
          ? itunes.results[0].artworkUrl100.replace('100x100', '600x600') : null;
        itunesPosterCache.set(artist.artistName, { url, ts: Date.now() });
        if (url) artist.posterUrl = url;
      } catch {}
      await new Promise(r => setTimeout(r, 150));
    }

    const topArtistScore = Math.max(0, ...artistResults.map(r => r.score));
    const topAlbumScore = Math.max(0, ...albumResults.map(r => r.score));
    const topSingleScore = Math.max(0, ...singleResults.map(r => r.score));
    const maxScore = Math.max(topArtistScore, topAlbumScore, topSingleScore);
    let topCategory = 'artists';
    if (topAlbumScore === maxScore && topAlbumScore > topArtistScore) topCategory = 'albums';
    else if (topSingleScore === maxScore && topSingleScore > topArtistScore) topCategory = 'singles';

    artistResults.sort((a, b) => b.score - a.score);
    albumResults.sort((a, b) => b.score - a.score);
    singleResults.sort((a, b) => b.score - a.score);

    res.json({ artists: artistResults, albums: albumResults, singles: singleResults, topCategory });
  } catch (err) {
    console.error('Music lookup error:', err.message);
    return sendServiceError(res, 'lidarr', 502, 'lookup_failed', 'Lidarr lookup failed', err.message, {
      artists: [],
      albums: [],
      singles: [],
      topCategory: 'artists',
    });
  }
});

router.get('/lookup/music/albums', async (req, res) => {
  const { artistName, foreignArtistId } = req.query;
  if (!artistName) return res.status(400).json({ error: 'Missing artistName' });
  const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.\-']/g, '').replace(/\s+/g, ' ').trim();
  const dedup = s => normalize(s.replace(/ - (Single|EP)$/i, '').replace(/\s*\((?:apple music edition|deluxe|deluxe edition|remastered|expanded|bonus track).*?\)$/i, ''));
  const nameNorm = normalize(artistName);

  try {
    const itunesArtistSearch = fetchWithTimeout(
      `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=musicArtist&limit=5`, 10000
    ).catch(() => ({ results: [] }));

    const mbPromise = foreignArtistId
      ? fetchWithTimeout(
          `https://musicbrainz.org/ws/2/release-group?artist=${foreignArtistId}&fmt=json&limit=100`,
          10000,
          { 'User-Agent': 'vibarr/1.0 (music lookup)' }
        ).catch(() => ({ 'release-groups': [] }))
      : Promise.resolve({ 'release-groups': [] });

    const [itunesArtists, mbData] = await Promise.all([itunesArtistSearch, mbPromise]);

    const itunesArtist = (itunesArtists.results || []).find(a =>
      normalize(a.artistName) === nameNorm
    ) || (itunesArtists.results || [])[0];

    let itunesAlbums = [];
    if (itunesArtist?.artistId) {
      try {
        const lookupData = await fetchWithTimeout(
          `https://itunes.apple.com/lookup?id=${itunesArtist.artistId}&entity=album&limit=200`, 15000
        );
        itunesAlbums = (lookupData.results || []).filter(r => r.wrapperType === 'collection');
      } catch {}
    }

    let searchAlbums = [];
    try {
      const searchData = await fetchWithTimeout(
        `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=album&limit=200`, 10000
      );
      searchAlbums = (searchData.results || []).filter(a => normalize(a.artistName) === nameNorm);
    } catch {}

    const seenIds = new Set();
    const allItunes = [];
    for (const a of [...itunesAlbums, ...searchAlbums]) {
      if (!seenIds.has(a.collectionId)) {
        seenIds.add(a.collectionId);
        const titleLower = a.collectionName.toLowerCase();
        let albumType = 'Album';
        if (titleLower.includes('- single')) albumType = 'Single';
        else if (titleLower.includes('- ep') || titleLower.endsWith(' ep')) albumType = 'EP';
        allItunes.push({
          id: 'itunes-' + a.collectionId,
          title: a.collectionName,
          releaseDate: a.releaseDate || null,
          trackCount: a.trackCount || 0,
          albumType,
          coverUrl: a.artworkUrl100 ? a.artworkUrl100.replace('100x100', '600x600') : null,
          source: 'itunes',
        });
      }
    }

    const mbGroups = (mbData['release-groups'] || []).map(g => {
      const ptype = (g['primary-type'] || '').toLowerCase();
      const stypes = (g['secondary-types'] || []).map(s => s.toLowerCase());
      let albumType = 'Album';
      if (ptype === 'single' || stypes.includes('single')) albumType = 'Single';
      else if (ptype === 'ep' || stypes.includes('ep')) albumType = 'EP';
      return {
        id: 'mb-' + g.id,
        title: g.title,
        releaseDate: g['first-release-date'] ? g['first-release-date'] + 'T00:00:00Z' : null,
        trackCount: 0,
        albumType,
        coverUrl: `https://coverartarchive.org/release-group/${g.id}/front-250`,
        source: 'musicbrainz',
      };
    });

    const seenTitles = new Set(allItunes.map(a => dedup(a.title)));
    const merged = [...allItunes];
    for (const mb of mbGroups) {
      const mbTitleNorm = dedup(mb.title);
      if (!seenTitles.has(mbTitleNorm)) {
        seenTitles.add(mbTitleNorm);
        merged.push(mb);
      }
    }

    const typeOrder = { Album: 0, EP: 1, Single: 2 };
    merged.sort((a, b) => {
      const ta = typeOrder[a.albumType] ?? 1;
      const tb = typeOrder[b.albumType] ?? 1;
      if (ta !== tb) return ta - tb;
      return (b.releaseDate || '').localeCompare(a.releaseDate || '');
    });

    res.json(merged);
  } catch (err) {
    console.error('Album lookup error:', err.message);
    res.status(502).json({ error: 'Failed to fetch albums' });
  }
});

// ─── Profiles ───────────────────────────────────────────────────────────────

router.get('/profiles/movie', async (req, res) => {
  if (!RADARR_API_KEY) return res.status(503).json({ error: 'Radarr not configured' });
  try {
    const [profiles, rootFolders] = await Promise.all([
      fetchWithTimeout(`${RADARR_HOST}/api/v3/qualityprofile?apikey=${RADARR_API_KEY}`),
      fetchWithTimeout(`${RADARR_HOST}/api/v3/rootfolder?apikey=${RADARR_API_KEY}`),
    ]);
    res.json({
      qualityProfiles: profiles.map(p => ({ id: p.id, name: p.name })),
      rootFolders: rootFolders.map(f => ({ id: f.id, path: f.path, freeSpace: f.freeSpace })),
      minimumAvailabilities: [
        { value: 'announced', label: 'Announced' },
        { value: 'inCinemas', label: 'In Cinemas' },
        { value: 'released', label: 'Released' },
      ],
    });
  } catch (err) {
    console.error('Movie profiles error:', err.message);
    res.status(502).json({ error: 'Failed to fetch profiles' });
  }
});

router.get('/profiles/series', async (req, res) => {
  if (!SONARR_API_KEY) return res.status(503).json({ error: 'Sonarr not configured' });
  try {
    const [profiles, rootFolders] = await Promise.all([
      fetchWithTimeout(`${SONARR_HOST}/api/v3/qualityprofile?apikey=${SONARR_API_KEY}`),
      fetchWithTimeout(`${SONARR_HOST}/api/v3/rootfolder?apikey=${SONARR_API_KEY}`),
    ]);
    res.json({
      qualityProfiles: profiles.map(p => ({ id: p.id, name: p.name })),
      rootFolders: rootFolders.map(f => ({ id: f.id, path: f.path, freeSpace: f.freeSpace })),
      seriesTypes: [
        { value: 'standard', label: 'Standard' },
        { value: 'daily', label: 'Daily' },
        { value: 'anime', label: 'Anime' },
      ],
      monitorOptions: [
        { value: 'all', label: 'All Episodes' },
        { value: 'future', label: 'Future Episodes' },
        { value: 'missing', label: 'Missing Episodes' },
        { value: 'existing', label: 'Existing Episodes' },
        { value: 'pilot', label: 'Pilot Only' },
        { value: 'firstSeason', label: 'First Season' },
        { value: 'lastSeason', label: 'Last Season' },
        { value: 'none', label: 'None' },
      ],
    });
  } catch (err) {
    console.error('Series profiles error:', err.message);
    res.status(502).json({ error: 'Failed to fetch profiles' });
  }
});

router.get('/profiles/music', async (req, res) => {
  if (!LIDARR_API_KEY) return res.status(503).json({ error: 'Lidarr not configured' });
  try {
    const [qualityProfiles, metadataProfiles, rootFolders] = await Promise.all([
      fetchWithTimeout(`${LIDARR_HOST}/api/v1/qualityprofile?apikey=${LIDARR_API_KEY}`),
      fetchWithTimeout(`${LIDARR_HOST}/api/v1/metadataprofile?apikey=${LIDARR_API_KEY}`),
      fetchWithTimeout(`${LIDARR_HOST}/api/v1/rootfolder?apikey=${LIDARR_API_KEY}`),
    ]);
    res.json({
      qualityProfiles: qualityProfiles.map(p => ({ id: p.id, name: p.name })),
      metadataProfiles: metadataProfiles.map(p => ({ id: p.id, name: p.name })),
      rootFolders: rootFolders.map(f => ({ id: f.id, path: f.path, freeSpace: f.freeSpace })),
      monitorOptions: [
        { value: 'all', label: 'All Albums' },
        { value: 'future', label: 'Future Albums' },
        { value: 'missing', label: 'Missing Albums' },
        { value: 'existing', label: 'Existing Albums' },
        { value: 'first', label: 'First Album' },
        { value: 'latest', label: 'Latest Album' },
        { value: 'none', label: 'None' },
      ],
    });
  } catch (err) {
    console.error('Music profiles error:', err.message);
    res.status(502).json({ error: 'Failed to fetch profiles' });
  }
});

// ─── Add Media ──────────────────────────────────────────────────────────────

router.post('/add/movie', async (req, res) => {
  if (!RADARR_API_KEY) return res.status(503).json({ error: 'Radarr not configured' });
  const { tmdbId, qualityProfileId, rootFolderPath, minimumAvailability, monitored, searchForMovie } = req.body;
  if (!tmdbId) return res.status(400).json({ error: 'Missing tmdbId' });
  const logId = logActivity('add', `Adding movie (tmdb:${tmdbId}) to Radarr...`, { tmdbId }, 'pending', { service: 'radarr', tmdbId });
  try {
    const lookup = await fetchWithTimeout(
      `${RADARR_HOST}/api/v3/movie/lookup/tmdb?tmdbId=${tmdbId}&apikey=${RADARR_API_KEY}`
    );
    const movieData = Array.isArray(lookup) ? lookup[0] : lookup;
    if (!movieData) throw new Error('Movie not found');

    const resp = await fetch(`${RADARR_HOST}/api/v3/movie?apikey=${RADARR_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...movieData,
        qualityProfileId: qualityProfileId || 1,
        rootFolderPath: rootFolderPath || getDefaultRootFolder('radarr') || '/movies',
        minimumAvailability: minimumAvailability || 'released',
        monitored: monitored !== false,
        addOptions: { searchForMovie: false },
      }),
    });

    let result;
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const errMsg = err[0]?.errorMessage || err.message || `HTTP ${resp.status}`;
      if (errMsg.toLowerCase().includes('already been added') || errMsg.toLowerCase().includes('already exists')) {
        const allMovies = await fetchWithTimeout(`${RADARR_HOST}/api/v3/movie?apikey=${RADARR_API_KEY}`);
        result = allMovies.find(m => m.tmdbId === Number(tmdbId));
        if (!result?.id) throw new Error(errMsg);
        if (!result.monitored || (qualityProfileId && result.qualityProfileId !== qualityProfileId)) {
          await fetch(`${RADARR_HOST}/api/v3/movie/${result.id}?apikey=${RADARR_API_KEY}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...result, monitored: true, qualityProfileId: qualityProfileId || result.qualityProfileId }),
          }).catch(() => {});
        }
        updateLogEntry(logId, { status: 'info', message: `"${result.title}" already in Radarr — re-enabled monitoring and triggering search`, context: { service: 'radarr', title: result.title, movieId: result.id } });
      } else {
        throw new Error(errMsg);
      }
    } else {
      result = await resp.json();
      updateLogEntry(logId, { status: 'success', message: `Added "${result.title}" to Radarr, searching for downloads`, context: { service: 'radarr', title: result.title, movieId: result.id } });
      refreshLibraryCache();
    }

    const posterUrl = pickArrImageUrl(movieData.images || [], 'poster', 'radarr');
    const pipelineKey = `radarr-${result.id}-${Date.now()}`;
    addPipelineItem(pipelineKey, { service: 'radarr', title: result.title, subtitle: 'Movie', posterUrl, logId, movieId: result.id, retryId: result.id });
    advancePipeline(pipelineKey, 'searching');
    if (searchForMovie !== false) {
      fetch(`${RADARR_HOST}/api/v3/command?apikey=${RADARR_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'MoviesSearch', movieIds: [result.id] }),
      }).then(r => r.json()).then(cmd => {
        if (cmd?.id) watchRadarrSearch(pipelineKey, cmd.id, result.id, logId, result.title).catch(e => console.error('watchRadarrSearch add:', e.message));
      }).catch(() => {});
    }

    res.json({ success: true, id: result.id, title: result.title });
  } catch (err) {
    updateLogEntry(logId, { status: 'error', message: `Failed to add movie: ${err.message}` });
    console.error('Add movie error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers for watch search ──────────────────────────────────────────────

async function watchRadarrSearch(pipelineKey, commandId, movieId, logId, movieTitle) {
  const RADARR_HOST = CONFIG.RADARR_HOST;
  const RADARR_API_KEY = CONFIG.RADARR_API_KEY;
  // Arr search commands can complete without grabbing anything; watchers confirm the downstream result first.
  try {
    let completed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const cmd = await fetchWithTimeout(`${RADARR_HOST}/api/v3/command/${commandId}?apikey=${RADARR_API_KEY}`, 8000);
        if (cmd.status === 'completed') {
          completed = true;
          const grabUrl = `${RADARR_HOST}/api/v3/release?movieId=${movieId}&apikey=${RADARR_API_KEY}`;
          let grabbed = 0;
          try {
            const releases = await fetchWithTimeout(grabUrl, 8000);
            grabbed = (Array.isArray(releases) ? releases : []).filter(r => r.grabbed).length;
          } catch {}
          if (grabbed > 0) {
            advancePipeline(pipelineKey, 'grabbed', { progress: null });
            if (logId) addLogStep(logId, `Grabbed ${grabbed} release(s) for "${movieTitle}"`, 'success');
          } else {
            advancePipeline(pipelineKey, 'searching', { canRetry: true });
            if (logId) addLogStep(logId, 'Search completed — no releases grabbed (may appear in queue shortly)', 'pending');
          }
          break;
        } else if (cmd.status === 'failed') {
          if (logId) addLogStep(logId, `Search command failed: ${cmd.errorMessage || 'unknown'}`, 'error');
          advancePipeline(pipelineKey, 'searching', { canRetry: true });
          break;
        }
      } catch {}
    }
    if (!completed) {
      advancePipeline(pipelineKey, 'searching', { canRetry: true });
    }
  } catch (err) {
    console.error('watchRadarrSearch error:', err.message);
  }
}

async function watchSonarrSearch(pipelineKey, commandId, seriesId, seasonNumber, logId, seriesTitle) {
  const SONARR_HOST = CONFIG.SONARR_HOST;
  const SONARR_API_KEY = CONFIG.SONARR_API_KEY;
  try {
    let completed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const cmd = await fetchWithTimeout(`${SONARR_HOST}/api/v3/command/${commandId}?apikey=${SONARR_API_KEY}`, 8000);
        if (cmd.status === 'completed') {
          completed = true;
          const histUrl = `${SONARR_HOST}/api/v3/history/series?seriesId=${seriesId}&pageSize=50&apikey=${SONARR_API_KEY}`;
          let grabbed = 0;
          try {
            const history = await fetchWithTimeout(histUrl, 8000);
            const records = history.records || history || [];
            const since = Date.now() - 120000;
            grabbed = (Array.isArray(records) ? records : []).filter(r => r.eventType === 'grabbed' && new Date(r.date).getTime() > since).length;
          } catch {}
          if (grabbed > 0) {
            advancePipeline(pipelineKey, 'grabbed', { progress: null });
            if (logId) addLogStep(logId, `Grabbed ${grabbed} release(s) for "${seriesTitle}"`, 'success');
          } else {
            advancePipeline(pipelineKey, 'searching', { canRetry: true });
            if (logId) addLogStep(logId, 'Search completed — no releases grabbed', 'pending');
          }
          break;
        } else if (cmd.status === 'failed') {
          if (logId) addLogStep(logId, `Search command failed: ${cmd.errorMessage || 'unknown'}`, 'error');
          advancePipeline(pipelineKey, 'searching', { canRetry: true });
          break;
        }
      } catch {}
    }
    if (!completed) {
      advancePipeline(pipelineKey, 'searching', { canRetry: true });
    }
  } catch (err) {
    console.error('watchSonarrSearch error:', err.message);
  }
}

router.post('/add/series', async (req, res) => {
  if (!SONARR_API_KEY) return res.status(503).json({ error: 'Sonarr not configured' });
  const { tvdbId, qualityProfileId, rootFolderPath, seriesType, monitored, monitorOption, searchForMissingEpisodes, selectedSeasons } = req.body;
  if (!tvdbId) return res.status(400).json({ error: 'Missing tvdbId' });
  const logId = logActivity('add', `Adding series (tvdb:${tvdbId}) to Sonarr...`, { tvdbId }, 'pending', { service: 'sonarr', tvdbId });
  try {
    const lookupResults = await fetchWithTimeout(
      `${SONARR_HOST}/api/v3/series/lookup?term=tvdb:${tvdbId}&apikey=${SONARR_API_KEY}`
    );
    const seriesData = Array.isArray(lookupResults) ? lookupResults[0] : lookupResults;
    if (!seriesData) throw new Error('Series not found');

    if (selectedSeasons && seriesData.seasons) {
      seriesData.seasons = seriesData.seasons.map(s => ({
        ...s,
        monitored: selectedSeasons.includes(s.seasonNumber),
      }));
    }

    const resp = await fetch(`${SONARR_HOST}/api/v3/series?apikey=${SONARR_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...seriesData,
        qualityProfileId: qualityProfileId || 1,
        rootFolderPath: rootFolderPath || getDefaultRootFolder('sonarr') || '/tv',
        seriesType: seriesType || 'standard',
        monitored: monitored !== false,
        seasonFolder: true,
        addOptions: {
          monitor: selectedSeasons ? 'none' : (monitorOption || 'all'),
          searchForMissingEpisodes: searchForMissingEpisodes !== false,
          searchForCutoffUnmetEpisodes: false,
        },
      }),
    });

    let result;
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const errMsg = err[0]?.errorMessage || err.message || `HTTP ${resp.status}`;
      if (errMsg.toLowerCase().includes('already been added') || errMsg.toLowerCase().includes('already exists')) {
        const allSeries = await fetchWithTimeout(`${SONARR_HOST}/api/v3/series?apikey=${SONARR_API_KEY}`);
        result = allSeries.find(s => s.tvdbId === Number(tvdbId));
        if (!result?.id) throw new Error(errMsg);
        const updatedSeries = {
          ...result,
          monitored: true,
          seasons: result.seasons?.map(s => ({
            ...s,
            monitored: selectedSeasons ? selectedSeasons.includes(s.seasonNumber) : s.monitored,
          })) || [],
        };
        await fetch(`${SONARR_HOST}/api/v3/series/${result.id}?apikey=${SONARR_API_KEY}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedSeries),
        }).catch(() => {});
        const seasonLabel = selectedSeasons ? ` (seasons ${selectedSeasons.join(', ')})` : '';
        updateLogEntry(logId, { status: 'info', message: `"${result.title}"${seasonLabel} already in Sonarr — re-enabled monitoring and triggering search`, context: { service: 'sonarr', title: result.title, seriesId: result.id, seasons: selectedSeasons } });
      } else {
        throw new Error(errMsg);
      }
    } else {
      result = await resp.json();
      const seasonLabel = selectedSeasons ? ` (seasons ${selectedSeasons.join(', ')})` : '';
      updateLogEntry(logId, { status: 'success', message: `Added "${result.title}"${seasonLabel} to Sonarr, searching for downloads`, context: { service: 'sonarr', title: result.title, seriesId: result.id, seasons: selectedSeasons } });
      refreshLibraryCache();
    }

    const seriesPoster = pickArrImageUrl(seriesData.images || [], 'poster', 'sonarr');
    if (selectedSeasons?.length) {
      try {
        const currentSeries = await fetchWithTimeout(`${SONARR_HOST}/api/v3/series/${result.id}?apikey=${SONARR_API_KEY}`);
        const selectedSeasonSet = new Set(selectedSeasons.map(Number));
        const updatedSeries = {
          ...currentSeries,
          monitored: true,
          seasons: (currentSeries.seasons || []).map((season) => ({
            ...season,
            monitored: selectedSeasonSet.has(season.seasonNumber),
          })),
        };
        const monitorResp = await fetch(`${SONARR_HOST}/api/v3/series/${result.id}?apikey=${SONARR_API_KEY}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedSeries),
        });
        if (monitorResp.ok) {
          addLogStep(logId, `Enabled Sonarr monitoring for seasons ${selectedSeasons.join(', ')}`, 'info');
        } else {
          addLogStep(logId, `Sonarr add completed, but season monitoring PUT returned HTTP ${monitorResp.status}`, 'warning');
        }
      } catch (err) {
        addLogStep(logId, `Failed to confirm Sonarr season monitoring: ${err.message}`, 'warning');
      }
    }
    const pipelineKey = `sonarr-${result.id}-add-${Date.now()}`;
    const subtitle = selectedSeasons ? `Seasons ${selectedSeasons.join(', ')}` : 'All seasons';
    addPipelineItem(pipelineKey, { service: 'sonarr', title: result.title, subtitle, posterUrl: seriesPoster, logId, seriesId: result.id, seasonNumbers: selectedSeasons || null, retryId: result.id });
    advancePipeline(pipelineKey, 'searching');
    const singleSeasonSearch = selectedSeasons?.length === 1;
    const cmdBody = singleSeasonSearch
      ? { name: 'SeasonSearch', seriesId: result.id, seasonNumber: selectedSeasons[0] }
      : { name: 'SeriesSearch', seriesId: result.id };
    fetch(`${SONARR_HOST}/api/v3/command?apikey=${SONARR_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmdBody),
    }).then(r => r.json()).then(cmd => {
      if (cmd?.id) watchSonarrSearch(pipelineKey, cmd.id, result.id, singleSeasonSearch ? selectedSeasons[0] : null, logId, result.title).catch(e => console.error('watchSonarrSearch add:', e.message));
    }).catch(() => {});

    res.json({ success: true, id: result.id, title: result.title });
  } catch (err) {
    updateLogEntry(logId, { status: 'error', message: `Failed to add series: ${err.message}` });
    console.error('Add series error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/add/music', async (req, res) => {
  if (!LIDARR_API_KEY) return res.status(503).json({ error: 'Lidarr not configured' });
  const { foreignArtistId, artistName, qualityProfileId, metadataProfileId, rootFolderPath, monitored, monitorOption, searchForMissingAlbums, selectedAlbums, selectedAlbumTitles } = req.body;
  if (!foreignArtistId) return res.status(400).json({ error: 'Missing foreignArtistId' });

  const hasAlbumSelection = selectedAlbumTitles && selectedAlbumTitles.length > 0;
  const logId = logActivity('add', `Adding artist "${artistName}" to Lidarr...`, { foreignArtistId }, 'pending', { service: 'lidarr', artistName, foreignArtistId });

  try {
    addLogStep(logId, `Adding "${artistName}" to Lidarr${hasAlbumSelection ? ` (${selectedAlbumTitles.length} albums selected)` : ' (all albums)'}`, 'pending');

    const addPayload = {
      foreignArtistId,
      artistName: artistName || '',
      qualityProfileId: qualityProfileId || 1,
      metadataProfileId: metadataProfileId || 1,
      rootFolderPath: rootFolderPath || getDefaultRootFolder('lidarr') || '/music',
      monitored: true,
      monitorNewItems: 'all',
      addOptions: {
        monitor: hasAlbumSelection ? 'none' : (monitorOption || 'all'),
        searchForMissingAlbums: hasAlbumSelection ? false : (searchForMissingAlbums !== false),
      },
    };

    const resp = await fetch(`${LIDARR_HOST}/api/v1/artist?apikey=${LIDARR_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addPayload),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err[0]?.errorMessage || err.message || `HTTP ${resp.status}`);
    }
    const addResult = await resp.json();
    addLogStep(logId, `Artist "${addResult.artistName}" added to Lidarr (ID: ${addResult.id})`, 'success');

    let albums = [];
    addLogStep(logId, 'Waiting for Lidarr to import album metadata...', 'pending');
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        albums = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/album?artistId=${addResult.id}&apikey=${LIDARR_API_KEY}`, 10000);
      } catch (e) {
        console.log(`Album fetch attempt ${attempt + 1} error: ${e.message}`);
      }
      if (albums.length > 0) break;
    }
    if (albums.length > 0) {
      addLogStep(logId, `Lidarr imported ${albums.length} album(s)`, 'success');
    } else {
      addLogStep(logId, 'Warning: Lidarr returned 0 albums after 30s — artist may have no MusicBrainz releases', 'warning');
    }

    const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\[.*?\]\s*/g, ' ')
      .replace(/ - (single|ep)$/i, '').replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ').trim();

    const albumsToSearch = [];
    let unmatchedAlbumTitles = [];

    if (hasAlbumSelection && albums.length > 0) {
      // For curated album picks, import the artist first and opt matching albums into monitoring afterward.
      const normalizedSelected = selectedAlbumTitles.map(t => ({ original: t, norm: normalize(t) }));

      const matched = [];
      const matchedOriginals = new Set();

      const albumsWithMatches = albums.map(album => {
        const albumNorm = normalize(album.title || '');
        const matchEntry = normalizedSelected.find(sel => sel.norm === albumNorm) ||
          normalizedSelected.find(sel => {
            if (sel.norm.length < 3 || albumNorm.length < 3) return false;
            const shorter = sel.norm.length <= albumNorm.length ? sel.norm : albumNorm;
            const longer = sel.norm.length > albumNorm.length ? sel.norm : albumNorm;
            if (shorter.length / longer.length < 0.6) return false;
            return longer.includes(shorter);
          });
        return { album, matchEntry };
      }).filter(({ matchEntry }) => matchEntry != null);

      await Promise.all(albumsWithMatches.map(async ({ album, matchEntry }) => {
        album.monitored = true;
        matchedOriginals.add(matchEntry.original);
        try {
          await fetch(`${LIDARR_HOST}/api/v1/album/${album.id}?apikey=${LIDARR_API_KEY}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(album),
          });
          matched.push(album.title);
          albumsToSearch.push({ id: album.id, title: album.title });
        } catch (e) {
          addLogStep(logId, `Failed to monitor "${album.title}": ${e.message}`, 'error');
        }
      }));

      const unmatchedSelected = selectedAlbumTitles.filter(t => !matchedOriginals.has(t));

      if (matched.length > 0) {
        addLogStep(logId, `Monitoring ${matched.length}/${selectedAlbumTitles.length} albums: ${matched.join(', ')}`, 'success');
      } else {
        addLogStep(logId, `Warning: Could not match any selected albums in Lidarr`, 'warning');
      }
      if (unmatchedSelected.length > 0) {
        unmatchedAlbumTitles = unmatchedSelected;
        addLogStep(logId, `${unmatchedSelected.length} selected album(s) not found in Lidarr: ${unmatchedSelected.join(', ')}`, 'warning');
      }
    } else if (albums.length > 0) {
      for (const album of albums) {
        if (album.monitored) {
          albumsToSearch.push({ id: album.id, title: album.title });
        }
      }
      addLogStep(logId, `All ${albumsToSearch.length} albums monitored`, 'success');
    }

    if (hasAlbumSelection && albums.length === 0) {
      unmatchedAlbumTitles = [...selectedAlbumTitles];
      addLogStep(logId, `Lidarr has no album metadata — will search Soulseek directly for ${selectedAlbumTitles.length} album(s)`, 'pending');
    }

    try {
      const artistData = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/artist/${addResult.id}?apikey=${LIDARR_API_KEY}`, 5000);
      if (!artistData.monitored) {
        artistData.monitored = true;
        const putResp = await fetch(`${LIDARR_HOST}/api/v1/artist/${addResult.id}?apikey=${LIDARR_API_KEY}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(artistData),
        });
        if (putResp.ok) {
          addLogStep(logId, 'Artist monitoring enabled', 'success');
        } else {
          addLogStep(logId, `Warning: Could not enable artist monitoring (HTTP ${putResp.status})`, 'warning');
        }
      }
    } catch (e) {
      addLogStep(logId, `Warning: Could not enable artist monitoring: ${e.message}`, 'warning');
    }

    if (albumsToSearch.length > 0) {
      try {
        const albumIds = albumsToSearch.map(a => a.id);
        await fetch(`${LIDARR_HOST}/api/v1/command?apikey=${LIDARR_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'AlbumSearch', albumIds }),
        });
        addLogStep(logId, `Lidarr search triggered for ${albumIds.length} album(s)`, 'success');
      } catch (e) {
        addLogStep(logId, `Lidarr search trigger failed: ${e.message}`, 'error');
      }
    }

    if ((albumsToSearch.length > 0 || unmatchedAlbumTitles.length > 0) && SLSKD_API_KEY) {
      const resolvedArtistName = addResult.artistName || artistName;
      const searchAlbums = [
          ...albumsToSearch,
          ...unmatchedAlbumTitles.map(t => ({ id: null, title: t })),
        ];
      (async () => {
        addLogStep(logId, `Starting Soulseek direct search for ${searchAlbums.length} album(s)...`, 'pending');
        let queued = 0;
        let failed = 0;
        const failedTitles = [];

        for (const album of searchAlbums) {
          try {
            const dlResult = await searchAndDownloadSlskd(resolvedArtistName, album.title, logId, addResult.id, album.id);
            if (dlResult.success) {
              queued++;
            } else {
              failed++;
              failedTitles.push(`${album.title} (${dlResult.reason})`);
            }
          } catch (e) {
            failed++;
            failedTitles.push(`${album.title} (${e.message})`);
          }
          if (searchAlbums.indexOf(album) < searchAlbums.length - 1) {
            await new Promise(r => setTimeout(r, 1500));
          }
        }

        if (queued > 0) {
          addLogStep(logId, `Soulseek: Queued downloads for ${queued}/${searchAlbums.length} album(s)`, 'success');
          updateLogEntry(logId, { status: 'success', message: `"${resolvedArtistName}" — ${queued} album(s) downloading via Soulseek` });
        } else if (failed > 0) {
          addLogStep(logId, `Soulseek: No downloads queued. Failed: ${failedTitles.join('; ')}. Soularr will retry on next cycle.`, 'warning');
        }

        if (queued > 0) {
          console.log('SLSKD downloads queued — auto-import pipeline will handle import when complete');
        }
      })().catch(err => {
        console.error('SLSKD background search error:', err.message);
        addLogStep(logId, `Soulseek background search error: ${err.message}`, 'error');
      });
    }

    const albumInfo = albumsToSearch.length > 0 ? ` (${albumsToSearch.length} albums monitored)` : '';
    updateLogEntry(logId, { status: 'success', message: `Added "${addResult.artistName}" to Lidarr${albumInfo}, searching for downloads...` });
    refreshLibraryCache();
    res.json({
      success: true, id: addResult.id, artistName: addResult.artistName,
      albumsMonitored: albumsToSearch.length, totalAlbums: albums.length,
      details: albumsToSearch.map(a => a.title),
    });
  } catch (err) {
    updateLogEntry(logId, { status: 'error', message: `Failed to add artist: ${err.message}` });
    console.error('Add music error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete Media ───────────────────────────────────────────────────────────

router.delete('/delete/movie/:id', async (req, res) => {
  if (!RADARR_API_KEY) return res.status(503).json({ error: 'Radarr not configured' });
  const { id } = req.params;
  const deleteFiles = req.query.deleteFiles !== 'false';
  const logId = logActivity('delete', `Deleting movie ID ${id} from Radarr...`, { movieId: id, deleteFiles }, 'pending', { service: 'radarr' });
  try {
    let title = `ID ${id}`;
    try {
      const info = await fetchWithTimeout(`${RADARR_HOST}/api/v3/movie/${id}?apikey=${RADARR_API_KEY}`);
      title = info.title || title;
    } catch {}
    const resp = await fetch(`${RADARR_HOST}/api/v3/movie/${id}?deleteFiles=${deleteFiles}&addImportExclusion=false&apikey=${RADARR_API_KEY}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      throw new Error(parseArrError(await resp.text(), resp.status));
    }
    updateLogEntry(logId, { status: 'success', message: `Deleted "${title}" from Radarr${deleteFiles ? ' (files removed)' : ''}`, context: { service: 'radarr', title } });
    refreshLibraryCache();
    res.json({ success: true, title });
  } catch (err) {
    updateLogEntry(logId, { status: 'error', message: `Failed to delete movie: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/delete/series/:id', async (req, res) => {
  if (!SONARR_API_KEY) return res.status(503).json({ error: 'Sonarr not configured' });
  const { id } = req.params;
  const deleteFiles = req.query.deleteFiles !== 'false';
  const logId = logActivity('delete', `Deleting series ID ${id} from Sonarr...`, { seriesId: id, deleteFiles }, 'pending', { service: 'sonarr' });
  try {
    let title = `ID ${id}`;
    try {
      const info = await fetchWithTimeout(`${SONARR_HOST}/api/v3/series/${id}?apikey=${SONARR_API_KEY}`);
      title = info.title || title;
    } catch {}
    const resp = await fetch(`${SONARR_HOST}/api/v3/series/${id}?deleteFiles=${deleteFiles}&apikey=${SONARR_API_KEY}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      throw new Error(parseArrError(await resp.text(), resp.status));
    }
    updateLogEntry(logId, { status: 'success', message: `Deleted "${title}" from Sonarr${deleteFiles ? ' (files removed)' : ''}`, context: { service: 'sonarr', title } });
    refreshLibraryCache();
    res.json({ success: true, title });
  } catch (err) {
    updateLogEntry(logId, { status: 'error', message: `Failed to delete series: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/delete/album/:id/files', async (req, res) => {
  if (!LIDARR_API_KEY) return res.status(503).json({ error: 'Lidarr not configured' });
  try {
    const trackFiles = await fetchWithTimeout(
      `${LIDARR_HOST}/api/v1/trackfile?albumId=${encodeURIComponent(req.params.id)}&apikey=${LIDARR_API_KEY}`, 8000
    );
    if (!Array.isArray(trackFiles) || trackFiles.length === 0)
      return res.json({ success: true, deleted: 0 });
    const ids = trackFiles.map(f => f.id);
    await fetch(`${LIDARR_HOST}/api/v1/trackfile/bulk?apikey=${LIDARR_API_KEY}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackFileIds: ids }),
    });
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    console.error('Album file delete error:', err.message);
    res.status(502).json({ error: 'Failed to delete album files' });
  }
});

router.delete('/delete/music/:id', async (req, res) => {
  if (!LIDARR_API_KEY) return res.status(503).json({ error: 'Lidarr not configured' });
  const { id } = req.params;
  const deleteFiles = req.query.deleteFiles !== 'false';
  const logId = logActivity('delete', `Deleting artist ID ${id} from Lidarr...`, { artistId: id, deleteFiles }, 'pending', { service: 'lidarr' });
  try {
    let artistName = `ID ${id}`;
    try {
      const info = await fetchWithTimeout(`${LIDARR_HOST}/api/v1/artist/${id}?apikey=${LIDARR_API_KEY}`);
      artistName = info.artistName || artistName;
    } catch {}
    const resp = await fetch(`${LIDARR_HOST}/api/v1/artist/${id}?deleteFiles=${deleteFiles}&apikey=${LIDARR_API_KEY}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      throw new Error(parseArrError(await resp.text(), resp.status));
    }
    updateLogEntry(logId, { status: 'success', message: `Deleted "${artistName}" from Lidarr${deleteFiles ? ' (files removed)' : ''}`, context: { service: 'lidarr', artistName } });
    refreshLibraryCache();
    res.json({ success: true, artistName });
  } catch (err) {
    updateLogEntry(logId, { status: 'error', message: `Failed to delete artist: ${err.message}` });
    res.status(500).json({ error: err.message });
  }
});

export default router;
