# Setup Notes

## Canonical repository

The public repository this guide refers to is:

```bash
https://github.com/ceelo510/vibarr.git
```

If you are using your own private fork or mirror, swap the GitHub owner in the clone commands you share with collaborators. The install flow stays the same.

## Quick start

```bash
git clone https://github.com/ceelo510/vibarr.git
cd vibarr
./install.sh
```

## Supported bootstrap paths

### 1. Web onboarding-first

Use this on a clean VM.

- Leave `INSTALLER_ENABLED=true` in `.env`.
- Leave `RADARR_API_KEY`, `SONARR_API_KEY`, and `LIDARR_API_KEY` blank.
- Run `./install.sh` from an interactive shell.
- If Docker Engine or the Docker Compose plugin is missing on Ubuntu/Debian-like systems, let the installer add them with `sudo`.
- If `SETUP_BOOTSTRAP_TOKEN` is blank, the installer generates one, saves it in `.env`, and prints it at the end.
- Open the dashboard root URL after startup and continue from the in-app Settings view.

Important: the setup UI is part of the main frontend app. There is no dedicated frontend `/setup` page.

### 2. Manual env-first

Use this if the media stack already exists and you only need the dashboard.

- Set `INSTALLER_ENABLED=false`.
- Fill `RADARR_API_KEY`, `SONARR_API_KEY`, and `LIDARR_API_KEY` in `.env`.
- Start the stack with `docker compose up -d`.

## Compose defaults

- `docker-compose.yml` is now portable by itself.
- `ARR_NETWORK_NAME` defaults to `arr-network`, and Compose creates or reuses that named bridge network automatically.
- `DASHBOARD_PORT` defaults to `8888`.
- `INSTALLER_STATE_HOST_PATH` defaults to `./backend/installer-state.json`.
- `INSTALLER_STATE_PATH` defaults to `/app/installer-state.json`.
- `SETUP_BOOTSTRAP_TOKEN` can be set manually, but the installer will generate one automatically for web onboarding when it is blank.

## Production host overrides

The old `docker-compose.override.yml` auto-load path was removed because it hard-coded the production host and broke generic installs.

Production-specific mounts and fixed LAN binds now live in:

```text
docker-compose.production-host.yml
```

Use it explicitly on the production host:

```bash
docker compose -f docker-compose.yml -f docker-compose.production-host.yml up -d
docker compose -f docker-compose.yml -f docker-compose.production-host.yml build --no-cache frontend
docker compose -f docker-compose.yml -f docker-compose.production-host.yml up -d --force-recreate frontend
```

## Runtime JSON files

`install.sh` initializes these files with valid JSON when they are missing or empty:

- `backend/activity-log.json`
- `backend/bandwidth-lifetime.json`
- `backend/installer-state.json` by default, or whatever `INSTALLER_STATE_HOST_PATH` points to
- `.env` for `SETUP_BOOTSTRAP_TOKEN`

## Logs and setup triage

Start here when onboarding is stuck, setup requests time out, or logging appears empty:

```bash
docker compose logs -f backend frontend
docker compose port frontend 80
docker compose exec frontend tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

Then inspect the runtime state files:

- `backend/installer-state.json`
- `backend/activity-log.json`
- `backend/bandwidth-lifetime.json`

Expected first-run behavior on a clean VM:

- on Ubuntu/Debian-like systems, `install.sh` can install Docker Engine and the Compose plugin automatically if `sudo` is available
- the dashboard root URL loads even if no library service is configured yet
- the app pushes you toward the Settings view when setup is still required
- `/api/setup/state` stays available while `INSTALLER_ENABLED=true`
- the installer prints the setup bootstrap token and persists it to `.env` as `SETUP_BOOTSTRAP_TOKEN`
- if the installer had to add your user to the `docker` group, follow-up commands in the same shell may need `sudo docker compose ...` until you re-login or run `newgrp docker`

## Docker socket access

The backend uses Docker APIs during `/api/setup/*` operations, so Compose mounts:

```yaml
/var/run/docker.sock:/var/run/docker.sock
```

with write access. This is required for container creation and reconciliation during bootstrap.
