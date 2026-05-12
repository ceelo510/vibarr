#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/ceelo510/vibarr.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${INSTALL_DIR:-}" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -d "$SCRIPT_DIR/backend" ] && [ -d "$SCRIPT_DIR/frontend" ]; then
  INSTALL_DIR="$SCRIPT_DIR"
  USING_CHECKOUT=1
else
  INSTALL_DIR="${INSTALL_DIR:-$HOME/vibarr}"
  USING_CHECKOUT=0
fi

DEFAULT_INSTALLER_STATE_HOST_PATH="./backend/installer-state.json"
DEFAULT_INSTALLER_STATE_PATH="/app/installer-state.json"
DEFAULT_DASHBOARD_PORT=8888
DEFAULT_ACTIVITY_LOG_JSON='[]'
DEFAULT_BANDWIDTH_LIFETIME_JSON='{"baseline":{"dl":0,"ul":0},"lastSession":{"dl":0,"ul":0}}'
DEFAULT_INSTALLER_STATE_JSON='{"managed":false,"installedAt":null,"serviceConfig":{},"services":{},"setup":null,"lastInstallError":null}'

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'
DOCKER_PREFIX=()
SUDO_DOCKER_FALLBACK=0

info()  { echo -e "${GREEN}==>${NC} ${BOLD}$1${NC}"; }
warn()  { echo -e "${YELLOW}==>${NC} $1"; }
err()   { echo -e "${RED}ERROR:${NC} $1" >&2; }
step()  { echo -e "  ${DIM}$1${NC}"; }

retry_command() {
  local attempts=$1
  local sleep_seconds=$2
  local label=$3
  shift 3

  local attempt=1
  local exit_code=0
  while [ "$attempt" -le "$attempts" ]; do
    if "$@"; then
      return 0
    fi
    exit_code=$?
    if [ "$attempt" -lt "$attempts" ]; then
      warn "$label failed (attempt ${attempt}/${attempts}). Retrying in ${sleep_seconds}s..."
      sleep "$sleep_seconds"
    fi
    attempt=$((attempt + 1))
  done

  return "$exit_code"
}

has_tty() {
  [ -t 0 ] && [ -t 1 ]
}

require_tty() {
  local reason=$1
  if has_tty; then
    return 0
  fi
  err "$reason"
  echo "  Run ./install.sh from an interactive shell after cloning the repo,"
  echo "  or download the script and execute it locally without piping it to bash."
  exit 1
}

docker_cmd() {
  "${DOCKER_PREFIX[@]}" docker "$@"
}

docker_compose() {
  docker_cmd compose "$@"
}

docker_compose_label() {
  if [ "${#DOCKER_PREFIX[@]}" -gt 0 ]; then
    printf 'sudo docker compose\n'
  else
    printf 'docker compose\n'
  fi
}

is_supported_debian_like() {
  [ -r /etc/os-release ] || return 1
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) return 0 ;;
  esac
  printf '%s\n' "${ID_LIKE:-}" | grep -qi 'debian'
}

resolve_docker_repo_os() {
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian)
      printf '%s\n' "$ID"
      return 0
      ;;
  esac
  if printf '%s\n' "${ID_LIKE:-}" | grep -qi 'ubuntu'; then
    printf 'ubuntu\n'
    return 0
  fi
  if printf '%s\n' "${ID_LIKE:-}" | grep -qi 'debian'; then
    printf 'debian\n'
    return 0
  fi
  return 1
}

resolve_docker_repo_codename() {
  local repo_os=$1
  local codename=""
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "$repo_os" = "ubuntu" ] && [ -n "${UBUNTU_CODENAME:-}" ]; then
    codename="$UBUNTU_CODENAME"
  else
    codename="${VERSION_CODENAME:-}"
  fi
  [ -n "$codename" ] || return 1
  printf '%s\n' "$codename"
}

bootstrap_docker_with_sudo() {
  local reason=$1
  local prompt repo_os repo_codename arch

  require_tty "Docker bootstrap needs an interactive shell."

  if ! is_supported_debian_like; then
    err "Automatic Docker bootstrap is only supported on Ubuntu/Debian-like systems."
    echo "  Install Docker Engine and the Docker Compose plugin manually, then rerun ./install.sh."
    exit 1
  fi

  if ! command -v sudo &>/dev/null; then
    err "Docker bootstrap requires sudo on Ubuntu/Debian-like systems."
    echo "  Install Docker manually or rerun as a user with sudo access."
    exit 1
  fi

  case "$reason" in
    missing_cli)
      prompt="Docker Engine and the Docker Compose plugin are missing. Install them now with sudo?"
      ;;
    missing_compose)
      prompt="Docker is installed, but the Docker Compose plugin is missing. Install or repair Docker now with sudo?"
      ;;
    daemon_unreachable)
      prompt="Docker is installed, but the daemon is unreachable. Install or repair Docker now with sudo?"
      ;;
    *)
      prompt="Install or repair Docker Engine and the Docker Compose plugin now with sudo?"
      ;;
  esac

  echo
  warn "$prompt"
  read -r -p "  Proceed? [Y/n] " REPLY
  if [[ ! "${REPLY:-Y}" =~ ^[Yy]?$ ]]; then
    err "Docker is required to continue."
    exit 1
  fi

  repo_os="$(resolve_docker_repo_os)" || {
    err "Could not determine the correct Docker apt repository for this OS."
    exit 1
  }
  repo_codename="$(resolve_docker_repo_codename "$repo_os")" || {
    err "Could not determine the correct apt codename for this OS."
    exit 1
  }
  arch="$(dpkg --print-architecture)"

  echo
  info "Installing Docker Engine and Compose plugin"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${repo_os}/gpg" | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$arch" "$repo_os" "$repo_codename" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if command -v systemctl &>/dev/null; then
    sudo systemctl enable --now docker
  fi
  if getent group docker >/dev/null 2>&1 && ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
    sudo usermod -aG docker "$USER"
    step "Added $USER to the docker group"
  fi
}

finalize_docker_access() {
  if ! command -v docker &>/dev/null; then
    err "Docker is still not installed after bootstrap."
    exit 1
  fi

  if docker compose version &>/dev/null && docker info &>/dev/null; then
    DOCKER_PREFIX=()
    SUDO_DOCKER_FALLBACK=0
    return 0
  fi

  if command -v sudo &>/dev/null && sudo docker compose version &>/dev/null && sudo docker info &>/dev/null; then
    DOCKER_PREFIX=(sudo)
    SUDO_DOCKER_FALLBACK=1
    return 0
  fi

  err "Docker is installed, but the CLI still cannot reach a working daemon."
  echo "  Try: sudo systemctl status docker"
  echo "  Then rerun ./install.sh."
  exit 1
}

read_env_value() {
  local key=$1
  [ -f .env ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]+=/, "", $0); print $0; exit }' .env
}

set_env_value() {
  local var=$1 value=$2
  if grep -q "^${var}=" .env; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^${var}=.*|${var}=${value}|" .env
    else
      sed -i "s|^${var}=.*|${var}=${value}|" .env
    fi
  elif grep -q "^# ${var}=" .env; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^# ${var}=.*|${var}=${value}|" .env
    else
      sed -i "s|^# ${var}=.*|${var}=${value}|" .env
    fi
  else
    echo "${var}=${value}" >> .env
  fi
}

to_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_installer_enabled() {
  local enabled
  enabled="$(read_env_value "INSTALLER_ENABLED")"
  enabled="${enabled//$'\r'/}"
  if [ -z "$enabled" ]; then
    printf 'true\n'
  else
    printf '%s\n' "$enabled"
  fi
}

resolve_installer_state_host_path() {
  local host_path
  host_path="$(read_env_value "INSTALLER_STATE_HOST_PATH")"
  host_path="${host_path//$'\r'/}"
  if [ -z "$host_path" ]; then
    printf '%s\n' "$DEFAULT_INSTALLER_STATE_HOST_PATH"
  else
    printf '%s\n' "$host_path"
  fi
}

resolve_dashboard_port() {
  local dashboard_port
  dashboard_port="$(read_env_value "DASHBOARD_PORT")"
  dashboard_port="${dashboard_port//$'\r'/}"
  if [[ "$dashboard_port" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$dashboard_port"
    return
  fi
  printf '%s\n' "$DEFAULT_DASHBOARD_PORT"
}

resolve_setup_bootstrap_token() {
  local setup_token
  setup_token="$(read_env_value "SETUP_BOOTSTRAP_TOKEN")"
  setup_token="${setup_token//$'\r'/}"
  printf '%s\n' "$setup_token"
}

generate_setup_bootstrap_token() {
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  printf '\n'
}

ensure_setup_bootstrap_token() {
  local setup_token
  if [ "${WEB_INSTALLER_ENABLED:-0}" -ne 1 ]; then
    SETUP_BOOTSTRAP_TOKEN=""
    return 0
  fi

  setup_token="$(resolve_setup_bootstrap_token)"
  if [ -z "$setup_token" ]; then
    setup_token="$(generate_setup_bootstrap_token)"
    set_env_value "SETUP_BOOTSTRAP_TOKEN" "$setup_token"
    step "Generated setup bootstrap token"
  fi

  SETUP_BOOTSTRAP_TOKEN="$setup_token"
}

ensure_json_file() {
  local file_path=$1
  local default_json=$2
  local dir
  dir="$(dirname "$file_path")"
  mkdir -p "$dir"
  if [ -s "$file_path" ]; then
    return 0
  fi
  printf '%s\n' "$default_json" > "$file_path"
}

expand_path_from_install_dir() {
  local path=$1
  case "$path" in
    ./*) printf '%s/%s\n' "$INSTALL_DIR" "${path#./}" ;;
    *) printf '%s\n' "$path" ;;
  esac
}

binding_probe_host() {
  case "$1" in
    ""|0.0.0.0|::|[::]) printf '127.0.0.1\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

binding_display_host() {
  case "$1" in
    ""|0.0.0.0|::|[::]) printf 'localhost\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

resolve_frontend_binding() {
  local published host port
  published="$(docker_compose port frontend 80 2>/dev/null | head -n 1 | tr -d '\r')" || return 1
  [ -n "$published" ] || return 1

  if [[ "$published" == \[*\]:* ]]; then
    host="${published%%]*}"
    host="${host#[}"
    port="${published##*]:}"
  elif [[ "$published" == *:* ]]; then
    host="${published%:*}"
    port="${published##*:}"
  else
    host="127.0.0.1"
    port="$published"
  fi

  [ -n "$port" ] || return 1
  printf '%s %s\n' "$host" "$port"
}

probe_http_path() {
  local host=$1
  local port=$2
  local path=$3
  local status_line status_code

  exec 3<>"/dev/tcp/${host}/${port}" || return 1
  printf 'GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$path" "$host" >&3
  IFS= read -r status_line <&3 || true
  exec 3<&-
  exec 3>&-

  status_code="$(printf '%s' "$status_line" | awk '{print $2}')"
  case "$status_code" in
    200|204|301|302|304) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo
    err "Installation failed (exit code $exit_code)."
    echo "  Check the messages above, then inspect:"
    echo "  cd $INSTALL_DIR && $(docker_compose_label) logs -f backend frontend"
    echo "  https://github.com/ceelo510/vibarr/issues"
  fi
  exit $exit_code
}
trap cleanup EXIT

echo
info "Vibarr installer"
echo

docker_issue=""
if ! command -v docker &>/dev/null; then
  docker_issue="missing_cli"
elif ! docker compose version &>/dev/null; then
  docker_issue="missing_compose"
elif ! docker info &>/dev/null; then
  docker_issue="daemon_unreachable"
fi

if [ -n "$docker_issue" ]; then
  bootstrap_docker_with_sudo "$docker_issue"
fi

finalize_docker_access
step "Docker CLI found"
step "Docker Compose found"
if [ "$SUDO_DOCKER_FALLBACK" -eq 1 ]; then
  step "Docker daemon reachable via sudo"
else
  step "Docker daemon reachable"
fi

if command -v git &>/dev/null; then
  step "git found"
else
  err "git is required. Install it:"
  echo "  apt install git   # Debian/Ubuntu"
  echo "  brew install git  # macOS"
  exit 1
fi

if [ "$USING_CHECKOUT" -eq 1 ]; then
  info "Using checked-out repository at $INSTALL_DIR"
  cd "$INSTALL_DIR"
elif [ -d "$INSTALL_DIR" ]; then
  warn "Directory $INSTALL_DIR already exists."
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    err "$INSTALL_DIR exists but is not a git checkout."
    echo "  Move it aside or set INSTALL_DIR to a different path."
    exit 1
  fi
  require_tty "Updating an existing installation requires confirmation."
  read -r -p "  Update existing installation with git pull --ff-only? [Y/n] " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]?$ ]]; then
    info "Aborted."
    exit 0
  fi
  cd "$INSTALL_DIR"
  info "Updating repository"
  git pull --ff-only
else
  info "Cloning vibarr to $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

if [ -f .env ]; then
  warn ".env already exists - reusing existing configuration."
  INSTALLER_STATE_HOST_PATH="$(resolve_installer_state_host_path)"
  if to_bool "$(resolve_installer_enabled)"; then
    WEB_INSTALLER_ENABLED=1
  else
    WEB_INSTALLER_ENABLED=0
  fi
else
  require_tty "First-run configuration is interactive."
  echo
  info "Configuration"
  echo "  Web onboarding is enabled by default for a clean VM."
  echo "  Choose manual mode only if you already have Arr API keys."
  echo

  cp .env.example .env

  prompt_key() {
    local var=$1 label=$2 default=${3:-}
    local val=""
    while [ -z "$val" ]; do
      read -r -p "  $label [$default]: " val
      val="${val:-$default}"
      if [ -z "$val" ]; then
        err "$label is required."
      fi
    done
    set_env_value "$var" "$val"
  }

  prompt_optional() {
    local var=$1 label=$2
    local val=""
    read -r -p "  $label (optional): " val
    if [ -n "$val" ]; then
      set_env_value "$var" "$val"
    fi
  }

  read -r -p "  Use web onboarding in the Settings view after first boot? [Y/n] " USE_WEB_SETUP
  USE_WEB_SETUP="${USE_WEB_SETUP:-Y}"
  WEB_INSTALLER_ENABLED=1

  if [[ "$USE_WEB_SETUP" =~ ^[Nn]$ ]]; then
    WEB_INSTALLER_ENABLED=0
    set_env_value "INSTALLER_ENABLED" "false"
    prompt_key "RADARR_API_KEY" "Radarr API key"
    prompt_key "SONARR_API_KEY" "Sonarr API key"
    prompt_key "LIDARR_API_KEY" "Lidarr API key"
  else
    echo
    info "Web onboarding enabled."
    echo "  The first-run UI lives at the dashboard root URL; open Settings there to continue."
    set_env_value "INSTALLER_ENABLED" "true"
    set_env_value "INSTALLER_STATE_PATH" "$DEFAULT_INSTALLER_STATE_PATH"
    set_env_value "INSTALLER_STATE_HOST_PATH" "$DEFAULT_INSTALLER_STATE_HOST_PATH"
  fi

  prompt_optional "QBITTORRENT_USER" "qBittorrent username"
  prompt_optional "QBITTORRENT_PASS" "qBittorrent password"
  prompt_optional "SLSKD_API_KEY" "SLSKD API key"
  prompt_optional "PROWLARR_API_KEY" "Prowlarr API key"

  INSTALLER_STATE_HOST_PATH="$(resolve_installer_state_host_path)"
  step "Configuration saved to .env"
fi

ensure_setup_bootstrap_token

ensure_json_file "backend/activity-log.json" "$DEFAULT_ACTIVITY_LOG_JSON"
ensure_json_file "backend/bandwidth-lifetime.json" "$DEFAULT_BANDWIDTH_LIFETIME_JSON"
if [ -z "${INSTALLER_STATE_HOST_PATH:-}" ]; then
  INSTALLER_STATE_HOST_PATH="$(resolve_installer_state_host_path)"
fi
ensure_json_file "$INSTALLER_STATE_HOST_PATH" "$DEFAULT_INSTALLER_STATE_JSON"

echo
info "Validating compose config"
docker_compose config >/dev/null

echo
info "Building and starting containers"
step "Docker image pulls can fail transiently on fresh VMs; the installer retries automatically."
retry_command 4 5 "docker compose build" docker_compose build --no-cache
retry_command 3 5 "docker compose up" docker_compose up -d --remove-orphans

echo
info "Waiting for backend health"
for _ in $(seq 1 30); do
  sleep 2
  if docker_compose exec -T backend node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" >/dev/null 2>&1; then
    BACKEND_READY=1
    break
  fi
done

if [ "${BACKEND_READY:-0}" -ne 1 ]; then
  warn "Backend health check timed out."
  echo "  cd $INSTALL_DIR && $(docker_compose_label) logs backend"
  exit 1
fi

echo
info "Waiting for frontend"
for _ in $(seq 1 30); do
  sleep 2
  binding="$(resolve_frontend_binding || true)"
  [ -n "${binding:-}" ] || continue

  bind_host="${binding%% *}"
  bind_port="${binding##* }"
  probe_host="$(binding_probe_host "$bind_host")"
  display_host="$(binding_display_host "$bind_host")"

  if ! probe_http_path "$probe_host" "$bind_port" "/"; then
    continue
  fi

  if [ "${WEB_INSTALLER_ENABLED:-0}" -eq 1 ] && ! probe_http_path "$probe_host" "$bind_port" "/api/setup/state"; then
    continue
  fi

  DASHBOARD_URL="http://${display_host}:${bind_port}"
  break
done

if [ -z "${DASHBOARD_URL:-}" ]; then
  warn "Frontend did not answer on the published dashboard URL."
  echo "  cd $INSTALL_DIR && $(docker_compose_label) logs frontend"
  exit 1
fi

ACTIVITY_LOG_PATH="$(expand_path_from_install_dir "./backend/activity-log.json")"
BANDWIDTH_LIFETIME_PATH="$(expand_path_from_install_dir "./backend/bandwidth-lifetime.json")"
INSTALLER_STATE_PATH_DISPLAY="$(expand_path_from_install_dir "$INSTALLER_STATE_HOST_PATH")"

echo
info "Vibarr is running"
echo "  Dashboard: ${DASHBOARD_URL}"
echo "  API:       ${DASHBOARD_URL}/api"
if [ "${WEB_INSTALLER_ENABLED:-0}" -eq 1 ]; then
  echo "  Setup:     ${DASHBOARD_URL} (open Settings to continue onboarding)"
  echo "  Token:     ${SETUP_BOOTSTRAP_TOKEN} (saved in .env as SETUP_BOOTSTRAP_TOKEN)"
  echo "             Enter this token when the onboarding flow asks for setup access."
fi
echo "  Backend:   internal-only (proxied through the frontend)"
echo
echo "  Runtime files:"
echo "  Activity:  ${ACTIVITY_LOG_PATH}"
echo "  Bandwidth: ${BANDWIDTH_LIFETIME_PATH}"
echo "  Installer: ${INSTALLER_STATE_PATH_DISPLAY}"
echo
if [ "$SUDO_DOCKER_FALLBACK" -eq 1 ]; then
  echo "  Note:      Docker is working through sudo in this shell. Re-login or run newgrp docker"
  echo "             later if you want to drop the sudo prefix for future Docker commands."
fi
echo "  Logs:      cd $INSTALL_DIR && $(docker_compose_label) logs -f backend frontend"
echo "  Stop:      cd $INSTALL_DIR && $(docker_compose_label) down"
echo "  Update:    cd $INSTALL_DIR && git pull --ff-only && $(docker_compose_label) build --no-cache && $(docker_compose_label) up -d --force-recreate"
echo
