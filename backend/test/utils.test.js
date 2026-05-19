import test from 'node:test';
import assert from 'node:assert/strict';
import { pickArrImageUrl, pickImageUrl } from '../src/utils.js';

test('pickImageUrl accepts protocol-relative remote URLs', () => {
  const images = [{ coverType: 'poster', remoteUrl: '//image.tmdb.org/t/p/original/poster.jpg' }];
  assert.equal(pickImageUrl(images, 'poster'), 'https://image.tmdb.org/t/p/original/poster.jpg');
});

test('pickArrImageUrl accepts protocol-relative remote URLs', () => {
  const images = [{ coverType: 'poster', remoteUrl: '//image.tmdb.org/t/p/original/poster.jpg' }];
  assert.equal(pickArrImageUrl(images, 'poster', 'radarr'), 'https://image.tmdb.org/t/p/original/poster.jpg');
});

test('pickArrImageUrl keeps absolute remote URLs instead of proxying them as Arr paths', () => {
  const images = [{ coverType: 'poster', url: 'https://image.tmdb.org/t/p/original/poster.jpg' }];
  assert.equal(pickArrImageUrl(images, 'poster', 'radarr'), 'https://image.tmdb.org/t/p/original/poster.jpg');
});

test('pickArrImageUrl builds valid proxy URLs for relative Arr image paths', () => {
  const images = [{ coverType: 'poster', url: 'MediaCover/40/poster.jpg' }];
  assert.equal(pickArrImageUrl(images, 'poster', 'radarr'), '/api/arr-image/radarr/MediaCover/40/poster.jpg');
});

test('pickArrImageUrl does not double slash leading Arr image paths', () => {
  const images = [{ coverType: 'poster', url: '/MediaCover/40/poster.jpg' }];
  assert.equal(pickArrImageUrl(images, 'poster', 'radarr'), '/api/arr-image/radarr/MediaCover/40/poster.jpg');
});
