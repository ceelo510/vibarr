import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleLibraryRefresh } from '../src/libraryRefresh.js';

test('scheduleLibraryRefresh keeps only the latest queued refresh', async () => {
  const reasons = [];
  scheduleLibraryRefresh('first', 0, async (reason) => {
    reasons.push(reason);
  });
  scheduleLibraryRefresh('second', 0, async (reason) => {
    reasons.push(reason);
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(reasons, ['second']);
});
