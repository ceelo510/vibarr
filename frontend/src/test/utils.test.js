import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatSpeed,
  formatETA,
  getTorrentState,
  cleanName,
  detectQualityLabel,
  gradientFor,
  timeAgo,
  extractRating,
} from '../utils';

describe('formatBytes', () => {
  it('returns "0 B" for falsy values', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });

  it('formats bytes correctly', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
    expect(formatBytes(1099511627776)).toBe('1.0 TB');
  });
});

describe('formatSpeed', () => {
  it('returns "0 B/s" for falsy values', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
  });

  it('appends /s to formatted bytes', () => {
    expect(formatSpeed(1048576)).toBe('1.0 MB/s');
  });
});

describe('formatETA', () => {
  it('returns "--" for invalid values', () => {
    expect(formatETA(0)).toBe('--');
    expect(formatETA(-1)).toBe('--');
    expect(formatETA(8640000)).toBe('--');
  });

  it('formats seconds to human-readable', () => {
    expect(formatETA(3661)).toBe('1h 1m');
    expect(formatETA(60)).toBe('1m');
    expect(formatETA(30)).toBe('30s');
  });
});

describe('getTorrentState', () => {
  it('returns error for error state', () => {
    expect(getTorrentState({ state: 'error' })).toBe('error');
  });

  it('returns completed for missingFiles', () => {
    expect(getTorrentState({ state: 'missingFiles' })).toBe('completed');
  });

  it('returns paused for paused/stopped states', () => {
    expect(getTorrentState({ state: 'pausedDL' })).toBe('paused');
    expect(getTorrentState({ state: 'stoppedUP' })).toBe('paused');
  });

  it('returns seeding for seeding states', () => {
    expect(getTorrentState({ state: 'uploading', progress: 100 })).toBe('seeding');
    expect(getTorrentState({ state: 'stalledUP', progress: 100 })).toBe('seeding');
  });

  it('returns downloading for active download', () => {
    expect(getTorrentState({ state: 'downloading', progress: 50 })).toBe('downloading');
  });
});

describe('cleanName', () => {
  it('cleans container names', () => {
    expect(cleanName('/sonarr')).toBe('Sonarr');
    expect(cleanName('arr-stack-radarr-1')).toBe('Radarr');
    expect(cleanName('docker-sonarr-1')).toBe('Sonarr');
  });
});

describe('detectQualityLabel', () => {
  it('detects 4K', () => {
    expect(detectQualityLabel({ quality: 'Bluray-2160p', title: 'Movie' })).toBe('4K');
  });

  it('detects 1080p', () => {
    expect(detectQualityLabel({ quality: 'Bluray-1080p', title: 'Movie' })).toBe('1080p');
  });

  it('detects 720p', () => {
    expect(detectQualityLabel({ quality: 'HDTV-720p', title: 'Movie' })).toBe('720p');
  });

  it('returns Other for unknown quality', () => {
    expect(detectQualityLabel({ quality: 'Unknown', title: 'Movie' })).toBe('Other');
  });
});

describe('extractRating', () => {
  it('prefers IMDb rating', () => {
    expect(extractRating({ imdb: { value: 8.5 }, tmdb: { value: 7.9 } })).toBe('8.5');
  });

  it('returns null for no ratings', () => {
    expect(extractRating(null)).toBeNull();
    expect(extractRating({})).toBeNull();
  });
});
