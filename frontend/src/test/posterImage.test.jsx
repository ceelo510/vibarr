import { describe, expect, it } from 'vitest';
import { getPosterSrc } from '../PosterImage';

describe('getPosterSrc', () => {
  it('keeps local API poster URLs untouched', () => {
    expect(getPosterSrc('/api/arr-image/radarr/MediaCover/40/poster.jpg')).toBe('/api/arr-image/radarr/MediaCover/40/poster.jpg');
  });

  it('proxies absolute poster URLs through the backend poster endpoint', () => {
    expect(getPosterSrc('https://image.tmdb.org/t/p/original/poster.jpg')).toBe(
      '/api/poster?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fposter.jpg',
    );
  });

  it('normalizes protocol-relative poster URLs before proxying them', () => {
    expect(getPosterSrc('//image.tmdb.org/t/p/original/poster.jpg')).toBe(
      '/api/poster?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Foriginal%2Fposter.jpg',
    );
  });

  it('rejects unsafe relative strings instead of turning them into broken image requests', () => {
    expect(getPosterSrc('MediaCover/40/poster.jpg')).toBeNull();
    expect(getPosterSrc(null)).toBeNull();
  });
});
