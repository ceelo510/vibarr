/** Cleans a raw container/service name into a human-readable title. */
export function cleanName(name) {
  return name
    .replace(/^\//, '')
    .replace(/[-_](\d+)$/, '')
    .replace(/^(arr[-_]?stack[-_]?|docker[-_]?)/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Cached Intl.NumberFormat — instantiated once, reused for every call.
const _nfBytes = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const _BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Formats bytes into a human-readable string (e.g. "1.4 GB"). */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const i = Math.min(_BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return _nfBytes.format(bytes / Math.pow(k, i)) + ' ' + _BYTE_UNITS[i];
}

/** Formats bytes-per-second into a human-readable speed string (e.g. "12.3 MB/s"). */
export function formatSpeed(bps) {
  if (!bps) return '0 B/s';
  return formatBytes(bps) + '/s';
}

/** Formats a seconds-remaining value into a human-readable ETA string (e.g. "1h 23m"). */
export function formatETA(seconds) {
  // qBittorrent uses 8640000 as its "unknown ETA" sentinel.
  if (!seconds || seconds === 8640000 || seconds < 0) return '--';
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Normalizes a torrent state string to: 'downloading' | 'seeding' | 'paused' | 'completed' | 'error'. */
export function getTorrentState(t) {
  if (t.state === 'error') return 'error';
  // qBittorrent can report finished-but-moved data as missingFiles.
  if (t.state === 'missingFiles') return 'completed';
  if (t.state === 'pausedDL' || t.state === 'pausedUP' || t.state === 'stoppedDL' || t.state === 'stoppedUP') return 'paused';
  if (t.progress >= 100 || t.state === 'uploading' || t.state === 'stalledUP' || t.state === 'forcedUP' || t.state === 'queuedUP') return 'seeding';
  return 'downloading';
}

/** Array of dark gradient CSS strings used for poster placeholder backgrounds. */
export const GRADIENTS = [
  'linear-gradient(160deg, #1a0a00, #3d1200, #7a2e00, #2d0a00)',
  'linear-gradient(145deg, #0d0800, #3d2800, #8b5e00, #c47a00)',
  'linear-gradient(155deg, #000000, #1a0000, #3d0000, #6b1100)',
  'linear-gradient(150deg, #020408, #0a1520, #14304a, #0d2035)',
  'linear-gradient(140deg, #080808, #1a1200, #3d2e00, #5c4400)',
  'linear-gradient(135deg, #000510, #001a3d, #002d6b, #004080)',
  'linear-gradient(150deg, #000510, #0a0020, #1a0040, #2d0060)',
  'linear-gradient(160deg, #000000, #001005, #001a08, #003010)',
  'linear-gradient(145deg, #05000a, #1a0010, #3d0020, #6b0035)',
  'linear-gradient(155deg, #0d0500, #2d1000, #5c3000, #8b5500)',
];

/** Returns a deterministic gradient CSS string for a given title string. */
export function gradientFor(str) {
  let h = 0;
  for (const c of (str || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

/** Formats an ISO timestamp into a human-readable relative time string (e.g. "3h ago"). */
export function timeAgo(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Extracts the best available numeric rating from a ratings object (prefers IMDb, then TMDb, Rotten Tomatoes, Trakt). */
export function extractRating(ratings) {
  if (!ratings) return null;
  if (ratings.imdb?.value != null) return ratings.imdb.value.toFixed(1);
  if (ratings.tmdb?.value != null) return ratings.tmdb.value.toFixed(1);
  if (ratings.rottenTomatoes?.value != null) return ratings.rottenTomatoes.value.toFixed(1);
  if (ratings.trakt?.value != null) return ratings.trakt.value.toFixed(1);
  return null;
}

/** Detects a video quality label (e.g. "4K", "1080p", "WEB") from a release object's quality and title fields. */
export function detectQualityLabel(r) {
  const q = (r.quality || '') + ' ' + (r.title || '');
  if (/2160p|4K|UHD/i.test(q)) return '4K';
  if (/1080p/i.test(q)) return '1080p';
  if (/720p/i.test(q)) return '720p';
  if (/480p|576p/i.test(q)) return '480p';
  if (/HDTV/i.test(q)) return 'HDTV';
  if (/BluRay|Blu-Ray|BDRip/i.test(q)) return 'BluRay';
  if (/WEB-?DL|WEBDL|WEBRip/i.test(q)) return 'WEB';
  if (/CAM|TS\b|TELESYNC/i.test(q)) return 'CAM';
  return 'Other';
}
