# vibarr

vibarr runs as two containers:

- `vibarr-backend` (Express API) on internal port `3000`
- `vibarr-frontend` (Nginx + Vite static assets) on host `DASHBOARD_PORT`

`docker-compose.yml` mounts the backend `docker.sock` for container management and proxies `/api/*` from the frontend to the backend.

## Canonical repository

The canonical public repository for this project is:

```bash
https://github.com/ceelo510/vibarr.git
```

If you publish your own private fork or mirror, replace the GitHub owner in the clone commands below with your own repository path.

## Quick start

```bash
git clone https://github.com/ceelo510/vibarr.git
cd vibarr
./install.sh
```

`install.sh` is interactive on first run. Do not pipe it to `bash`. If you only downloaded the script, run it from a local interactive shell and let it clone the repo for you.

On Ubuntu/Debian-like systems, `install.sh` can now install Docker Engine and the Docker Compose plugin for you with `sudo` when Docker is missing or the daemon is unreachable.

## Setup modes

- `INSTALLER_ENABLED=true` is the default clean-VM path. Leave `RADARR_API_KEY`, `SONARR_API_KEY`, and `LIDARR_API_KEY` blank, start the stack, open the dashboard root URL, then finish setup from the in-app Settings view.
- `INSTALLER_ENABLED=false` is the manual path. Set the Arr API keys in `.env` before startup and treat the dashboard as a client for an already-running stack.

## Compose files

- `docker-compose.yml` is the portable default for local installs and clean VMs.
- `docker-compose.production-host.yml` is the production-host override. It is no longer auto-loaded.
- On the production host, use both files explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.production-host.yml up -d
```

## First run on a clean VM

- On Ubuntu/Debian-like systems, `install.sh` offers a one-stop Docker bootstrap path if Docker is missing or broken and `sudo` is available.
- Compose creates or reuses the named bridge network from `ARR_NETWORK_NAME` automatically. There is no external-network precreate step anymore.
- `install.sh` seeds `backend/activity-log.json`, `backend/bandwidth-lifetime.json`, and `backend/installer-state.json` with valid JSON if they are missing or empty.
- When web onboarding is enabled, `install.sh` also preserves or generates `SETUP_BOOTSTRAP_TOKEN`, writes it to `.env`, and prints it in the final success output so you can unlock setup immediately.
- The backend stays internal-only on port `3000`; the public entry point is the frontend on `DASHBOARD_PORT` (default `8888`).
- The setup UI is the dashboard root URL. There is no standalone frontend `/setup` route.
- If the installer had to add your user to the `docker` group, it may keep using `sudo docker compose` in the current shell until you re-login or run `newgrp docker`.

## Logs and state

- Backend and frontend logs: `docker compose logs -f backend frontend`
- Published dashboard URL: `docker compose port frontend 80`
- Installer state: `backend/installer-state.json`
- Activity log persistence: `backend/activity-log.json`
- Bandwidth lifetime persistence: `backend/bandwidth-lifetime.json`
- Setup token: `.env` as `SETUP_BOOTSTRAP_TOKEN`
- Nginx setup/install request logs: `docker compose exec frontend tail -f /var/log/nginx/access.log /var/log/nginx/error.log`

## Endpoint notes

- Dashboard: `http://localhost:${DASHBOARD_PORT}` by default
- Backend API: `http://localhost:${DASHBOARD_PORT}/api`
- Setup API: `http://localhost:${DASHBOARD_PORT}/api/setup/state` and `/api/setup/install` when onboarding is enabled
