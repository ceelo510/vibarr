## 2026-05-11 — Remove first-run setup auth gate and enable SLSKD by default

**Goal:** make clean-VM setup a direct click-through installer with the full media stack selected by default.

**What changed:**
- Removed the first-run setup auth gate from the backend, installer script, Compose environment, docs, and setup UI.
- Removed the setup credential input and warning text from the first-run installer card.
- Made SLSKD selected by default alongside Radarr, Sonarr, Lidarr, Prowlarr, and qBittorrent.
- Kept `/api/setup/install` rate-limited, but it no longer fails with a setup-auth 401 before the user can install the stack.

**Files changed:**
- `install.sh`
- `docker-compose.yml`
- `.env.example`
- `README.md`
- `SETUP.md`
- `backend/src/errors.js`
- `backend/src/installerState.js`
- `backend/src/middleware.js`
- `backend/src/routes/installer.js`
- `frontend/src/App.jsx`
- `CHANGELOG.md`

## 2026-05-11 — Fix first-run setup auth and qB status UX

**Goal:** make the clean-VM onboarding UI match the installer contract before users click `Install Stack`.

**What changed:**
- Removed the Compose defaults that injected `admin/adminadmin` qBittorrent credentials into clean web-onboarding installs, so the dashboard no longer reports qBittorrent as `DOWN` before qBittorrent exists.
- Added a short-lived setup-auth path for `/api/setup/install`; that auth gate was removed in the later entry above so clean-VM installs are now click-through.
- Switched first-run qBittorrent credential setup from offline PBKDF2 config writes to qBittorrent's Web API: the installer now logs in with the temporary first-run admin password, saves the generated dashboard credentials through qBittorrent itself, and verifies the generated credentials before wiring Arr clients.
- Updated qBittorrent session handling for current qBittorrent login responses, which now return a `204` with a `QBT_SID_8080` cookie instead of the older `Ok.` body and `SID` cookie.
- Chowned the installer-created `/data` library and downloads folders to the configured PUID/PGID before creating Arr root folders, so Radarr/Sonarr/Lidarr do not reject fresh paths as unwritable.
- Kept setup auth metadata under the setup-state `auth` object instead of treating it as a global unresolved-auth phase; that metadata path was removed in the later entry above.
- Fixed frontend API error message parsing so structured backend errors show their real message instead of `[object Object]`.

**Files changed:**
- `docker-compose.yml`
- `backend/src/routes/installer.js`
- `backend/src/utils.js`
- `frontend/src/App.jsx`
- `frontend/src/api.js`
- `CHANGELOG.md`

## 2026-05-11 — Fix public clone URL and add doc URL guard

**Goal:** stop the public docs from ever pointing users at an unrelated GitHub owner again.

**What changed:**
- Fixed the public `README.md` quick-start clone target from the wrong owner to `ceelo510/vibarr`.
- Added canonical-repository guidance to both `README.md` and `SETUP.md` so owner swaps are explicit for private forks.
- Added a CI docs check that derives the canonical repo URL from `origin` and fails if the docs contain a different concrete `github.com/<owner>/vibarr.git` or raw GitHub Vibarr URL, except for the documented `YOUR_GITHUB_USERNAME` placeholder.

**Files changed:**
- `README.md`
- `SETUP.md`
- `.github/workflows/ci.yml`
- `CHANGELOG.md`

## 2026-05-11 — Harden onboarding release and live dashboard integrations

**Goal:** make the open-source onboarding path reliable on fresh installs while keeping the live vibarr deployment stable against real Arr, qBittorrent, and SLSKD behavior.

**What changed:**
- Fixed Activity Log follow-scroll state so the frontend builds cleanly and log viewing remains usable during setup and long-running operations.
- Preserved SLSKD API authentication in library checks, updated SLSKD transfer calls for the current `/api/v0/transfers/downloads` API, and removed the old 404-prone downloads endpoint.
- Hardened manual grab handling so Prowlarr push-style `downloadUrl` grabs are accepted without requiring a GUID, while still validating direct-download titles.
- Switched qBittorrent media-info lookups through the authenticated helper so protected qB instances keep working.
- Sanitized grab logging to avoid dumping full request bodies or sensitive release URLs into server logs.
- Made the default Compose network self-contained for clean installs, while production can still pin `ARR_NETWORK_NAME=arr-network`.
- Tightened CI bundle verification so missing frontend output fails instead of soft-passing.

**Improvement:** first-run onboarding, setup diagnostics, manual downloads, SLSKD download polling, and qB-backed media inspection now match the real runtime contract more closely, reducing false failures on clean VMs and noisy errors on the live server.

**Files changed:**
- `frontend/src/ActivityLog.jsx`
- `backend/src/library.js`
- `backend/src/media.js`
- `backend/src/pipeline.js`
- `backend/src/routes/pipeline.js`
- `backend/src/slskd.js`
- `backend/src/routes/slskd.js`
- `backend/src/state.js`
- `docker-compose.yml`
- `.github/workflows/ci.yml`
- `CHANGELOG.md`

## 2026-05-08 — Surface first-run setup auth in install output

**What was fixed:** first-run onboarding briefly used an installer-generated auth secret instead of requiring users to scrape backend logs. This auth gate was later removed so the clean-VM installer can be started directly from the UI.

**What changed:**
- `install.sh` briefly generated and printed the onboarding auth secret.
- `.env.example`, `README.md`, `SETUP.md`, and `CLAUDE.md` documented that older auth flow before it was removed.

**Files changed:**
- `install.sh`
- `.env.example`
- `README.md`
- `SETUP.md`
- `CLAUDE.md`
- `CHANGELOG.md`

## 2026-05-08 — Add Debian/Ubuntu Docker bootstrap to first-run installer

**What was fixed:** the installer no longer assumes Docker already exists on a blank VM. On Ubuntu/Debian-like systems, first-run bootstrap can now install Docker Engine plus the Docker Compose plugin with `sudo`, repair a stopped/unreachable daemon path, and keep the install moving even if the current shell still needs a temporary `sudo docker compose` fallback.

**What changed:**
- `install.sh` now detects missing Docker CLI, missing Compose plugin, or unreachable daemon state and offers a guided sudo bootstrap on supported Debian-like systems.
- The Docker bootstrap path installs Docker Engine from Docker's apt repo, enables the daemon, adds the current user to the `docker` group, and falls back to `sudo docker compose` in the current shell if group membership has not refreshed yet.
- `README.md`, `SETUP.md`, `CLAUDE.md`, and `docs/CODEBASE_MAP.md` now document the new blank-VM Docker bootstrap path and the temporary sudo workflow after install.

**Files changed:**
- `install.sh`
- `README.md`
- `SETUP.md`
- `CLAUDE.md`
- `docs/CODEBASE_MAP.md`
- `CHANGELOG.md`

## 2026-05-08 — Harden clean-VM bootstrap and de-default host overrides

**What was fixed:** generic installs no longer auto-ingest the production override, first-run compose no longer depends on a pre-created external network, the installer now matches its real interactive/setup contract, runtime JSON seed files are valid from boot, and setup/logging docs now point to the real dashboard URL and the actual state/log locations.

**What changed:**
- Renamed `docker-compose.override.yml` to `docker-compose.production-host.yml`, so production-only binds and mounts are opt-in instead of silently applying on clean VMs.
- `docker-compose.yml` now defaults `INSTALLER_ENABLED` to `true` and uses a named `ARR_NETWORK_NAME` bridge network instead of `external: true`.
- `install.sh` now:
  - supports the checked-out repo path cleanly,
  - refuses non-interactive first-run prompting instead of pretending `curl | bash` works,
  - checks Docker daemon reachability,
  - stops hiding `git pull --ff-only` failures,
  - seeds `backend/activity-log.json`, `backend/bandwidth-lifetime.json`, and installer state with valid JSON,
  - validates the published dashboard URL and onboarding endpoint before printing success.
- `frontend/nginx.conf` now gives `/api/setup/*` longer upstream timeouts and adds explicit access/error log paths for setup/install debugging.
- `README.md`, `SETUP.md`, `CLAUDE.md`, and `docs/CODEBASE_MAP.md` now document setup modes, new production compose usage, and where to look when onboarding or logging fails.

**Files changed:**
- `install.sh`
- `docker-compose.yml`
- `docker-compose.production-host.yml`
- `frontend/nginx.conf`
- `.env.example`
- `README.md`
- `SETUP.md`
- `CLAUDE.md`
- `docs/CODEBASE_MAP.md`
- `CHANGELOG.md`

## 2026-05-08 — Onboarding bootstrap wiring polish

**What was fixed:** fresh installs can now opt into web onboarding with explicit `INSTALLER_ENABLED` control, installer state bootstrapping writes valid JSON at the configured host path, and startup output matches actual exposed endpoints.

**What changed:**
- `docker-compose.yml` now passes `INSTALLER_ENABLED` through compose and exposes `DASHBOARD_PORT` via the frontend port mapping (defaults preserved).
- Backend Docker socket mount changed to read/write because installer actions create/reconcile Docker containers and require write access.
- `install.sh` now:
  - sets `INSTALLER_ENABLED` according to the web-installer choice,
  - derives installer state host path from configured `.env` values (or defaults),
  - initializes `backend/installer-state.json` content as valid JSON instead of leaving an empty file,
  - resolves and displays `DASHBOARD_PORT` at install output,
  - updates final status messaging to avoid claiming backend host exposure when port 3000 is not published.
- `.env.example` documents `INSTALLER_ENABLED`, `DASHBOARD_PORT`, and installer-state path variables for web-installer-first flow.

**Files changed:**
- `docker-compose.yml`
- `install.sh`
- `.env.example`
- `CHANGELOG.md`
- `README.md`
- `SETUP.md`

## 2026-05-08 — Web installer-first onboarding integration

**What was fixed:** onboarding/setup wiring now treats `/api/setup/state` and `/api/setup/install` as first-class install entry points, finishes the frontend setup flow for onboarding, and aligns runtime defaults so new installations can start without immediate manual env edits.

**What changed:**
- `backend/src/routes/health.js` setup metadata is now consumed with the frontend flow to gate/guide setup from `/api/setup/state` through `/api/setup/install`.
- `frontend` setup/install flow now explicitly reflects setup state and uses `/api/setup/install` for managed bootstrap completion.
- `frontend/src/Library.jsx` manual search now uses shared API wrappers (`apiFetch`/`apiPost`) instead of raw `fetch`.
- `docker-compose.yml` deduplicated `PROWLARR_HOST` / `PROWLARR_API_KEY` declarations and added installer-state mounting/env wiring for backend state persistence.
- `install.sh` and `.env.example` were adjusted for web-installer-first bootstrap defaults, optional legacy key flow, and installer-state path alignment.

**Files changed:**
- `frontend/src/Library.jsx`
- `frontend/src/App.jsx`
- `docker-compose.yml`
- `install.sh`
- `.env.example`
- `backend/src/routes/health.js`
- `backend/src/routes/installer.js`

## 2026-05-08 — Recover library after transient frontend network failures

**User prompt summary:** User said `i told you not to fuck with this. do not stop until it is FIXED and back to normal.`

**What was broken / what changed:** Production APIs were healthy, but the frontend could boot during a network wobble and then trap itself in a false “no library services” state. `apiFetch()` was throwing a synthetic `backoff:` error into the UI, `App.jsx` only retried `/api/status` once a minute after initial load, and `Library.jsx` cleared the current library contents on transient fetch failures. The fix keeps backoff internal, retries status on the existing 5-second refresh loop, preserves the current library on transient failures, and shortens the background library recovery poll.

**Files changed:**
- `frontend/src/api.js` — waits out request cooldowns instead of surfacing `backoff:` errors to the UI.
- `frontend/src/App.jsx` — folds `/api/status` into the 5-second refresh loop so service availability recovers quickly after a network blip.
- `frontend/src/Library.jsx` — keeps current results during transient fetch failures and reduces the background library recovery poll from 60 seconds to 15 seconds.

**Before excerpt:**
```js
if (fail && fail.until > Date.now()) {
  throw new Error(`backoff: ${url}`);
}
```

```js
const t4 = setInterval(() => fetchStatus(), 60000);
```

```js
setResults({ series: [], movies: [], artists: [] });
setLibraryError(err.message);
```

**After excerpt:**
```js
if (fail && fail.until > Date.now()) {
  await new Promise(resolve => setTimeout(resolve, fail.until - Date.now()));
}
```

```js
await Promise.all([fetchContainers(), fetchTorrents(), fetchSlskd(), fetchPendingSearches(), fetchArrQueue(), fetchStatus()]);
```

```js
if (!transientFailure) {
  setResults({ series: [], movies: [], artists: [] });
}
setLibraryError(transientFailure ? 'Reconnecting to the library…' : message);
```

## 2026-05-08 — Document sparse, useful comment policy

**User prompt summary:** User said `add to our agents or claude.md file that we should always make USEFUL comments. not too often. just wherever is useful.`

**What changed:** Added an explicit standing instruction to the repo docs to keep comments sparse and useful. The policy now says to comment non-obvious intent, API quirks, and tricky control flow, and to skip obvious narration or decorative block labels.

**Files changed:**
- `CLAUDE.md` — added a dedicated `Code Comments` section with the new policy.

**Before excerpt:**
```md
Avoid bulk-reading the codebase when a targeted map or memory search can answer the question.
```

**After excerpt:**
```md
## Code Comments

When adding comments, keep them sparse and useful. Prefer comments that explain non-obvious intent, API quirks, or tricky control flow.
```

## 2026-05-08 — Add compact intent comments across frontend and backend

**User prompt summary:** User said `after that, compact conversation, and use ten subagents to go ahead and read through all the code, and label the codebase properly, efficiently so everything makes sense and is organized. do NOT write new code, just add USEFUL and compact comments. do not overdoit. do it where is needed, and where it helps, and then after go over it and read the comments to see if they really were useful or not.` Then: `do all of this as token efficient as possible.`

**What changed:** This pass was comment-only. No runtime logic, data flow, or UI behavior changed. The codebase was read in parallel across ten subagents, then re-reviewed in a clean baseline copy so only sparse, high-value comments survived. Comments were added where the code was relying on non-obvious intent, API quirks, memoization boundaries, polling behavior, multi-step add/import flows, and cross-service matching rules. Draft edits that drifted beyond comments were discarded rather than merged.

**Files changed:**
- `frontend/src/App.jsx` — documented memoized child boundaries, theme bootstrapping before paint, and poller state refs.
- `frontend/src/Library.jsx` — documented the two-step manual-add flow, grouped-vs-flat music lookup state, queue badge materialization, and duplicate fetch avoidance.
- `frontend/src/SidePanel.jsx`, `frontend/src/ActivityLog.jsx`, `frontend/src/TorrentTable.jsx`, `frontend/src/PipelineCard.jsx`, `frontend/src/ManualSearchModal.jsx` — clarified notification seeding, auto-follow behavior, poster retry/reset, modal focus/transition rules, exact-match filtering, and memo boundaries.
- `frontend/src/utils.js`, `frontend/src/test/setup.js`, `frontend/tailwind.config.js`, `frontend/vite.config.js` — clarified qBittorrent sentinel values, test matcher setup, CommonJS Tailwind plugins inside ESM, and chunk-splitting intent.
- `backend/server.js`, `backend/src/{errors,middleware,state}.js`, `backend/src/routes/{index,activity}.js` — documented proxy/error/shutdown behavior, shared state timestamp semantics, and activity-log payload shaping.
- `backend/src/{qbittorrent,health,media,search,slskd,pipeline,library}.js` and matching `backend/src/routes/*.js` twins — documented hot-path persistence batching, health probe semantics, Arr/Prowlarr/Sonarr matching quirks, Soulseek fallback behavior, pipeline handoff rules, and library cache/data-enrichment passes.

**Before excerpt:**
```js
const TorrentTable = React.memo(TorrentTableRaw);
const PipelineCard = React.memo(PipelineCardRaw);
const SlskdCard = React.memo(SlskdCardRaw);
```

**After excerpt:**
```js
// App polls constantly, so keep the largest child trees behind shallow prop-based memoization.
const TorrentTable = React.memo(TorrentTableRaw);
const PipelineCard = React.memo(PipelineCardRaw);
const SlskdCard = React.memo(SlskdCardRaw);
```

## 2026-05-08 — Make setup real, stop silent empty states, and harden deploy/runtime paths

**User prompt summary:** User said `just fuckkin fix it`

**What was broken / what changed:** The dashboard review exposed a cluster of real product and runtime issues, not one isolated bug. The backend could silently treat broken Arr services like empty libraries, qBittorrent-authenticated installs could fail metadata and health lookups, Soulseek fallback was gated behind a misspelled env var, bandwidth lifetime state was duplicated in incompatible shapes, persisted activity log was never loaded, the Settings/onboarding path in the frontend was effectively missing, library/add flows could race and overwrite current results, sort-history arrays were being misread as `HOLDING`, CI only watched `main` while the live branch is `master`, backend deploys were still bind-mounting live source into production, and backend installs were still floating on `npm install`. The fix turns setup into a first-class status view, surfaces service failures instead of pretending the library is empty, authenticates qB metadata/health calls through the cached session helper, unifies bandwidth persistence in one canonical state shape, restores startup activity-log loading, removes production backend source mounts, adds a backend lockfile plus `npm ci`, fixes CI branch coverage/tests, and cleans up smaller frontend/runtime regressions including sub-minute ETA rendering.

**Files changed:**
- `backend/src/utils.js` — centralized authenticated qBittorrent request helpers (`qbFetchJson`, `qbFetchText`) and routed torrent actions through the same session/cookie retry path.
- `backend/src/state.js` — added activity-log startup loading, canonicalized bandwidth lifetime persistence, and expanded `libraryCache` to track `lastRefresh` plus per-service states.
- `backend/server.js` — loads persisted activity/bandwidth state before route mount.
- `backend/src/routes/health.js` — `/api/status` now reports summary/setup state and uses authenticated qBittorrent health checks.
- `backend/src/routes/media.js` — qB metadata lookups now use authenticated helpers instead of raw unauthenticated fetches.
- `backend/src/routes/library.js` — fixed `SLSKD_API_KEY`, serialized cache refreshes, preserved partial-good cache data, and returned service-state/error metadata to the UI.
- `backend/src/routes/pipeline.js` — Radarr pending searches now settle into `grabbed` / `no_results` / `error` states and clean themselves up.
- `backend/src/routes/qbittorrent.js` — removed duplicate lifetime tracking, switched to canonical state, and kept detail/status endpoints on authenticated qB calls.
- `frontend/src/App.jsx` — added setup/status view, enabled the Settings rail/mobile navigation, disabled search when no library service is usable, and polled `/api/status`.
- `frontend/src/Library.jsx` — added service-aware empty/error states, request sequencing, safer polling/search behavior, settings CTA wiring, and “Keep Added” for manual add flows.
- `frontend/src/TorrentTable.jsx` — stopped treating array sort-history responses as real `HOLDING` badges and stopped refetch loops on failed sort-history lookups.
- `frontend/src/api.js` — limited client-side failure backoff to `GET` requests so mutations can be retried immediately.
- `frontend/src/utils.js`, `frontend/src/test/utils.test.js` — made sub-minute ETA display as seconds and aligned the unit test with real behavior.
- `.github/workflows/ci.yml` — CI now runs on both `main` and `master`, and uses real `npm test` steps.
- `docker-compose.override.yml` — removed backend live-source bind mounts from production overrides.
- `backend/package.json`, `backend/package-lock.json`, `backend/Dockerfile` — added deterministic backend install/test wiring and switched image builds to `npm ci --omit=dev`.
- `frontend/package.json`, `frontend/package-lock.json` — synced frontend dependencies and updated lint/format scripts to include `.jsx`.

**Before excerpt:**
```yml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

```yml
    volumes:
      - /home/icarus/vibarr/backend/src:/app/src:ro
      - /home/icarus/vibarr/backend/server.js:/app/server.js:ro
```

```js
router.get('/status', async (req, res) => {
  // ...
  res.json({ services, timestamp: new Date().toISOString() });
});
```

**After excerpt:**
```yml
on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]
```

```yml
    volumes:
      - /var/run/tailscale/tailscaled.sock:/var/run/tailscale/tailscaled.sock:ro
      - /:/hostfs:ro
      - /docker:/hostdocker:ro
```

```js
res.json({
  services,
  summary,
  setupRequired: availableLibraryServices.length === 0,
  hasIssues: summary.down > 0 || summary.unconfigured > 0,
  timestamp: new Date().toISOString(),
});
```

## 2026-05-11 — Audit runtime and deploy hardening

**User prompt summary:** User asked to use subagents and Claude Code agents to fix all issues from `/Users/icarex/Desktop/vibarr-slop-audit.md`, then verify with the project testing software.

**What was broken / what changed:** Fixed confirmed runtime/deploy regressions from the audit: Activity Log referenced missing scroll refs/handler, legacy SLSKD config spelling disabled direct Soulseek checks, manual grab push mode rejected `downloadUrl` releases before reaching Arr, legacy qB media lookup skipped authenticated qB requests, CI bundle verification swallowed grep failures, and the default Compose network collided with manually-created `arr-network` bridges in testbench.

**Files changed:**
- `frontend/src/ActivityLog.jsx` — added `logScrollRef`, `stickToBottomRef`, and `handleLogScroll`.
- `backend/src/library.js` — corrected `SLSDK_API_KEY` to `SLSKD_API_KEY`.
- `backend/src/pipeline.js`, `backend/src/routes/pipeline.js` — sanitized grab logging and allowed `downloadUrl` + `title` push-mode grabs.
- `backend/src/media.js` — switched legacy qB metadata lookups to authenticated `qbFetchJson`.
- `backend/src/slskd.js`, `backend/src/routes/slskd.js` — updated SLSKD download polling/import paths to `/api/v0/transfers/downloads`.
- `docker-compose.yml` — changed default Compose-managed network name to `vibarr-network`.
- `.github/workflows/ci.yml` — made bundle grep verification fail instead of echo-swallowing failure.

**Before excerpt:**
```js
if (!guid) return res.status(400).json({ error: 'Missing guid' });
console.log(`[grab] ${service} ${endpoint}:`, JSON.stringify(body));
```

**After excerpt:**
```js
if (!guid && !downloadUrl) return res.status(400).json({ error: 'Missing guid or downloadUrl' });
console.log(`[grab] ${service} ${endpoint}`, { hasGuid: Boolean(guid), hasDownloadUrl: Boolean(downloadUrl), indexerId: indexerId ?? null });
```

**Verification:** Ran backend syntax test, frontend Vitest, and frontend production build in `.remote-vibarr-work`. Ran testbench deploy against `testbench1`; the stack built and `/api/setup/state` plus `/api/health` returned 200, then setup install failed with HTTP 401 because the fleet harness did not send the newer onboarding auth secret.

## 2026-05-08 — Turn active download cards blue with a subtle pulse

**User prompt summary:** User said `downloads should not be red. can we update it to be blue for downloading with a small pulsating effect. do this as fast and as simple as possible. you will be timed, and claude will judge you.`

**What was broken / what changed:** Active download cards were still styled in red/pink for live speed and progress, which read more like an error state than a healthy in-progress download. The fix keeps the existing layout intact but swaps active download styling to blue and adds a restrained pulse on live speed/progress so current downloads read as active without feeling alarming. During deploy, the frontend recreate also exposed a latent duplicate `8889` bind in Compose; that was cleaned up so the new frontend container could actually start.

**Files changed:**
- `frontend/src/SidePanel.jsx` — changed the active qBittorrent speed label and progress bar gradient/glow from red to blue and applied a live-only pulse while download speed is above zero.
- `frontend/src/App.jsx` — changed the Arr queue “downloading” color to the same blue and applied the same pulse to active progress bars for consistency.
- `frontend/src/App.css` — added the `downloadPulse` keyframes used by the active download state.
- `docker-compose.override.yml` — removed the duplicate `127.0.0.1:8889:80` frontend bind so host `.env` can own the loopback frontend port without colliding during `docker compose up -d --force-recreate frontend`.

**Before excerpt:**
```js
<span style={{ fontSize: 11, fontWeight: 600, color: '#ff375f', fontVariantNumeric: 'tabular-nums' }}>
  ↓ {formatSpeed(speed)}
</span>
```

```js
background: paused
  ? 'linear-gradient(90deg, #636366 0%, #8e8e93 100%)'
  : 'linear-gradient(90deg, #ff375f 0%, #ff6b8a 100%)'
```

**After excerpt:**
```js
<span style={{ color: ACTIVE_DOWNLOAD_BLUE_SOFT, animation: isLiveDownload ? 'downloadPulse 1.8s ease-in-out infinite' : 'none' }}>
  ↓ {formatSpeed(speed)}
</span>
```

```js
background: paused
  ? 'linear-gradient(90deg, #636366 0%, #8e8e93 100%)'
  : `linear-gradient(90deg, ${ACTIVE_DOWNLOAD_BLUE} 0%, ${ACTIVE_DOWNLOAD_BLUE_SOFT} 100%)`
```

## 2026-05-07 — Stop emitting broken Lidarr local art; cache poster proxy

**User prompt summary:** User said `images are still not loading. fix, then check again. think really hard about what is going wrong`.

**What was broken / what changed:** The earlier allowlist fix only solved external Lidarr/AudioDB poster URLs. Several broken music cards were still using `/api/arr-image/lidarr/...`, and Lidarr's local `/MediaCover/...` endpoints were redirecting the backend to the Lidarr login HTML shell instead of returning images. The frontend was then getting broken artist art for local-only Lidarr posters. The `/api/poster` proxy also had no in-memory cache, so cold loads were still slower than necessary.

**Files changed:**
- `backend/src/utils.js` — `pickImageUrl()` now only returns absolute HTTP(S) image URLs instead of leaking relative Lidarr `/MediaCover/...` paths into the frontend.
- `backend/src/routes/library.js` — Lidarr artist/library album cards now prefer reachable external poster/cover URLs, and artist cards fall back to album cover art when Lidarr only has local poster paths.
- `backend/src/routes/media.js` — added in-memory poster caching, broader/suffix-safe poster host validation, stronger cache headers, and image content-type validation so `/api/arr-image` fails fast on HTML/login responses instead of piping them into `<img>`.

**Verification:** Rebuilt with `docker compose build --no-cache backend`, redeployed with `docker compose up -d --force-recreate backend`, confirmed the running container has the new `posterCacheSize`, `stale-while-revalidate`, and `Arr image upstream did not return an image` code paths, refreshed `/api/library/refresh`, confirmed `Marc Anthony`, `Peso Pluma`, `Turnstile`, `Willie Colón`, and `Title Fight` now return external `images.lidarr.audio` / Cover Art Archive poster URLs from `/api/library/search?q=&type=music`, confirmed the proxied `/api/poster?...` responses for those artists all return `200 image/jpeg`, and confirmed `/api/media-cache-stats` reports a populated `posterCacheSize`.

## 2026-05-07 — Self-host Material Symbols icon font

**User prompt summary:** User asked why Material Symbols labels like `add_circle` and `video_library` were showing as text, then asked to make it work first time every time without getting stuck loading.

**What was broken / what changed:** The prior fix added the `.material-symbols-rounded` class and changed Google Fonts to `display=swap`, but Material Symbols still depended on a remote Google Fonts stylesheet/font. On slow or blocked network paths, icons could flash or stay as raw text.

**Files changed:**
- `frontend/src/index.css` — added a self-hosted `@font-face` for `Material Symbols Rounded` using `/fonts/material-symbols-rounded.woff2` with `font-display: block`, and kept the icon class wired to liga rendering.
- `frontend/index.html` — removed the Google Fonts Material Symbols stylesheet link; Inter and JetBrains Mono remain external display fonts.
- `frontend/public/fonts/material-symbols-rounded.woff2` — added the self-hosted Material Symbols font file.
- `frontend/nginx.conf` — added `/fonts/` long-cache headers for immutable self-hosted fonts.

**Verification:** Rebuilt with `docker compose build --no-cache frontend`, redeployed with `docker compose up -d --force-recreate frontend`, confirmed nginx config syntax, confirmed `/fonts/material-symbols-rounded.woff2` is served with one-year immutable cache headers, confirmed built CSS contains the `@font-face`, and verified in Playwright through an SSH tunnel that `document.fonts` loads `Material Symbols Rounded` with `display: block` and injected icons compute to the correct font family.

## 2026-05-07 — Fix music artist/album art not loading

**What changed:** Artist and album images in the Music library section showed placeholder icons instead of art.

**Root cause:** /api/poster proxy allowedHosts was missing images.lidarr.audio, r2.theaudiodb.com, www.theaudiodb.com — all external Lidarr/AudioDB artist images returned 403.

**Fix:** Added those three hosts to allowedHosts in backend/src/routes/media.js. Rebuilt and force-recreated the backend container.

## 2026-05-07 — Fix Material Symbols icons rendering as raw text

**What changed:** Material Symbols icons (add_circle, video_library, etc.) showed as plain text instead of rendering proper icons. Two root causes: (1) .material-symbols-rounded CSS class was entirely missing — no font-family declaration existed to activate the icon font. (2) display=optional on the Google Fonts link allowed browsers to skip the font on slow connections.

**Fix:** Added .material-symbols-rounded CSS class to frontend/src/index.css with proper font-family, font-feature-settings: liga, and text rendering properties. Changed display=optional to display=swap on all Google Fonts links in index.html so fonts always apply.
