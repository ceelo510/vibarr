import { logServerEvent, summarizeError } from './state.js';

let libraryRefreshTimer = null;

export async function refreshLibraryCacheFromPipeline(reason) {
  try {
    const { refreshLibraryCache } = await import('./routes/library.js');
    await refreshLibraryCache();
  } catch (err) {
    logServerEvent('warn', 'pipeline.library_refresh_failed', {
      reason,
      error: summarizeError(err),
    });
  }
}

export function scheduleLibraryRefresh(reason, delayMs = 15000, refreshImpl = refreshLibraryCacheFromPipeline) {
  if (libraryRefreshTimer) clearTimeout(libraryRefreshTimer);
  libraryRefreshTimer = setTimeout(() => {
    libraryRefreshTimer = null;
    void refreshImpl(reason);
  }, delayMs);
}
