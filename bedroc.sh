#!/usr/bin/env bash
# =============================================================================
# bedroc.sh — set up, run, update and back up a self-hosted Bedroc server.
#
#   bash bedroc.sh setup              first-time setup (creates the env file + secrets)
#   bash bedroc.sh up                 start the stack / apply config changes
#   bash bedroc.sh update             after `git pull`: backup → rebuild → restart
#   bash bedroc.sh help               everything else
#
# Principles:
#   - Read-only unless you say yes. Anything that changes your machine is
#     announced first and needs a "y" (or --yes). Destructive actions (restore)
#     need you to type the project name — --yes never skips that.
#   - Never deletes Docker volumes. `down` keeps all data.
#   - Never touches anything outside this directory except Docker resources
#     labelled with this project's name.
#   - Works without the docker group: if Docker needs root, the script re-runs
#     itself once with sudo (one password prompt) and hands created files back
#     to you.
#   - Never prints secrets, never `source`s the env file.
# =============================================================================
set -Eeuo pipefail
umask 077                      # everything this script creates is private
export MSYS_NO_PATHCONV=1      # Git Bash on Windows: don't mangle container paths
export COMPOSE_BAKE=false      # avoid buildx-bake entitlement prompts

SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
cd -- "$SCRIPT_DIR"
ORIG_ARGS=("$@")

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[1m'; C_D=$'\033[2m'; C_0=$'\033[0m'
else
  C_R=''; C_G=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi
ERRORS=0
WARNINGS=0
say()  { printf '%s\n' "$*"; }
hdr()  { printf '\n%s== %s ==%s\n' "$C_B" "$*" "$C_0"; }
ok()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
info() { printf '  %s·%s %s\n' "$C_D" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*"; WARNINGS=$((WARNINGS + 1)); }
bad()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$*"; ERRORS=$((ERRORS + 1)); }
die()  { printf '\n%sError:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

on_err() {
  local code=$? line=$1
  printf '\n%sbedroc.sh stopped unexpectedly (line %s, exit %s).%s\n' "$C_R" "$line" "$code" "$C_0" >&2
  printf 'Nothing was deleted. Run "bash bedroc.sh check" for diagnostics.\n' >&2
}
trap 'on_err $LINENO' ERR

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
ASSUME_YES=0
SKIP_BACKUP=0
NEW_DATABASE_OK=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    -y|--yes)          ASSUME_YES=1 ;;
    --skip-backup)     SKIP_BACKUP=1 ;;
    --new-database)    NEW_DATABASE_OK=1 ;;
    -h|--help)         POSITIONAL+=("help") ;;
    *)                 POSITIONAL+=("$arg") ;;
  esac
done
CMD="${POSITIONAL[0]:-help}"
ARGS=()
if [ "${#POSITIONAL[@]}" -gt 1 ]; then ARGS=("${POSITIONAL[@]:1}"); fi

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
# ask "Question?" [Y|N]  → 0 = yes. Non-interactive without --yes → no.
ask() {
  local q=$1 def=${2:-N} reply hint='[y/N]'
  [ "$def" = Y ] && hint='[Y/n]'
  if [ "$ASSUME_YES" = 1 ]; then printf '  ? %s %s → yes (--yes)\n' "$q" "$hint"; return 0; fi
  if [ ! -t 0 ]; then printf '  ? %s → no (not interactive; re-run in a terminal or add --yes)\n' "$q"; return 1; fi
  read -r -p "  ? $q $hint " reply || return 1
  reply=${reply:-$def}
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ask_value "Prompt" "default" → prints the answer
ask_value() {
  local q=$1 def=$2 reply
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  read -r -p "  ? $q [$def] " reply || true
  printf '%s' "${reply:-$def}"
}

# confirm_phrase "phrase" → typed confirmation for destructive actions (never auto-yes)
confirm_phrase() {
  local phrase=$1 reply
  [ -t 0 ] || die "This action needs a typed confirmation; run it in an interactive terminal."
  read -r -p "  Type '$phrase' to continue: " reply || true
  [ "$reply" = "$phrase" ] || die "Confirmation did not match — nothing was changed."
}

# ---------------------------------------------------------------------------
# File ownership when running under sudo
# ---------------------------------------------------------------------------
# Files we create while running as root (via sudo) are handed back to the
# user who invoked sudo, so nothing in the repo ends up root-owned.
give_back() {
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_UID:-}" ] && [ "${SUDO_UID}" != 0 ]; then
    chown "${SUDO_UID}:${SUDO_GID:-$SUDO_UID}" "$@" 2>/dev/null || true
  fi
}

# Run git as the repo owner (avoids "dubious ownership" errors under sudo).
git_as_owner() {
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != root ] && command -v sudo >/dev/null 2>&1; then
    sudo -u "$SUDO_USER" -- git -C "$SCRIPT_DIR" "$@"
  else
    git -C "$SCRIPT_DIR" "$@"
  fi
}

file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo '?'; }
file_uid()  { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null || echo '?'; }

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# ---------------------------------------------------------------------------
# Docker access
# ---------------------------------------------------------------------------
DOCKER=()
ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Engine + the compose plugin first (see GUIDE.md, Part 1)."
  local out
  if out=$(docker info 2>&1); then
    DOCKER=(docker)
  elif printf '%s' "$out" | grep -qi 'permission denied'; then
    if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then
      say "Docker on this machine requires root (your user is not in the 'docker' group — that is the"
      say "safer setup, since docker-group membership is equivalent to root). Re-running with sudo;"
      say "you will be asked for your password once."
      exec sudo -- env BEDROC_ENV_FILE="${BEDROC_ENV_FILE:-}" bash "$SCRIPT_PATH" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
    fi
    die "Permission denied talking to Docker, and sudo is not available. Run this as a user allowed to use Docker."
  elif printf '%s' "$out" | grep -qiE 'cannot connect|is the docker daemon running|no such file'; then
    die "The Docker daemon is not running. Start it (e.g. 'sudo systemctl start docker') and try again."
  else
    die "Docker is not usable: $(printf '%s' "$out" | head -n 3)"
  fi

  local ver
  ver=$("${DOCKER[@]}" compose version --short 2>/dev/null || true)
  [ -n "$ver" ] || die "Docker Compose v2 is missing. Install the 'docker-compose-plugin' package (the old 'docker-compose' v1 is not supported)."
  case "$ver" in
    v1.*|1.*) die "Docker Compose $ver is too old; install the compose v2 plugin ('docker compose')." ;;
  esac
  COMPOSE_VERSION=$ver
}

# ---------------------------------------------------------------------------
# Configuration: env file, mode, project name
# ---------------------------------------------------------------------------
ENV_FILE=''
MODE=''
COMPOSE_FILE=''
PROJECT=''
COMPOSE=()

# Read KEY from the env file without executing it.
env_get() {
  local key=$1 line val
  [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || return 1
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1) || return 1
  val=${line#*=}
  val=${val%$'\r'}
  case "$val" in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
    *)     val=${val%%[[:space:]]#*}; val=${val%"${val##*[![:space:]]}"} ;;
  esac
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

ENV_BACKED_UP=0
backup_env_once() {
  [ "$ENV_BACKED_UP" = 1 ] && return
  local b
  b="${ENV_FILE}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p -- "$ENV_FILE" "$b"
  chmod 600 "$b"
  give_back "$b"
  info "Saved a copy of your env file first: $b"
  ENV_BACKED_UP=1
}

# Append KEY=VALUE (keeps the file's owner, mode and existing content).
env_append() {
  backup_env_once
  printf '\n# Added by bedroc.sh on %s\n%s=%s\n' "$(date -u +%Y-%m-%d)" "$1" "$2" >> "$ENV_FILE"
}

# Replace the value of an existing KEY in place (same inode → owner/mode kept).
env_replace() {
  backup_env_once
  local key=$1 value=$2 tmp
  tmp=$(mktemp "${ENV_FILE}.tmp.XXXXXX")
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" k "=" { if (!done) { print k "=" v; done = 1 } ; next }
    { print }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

default_project_name() {
  # Same rule Docker Compose uses for the default project name.
  basename -- "$SCRIPT_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[^a-z0-9]*//'
}

resolve_config() {
  if [ -n "${BEDROC_ENV_FILE:-}" ]; then
    ENV_FILE=$BEDROC_ENV_FILE
  elif [ -f .env.public ] && [ -f .env ]; then
    die "Both .env and .env.public exist, so I can't tell which deployment you mean. Run e.g.:
  BEDROC_ENV_FILE=.env.public bash bedroc.sh $CMD"
  elif [ -f .env.public ]; then
    ENV_FILE=.env.public
  elif [ -f .env ]; then
    ENV_FILE=.env
  else
    die "No env file found (.env.public or .env). First-time setup: bash bedroc.sh setup"
  fi
  [ -f "$ENV_FILE" ] || die "Env file '$ENV_FILE' does not exist. First-time setup: bash bedroc.sh setup"
  [ -r "$ENV_FILE" ] || die "Env file '$ENV_FILE' is not readable by $(id -un)."

  MODE=$(env_get BEDROC_MODE || true)
  if [ -z "$MODE" ]; then
    case "$(basename -- "$ENV_FILE")" in .env.public*) MODE=public ;; *) MODE=wireguard ;; esac
  fi
  case "$MODE" in
    public)    COMPOSE_FILE=docker-compose.public.yml ;;
    wireguard) COMPOSE_FILE=docker-compose.yml ;;
    *) die "BEDROC_MODE in $ENV_FILE must be 'public' or 'wireguard' (got '$MODE')." ;;
  esac
  [ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE is missing — is this a complete checkout of the repository?"

  PROJECT=$(env_get BEDROC_PROJECT || true)
  [ -n "$PROJECT" ] || PROJECT=$(env_get COMPOSE_PROJECT_NAME || true)
  if [ -z "$PROJECT" ]; then
    if [ "$MODE" = public ]; then PROJECT=bedroc-public; else PROJECT=$(default_project_name); fi
  fi
  COMPOSE=("${DOCKER[@]}" compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
}

# Container id of a running service in THIS project ('' if not running).
container_id() {
  "${DOCKER[@]}" ps -q \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}
volume_exists() { "${DOCKER[@]}" volume inspect "$1" >/dev/null 2>&1; }
DB_VOLUME() { printf '%s_postgres_data' "$PROJECT"; }

# ---------------------------------------------------------------------------
# Port checks (ignore ports held by this project's own containers)
# ---------------------------------------------------------------------------
# port_holder ADDR PORT → prints a description of whoever holds it, if anyone
port_holder() {
  local addr=$1 port=$2 line
  # Docker containers publishing it (works even when docker-proxy is disabled)
  while IFS=$'\t' read -r name ports proj; do
    [ "$proj" = "$PROJECT" ] && continue
    case ",$ports," in
      *"$addr:$port->"*|*"0.0.0.0:$port->"*|*":::$port->"*|*"[::]:$port->"*)
        printf 'container %s (%s)' "$name" "$ports"; return 0 ;;
    esac
  done < <("${DOCKER[@]}" ps --format '{{.Names}}{{"\t"}}{{.Ports}}{{"\t"}}{{.Label "com.docker.compose.project"}}' 2>/dev/null)

  # If our own stack already publishes it, it's ours.
  if "${DOCKER[@]}" ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Ports}}' 2>/dev/null \
       | grep -q -- ":$port->"; then
    return 0
  fi

  command -v ss >/dev/null 2>&1 || return 0
  line=$(ss -Hltn 2>/dev/null | awk -v p="$port" -v a="$addr" '
    { n = split($4, x, ":"); lp = x[n]; la = substr($4, 1, length($4) - length(lp) - 1)
      gsub(/^\[|\]$/, "", la); sub(/%.*/, "", la)
      if (lp == p && (la == a || la == "0.0.0.0" || la == "*" || la == "::" || a == "0.0.0.0")) { print $4; exit } }')
  if [ -n "$line" ]; then printf 'another program listening on %s' "$line"; fi
  return 0
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
run_checks() {
  local phase=$1   # check | up | update | admin
  ERRORS=0; WARNINGS=0

  hdr "Environment"
  ok "Docker reachable$([ "${DOCKER[0]}" = sudo ] && echo ' (via sudo)'; [ "$(id -u)" = 0 ] && echo ' (as root)'), Compose $COMPOSE_VERSION"
  ok "Deployment: $MODE  ·  env file: $ENV_FILE  ·  compose project: $PROJECT"
  if "${DOCKER[@]}" info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    if [ "$MODE" = wireguard ] && [ "$(env_get HTTPS_PORT || echo 443)" -lt 1024 ] 2>/dev/null; then
      warn "Rootless Docker cannot publish ports below 1024 — set HTTP_PORT/HTTPS_PORT (e.g. 8080/8443) in $ENV_FILE."
    else
      ok "Rootless Docker"
    fi
  fi

  check_env_file
  check_mode_specific
  check_volume_safety
  check_disk

  hdr "Compose configuration"
  local cfg_err
  if cfg_err=$("${COMPOSE[@]}" config -q 2>&1); then
    ok "$COMPOSE_FILE is valid with $ENV_FILE"
  else
    bad "Compose rejected the configuration:"
    printf '%s\n' "$cfg_err" | sed 's/^/      /'
  fi

  if [ "$phase" = update ] && command -v git >/dev/null 2>&1 && [ -e .git ]; then
    hdr "Code"
    local head dirty
    head=$(git_as_owner log -1 --format='%h %s (%cr)' 2>/dev/null || true)
    if [ -n "$head" ]; then ok "Deploying commit: $head"; fi
    dirty=$(git_as_owner status --porcelain --untracked-files=no 2>/dev/null || true)
    if [ -n "$dirty" ]; then
      warn "Tracked files have local modifications (they will be deployed as-is):
$(printf '%s\n' "$dirty" | sed 's/^/        /')"
    fi
  fi

  printf '\n'
  if [ "$ERRORS" -gt 0 ]; then
    printf '%s%d problem(s) must be fixed first%s (%d warning(s)). Nothing was changed.\n' "$C_R" "$ERRORS" "$C_0" "$WARNINGS"
    return 1
  fi
  printf '%sAll checks passed%s (%d warning(s)).\n' "$C_G" "$C_0" "$WARNINGS"
}

check_env_file() {
  hdr "Env file ($ENV_FILE)"
  local mode owner
  mode=$(file_mode "$ENV_FILE"); owner=$(file_uid "$ENV_FILE")
  if [ "$mode" != '?' ] && [ $(( 8#$mode & 077 )) -ne 0 ] 2>/dev/null; then
    warn "$ENV_FILE is readable by other users (mode $mode). It holds all secrets."
    if ask "Restrict it to its owner (chmod 600 $ENV_FILE)?" Y; then chmod 600 "$ENV_FILE"; ok "Now mode 600"; fi
  else
    ok "Permissions $mode"
  fi
  local me=${SUDO_UID:-$(id -u)}
  if [ "$owner" != '?' ] && [ "$owner" != "$me" ] && [ "$owner" != 0 ]; then
    warn "$ENV_FILE is owned by uid $owner, not by you (uid $me)."
  fi

  local k v
  for k in POSTGRES_PASSWORD DATABASE_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET CORS_ORIGIN; do
    v=$(env_get "$k" || true)
    if [ -z "$v" ]; then bad "$k is missing or empty."
    elif printf '%s' "$v" | grep -q 'CHANGE_THIS'; then bad "$k still contains the CHANGE_THIS placeholder."
    fi
  done

  local a r
  a=$(env_get JWT_ACCESS_SECRET || true); r=$(env_get JWT_REFRESH_SECRET || true)
  if [ -n "$a" ] && [ -n "$r" ]; then
    { [ "${#a}" -ge 32 ] && [ "${#r}" -ge 32 ]; } || bad "JWT secrets must be at least 32 characters (generate: openssl rand -hex 32)."
    [ "$a" != "$r" ] || bad "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different."
  fi

  local db
  db=$(env_get DATABASE_URL || true)
  if [ -n "$db" ]; then
    case "$db" in
      *@postgres:5432/bedroc*|*@postgres/bedroc*) ;;
      *) warn "DATABASE_URL does not point at the bundled database (expected …@postgres:5432/bedroc)." ;;
    esac
  fi

  # CORS: must be explicit (the server refuses to start with '*')
  local cors
  cors=$(env_get CORS_ORIGIN || true)
  if [ -n "$cors" ] && printf '%s' ",$cors," | tr -d ' ' | grep -q ',\*,'; then
    local fixed
    fixed=$(printf '%s' "$cors" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^\*$' | paste -sd, - || true)
    bad "CORS_ORIGIN contains '*'. The server no longer allows that (any website could take over logged-in sessions)."
    if [ -n "$fixed" ] && ask "Change CORS_ORIGIN to '$fixed' (just removes the '*')?" N; then
      env_replace CORS_ORIGIN "$fixed"; ERRORS=$((ERRORS - 1)); ok "CORS_ORIGIN=$fixed"
    else
      info "Edit CORS_ORIGIN in $ENV_FILE and list your frontend origins, e.g. https://bedroc.cagancalidag.com,http://localhost:*"
    fi
  elif [ -n "$cors" ]; then
    ok "CORS_ORIGIN=$cors"
  fi

  # Redis password (new requirement)
  local rp
  rp=$(env_get REDIS_PASSWORD || true)
  if [ -z "$rp" ]; then
    bad "REDIS_PASSWORD is not set (Redis now requires a password)."
    if ask "Generate a random REDIS_PASSWORD and append it to $ENV_FILE? (only adds one line)" Y; then
      env_append REDIS_PASSWORD "$(gen_secret)"; ERRORS=$((ERRORS - 1)); ok "REDIS_PASSWORD added"
    else
      info "Add a line to $ENV_FILE:  REDIS_PASSWORD=<output of: openssl rand -hex 32>"
    fi
  elif printf '%s' "$rp" | grep -q 'CHANGE_THIS'; then
    bad "REDIS_PASSWORD still contains the CHANGE_THIS placeholder. Generate one: openssl rand -hex 32"
  elif ! printf '%s' "$rp" | grep -Eq '^[A-Za-z0-9]{24,}$'; then
    bad "REDIS_PASSWORD must be 24+ letters/digits only (it is embedded in a URL). Generate: openssl rand -hex 32"
  else
    ok "REDIS_PASSWORD set"
  fi
  if [ -n "$(env_get REDIS_URL || true)" ]; then
    info "REDIS_URL in $ENV_FILE is no longer used (the URL is built from REDIS_PASSWORD). You can delete that line."
  fi

  local tp
  tp=$(env_get TRUST_PROXY || true)
  if [ -z "$tp" ]; then
    info "TRUST_PROXY not set → 1 (one reverse proxy in front). Behind Cloudflare + Caddy, see VPS-DEPLOY.md."
  elif [ "$tp" = true ]; then
    bad "TRUST_PROXY=true lets clients spoof their IP. Use a hop count (1, or 2 behind Cloudflare)."
  fi

  if [ "$(env_get ALLOW_REGISTRATION || echo true)" = false ]; then
    ok "Registration disabled (ALLOW_REGISTRATION=false)"
  else
    info "Registration is open. Set ALLOW_REGISTRATION=false once your accounts exist."
  fi
}

check_mode_specific() {
  if [ "$MODE" = public ]; then
    hdr "Public mode"
    local port
    port=$(env_get BEDROC_PORT || echo 3000)
    local holder
    holder=$(port_holder 127.0.0.1 "$port")
    if [ -n "$holder" ]; then
      bad "Port 127.0.0.1:$port is already used by $holder. Set BEDROC_PORT=<free port> in $ENV_FILE and point your reverse proxy at it."
    else
      ok "API will listen on 127.0.0.1:$port (point your reverse proxy here)"
    fi
    check_logs_dir
  else
    hdr "WireGuard / private mode"
    local ip http https
    ip=$(env_get BIND_IP || echo 10.66.66.1)
    http=$(env_get HTTP_PORT || echo 80); https=$(env_get HTTPS_PORT || echo 443)
    if command -v ip >/dev/null 2>&1; then
      if ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qxF "$ip"; then
        ok "BIND_IP $ip is assigned to this machine"
      else
        bad "BIND_IP $ip is not assigned to any interface here (is WireGuard/Tailscale up?). Docker cannot bind to it."
      fi
    fi
    local p h
    for p in "$http" "$https"; do
      h=$(port_holder "$ip" "$p")
      if [ -n "$h" ]; then bad "Port $ip:$p is already used by $h. Change HTTP_PORT/HTTPS_PORT in $ENV_FILE."; fi
    done
    # The bundled frontend is served from https://BIND_IP[:HTTPS_PORT]; that
    # origin must be allowed or the app cannot talk to its own API.
    local self_origin="https://$ip"
    [ "$https" = 443 ] || self_origin="https://$ip:$https"
    if printf '%s' ",$(env_get CORS_ORIGIN || true)," | tr -d ' ' | grep -qF ",$self_origin,"; then
      ok "CORS_ORIGIN includes this server's own frontend ($self_origin)"
    else
      bad "CORS_ORIGIN does not include $self_origin — the frontend served by this stack would be rejected. Add it to CORS_ORIGIN in $ENV_FILE."
    fi
    if [ -f docker/ssl/cert.pem ] && [ -f docker/ssl/key.pem ]; then
      ok "TLS certificate present (docker/ssl/)"
      local km
      km=$(file_mode docker/ssl/key.pem)
      if [ "$km" != '?' ] && [ $(( 8#$km & 077 )) -ne 0 ] 2>/dev/null; then
        warn "docker/ssl/key.pem is readable by other users (mode $km)."
        if ask "Restrict it (chmod 600 docker/ssl/key.pem)?" Y; then chmod 600 docker/ssl/key.pem; ok "key.pem is now 600"; fi
      fi
    else
      bad "TLS certificate missing: docker/ssl/cert.pem and docker/ssl/key.pem."
      if ask "Create a self-signed certificate for $ip now?" Y && make_self_signed "$ip"; then ERRORS=$((ERRORS - 1)); fi
    fi
  fi

  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = Enforcing ]; then
    warn "SELinux is enforcing. If containers get 'permission denied' on mounted files, label ONLY Bedroc's directories:
        chcon -Rt container_file_t $SCRIPT_DIR/logs $SCRIPT_DIR/docker/ssl"
  fi
  return 0
}

check_logs_dir() {
  local enabled
  enabled=$(env_get ENABLE_ACCESS_LOG || echo false)
  if [ ! -d logs ]; then
    mkdir -p logs; give_back logs
    info "Created ./logs (empty; mounted into the server container)."
  fi
  if [ "$enabled" = true ]; then
    local u
    u=$(file_uid logs)
    if [ "$u" = 1001 ]; then
      ok "Access log enabled; ./logs is writable by the server (uid 1001)"
    else
      warn "ENABLE_ACCESS_LOG=true but ./logs is owned by uid $u, so the server (uid 1001) cannot write the log."
      if ask "Give ./logs to uid 1001 (chown 1001:1001 logs — affects only this directory)?" N; then
        if [ "$(id -u)" = 0 ]; then chown 1001:1001 logs; else sudo chown 1001:1001 logs; fi
        chmod 700 logs 2>/dev/null || true
        ok "./logs is now owned by uid 1001"
      else
        info "Either run: sudo chown 1001:1001 $SCRIPT_DIR/logs   or set ENABLE_ACCESS_LOG=false"
      fi
    fi
    info "Privacy: the access log stores usernames + IP addresses of every login."
  else
    ok "Access log disabled (ENABLE_ACCESS_LOG is not true)"
  fi
}

check_volume_safety() {
  hdr "Data"
  local vol others
  vol=$(DB_VOLUME)
  if volume_exists "$vol"; then
    ok "Database volume $vol exists (your data)"
    return
  fi
  others=$("${DOCKER[@]}" volume ls -q 2>/dev/null | grep -E '_postgres_data$' | grep -vxF "$vol" || true)
  if [ -n "$others" ]; then
    if [ "$NEW_DATABASE_OK" = 1 ]; then
      warn "No volume $vol yet; --new-database given, so a NEW EMPTY database will be created. Other data volumes found: $(printf '%s' "$others" | paste -sd' ' -)"
    else
      bad "No database volume named $vol, but other Bedroc-looking data volumes exist:
$(printf '%s\n' "$others" | sed 's/^/        /')
      Starting now would create a NEW EMPTY database next to them. If one of those is your data, set
      BEDROC_PROJECT=<name before _postgres_data> in $ENV_FILE. If you really want a fresh database,
      re-run with --new-database."
    fi
  else
    info "No database yet — a new one will be created on first start."
  fi
}

check_disk() {
  local avail root
  avail=$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$avail" ] && [ "$avail" -lt 2097152 ] 2>/dev/null; then
    warn "Less than 2 GB free in $SCRIPT_DIR ($((avail / 1024)) MB). Builds and backups need space."
  fi
  root=$("${DOCKER[@]}" info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -n "$root" ] && [ -d "$root" ]; then
    avail=$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "$avail" ] && [ "$avail" -lt 2097152 ] 2>/dev/null; then
      warn "Less than 2 GB free for Docker ($root). Image builds may fail."
    fi
  fi
}

make_self_signed() {
  local host=$1 san
  command -v openssl >/dev/null 2>&1 || { bad "openssl is not installed."; return 1; }
  if printf '%s' "$host" | grep -Eq '^[0-9.]+$|:'; then san="IP:$host"; else san="DNS:$host"; fi
  mkdir -p docker/ssl
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout docker/ssl/key.pem -out docker/ssl/cert.pem \
    -subj "/CN=bedroc" -addext "subjectAltName=$san" >/dev/null 2>&1 \
    || { bad "openssl failed to create the certificate."; return 1; }
  chmod 700 docker/ssl; chmod 600 docker/ssl/key.pem; chmod 644 docker/ssl/cert.pem
  give_back docker/ssl docker/ssl/key.pem docker/ssl/cert.pem
  ok "Created a self-signed certificate for $host (valid 10 years) in docker/ssl/"
}

# ---------------------------------------------------------------------------
# Build / start / wait
# ---------------------------------------------------------------------------
build_images() {
  hdr "Building images"
  info "This can take a few minutes. Your running services keep working meanwhile."
  if ! "${COMPOSE[@]}" build --pull; then
    warn "Build with --pull failed (registry unreachable?). Retrying with cached base images…"
    "${COMPOSE[@]}" build || die "Image build failed. Your running stack (if any) was not touched."
  fi
  ok "Images built"
}

wait_healthy() {
  local svc=$1 timeout=${2:-180} waited=0 cid state
  while [ "$waited" -lt "$timeout" ]; do
    cid=$("${DOCKER[@]}" ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
            --filter "label=com.docker.compose.service=$svc" | head -n 1)
    if [ -n "$cid" ]; then
      state=$("${DOCKER[@]}" inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)
      case "$state" in
        'running healthy'|'running ') return 0 ;;
        exited*|dead*) return 1 ;;
      esac
    fi
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

services_to_watch() {
  if [ "$MODE" = public ]; then echo "postgres redis server"; else echo "postgres redis server bedroc nginx"; fi
}

diagnose_failure() {
  printf '\n%sThe stack did not come up healthy.%s Your data volume is untouched.\n' "$C_R" "$C_0"
  "${COMPOSE[@]}" ps -a || true
  local s
  for s in migrate $(services_to_watch); do
    printf '\n%s--- last log lines: %s ---%s\n' "$C_B" "$s" "$C_0"
    "${COMPOSE[@]}" logs --no-color --tail=40 "$s" 2>/dev/null || true
  done
  cat <<EOF

What to do:
  - Read the log lines above; "bash bedroc.sh check" re-runs all checks.
  - To go back to the previous version:  git log --oneline -5   →   git checkout <previous-commit>
    then:  bash bedroc.sh up     (the database schema changes are additive, so old code still works)
  - If you need the data from before this update: bash bedroc.sh restore <file in ./backups>
EOF
  exit 1
}

start_stack() {
  hdr "Starting"
  if ! "${COMPOSE[@]}" up -d; then
    diagnose_failure
  fi
  local s
  for s in $(services_to_watch); do
    if wait_healthy "$s" 240; then ok "$s is healthy"; else bad "$s did not become healthy"; diagnose_failure; fi
  done
}

print_endpoints() {
  hdr "Running"
  if [ "$MODE" = public ]; then
    local port; port=$(env_get BEDROC_PORT || echo 3000)
    ok "API: http://127.0.0.1:$port  (health: curl -s http://127.0.0.1:$port/health)"
    info "Your reverse proxy (Caddy) forwards your API domain to that address."
  else
    local ip https; ip=$(env_get BIND_IP || echo 10.66.66.1); https=$(env_get HTTPS_PORT || echo 443)
    if [ "$https" = 443 ]; then ok "Open https://$ip"; else ok "Open https://$ip:$https"; fi
  fi
}

# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------
LAST_BACKUP=''
do_backup() {
  local cid ts f tmp
  cid=$(container_id postgres)
  [ -n "$cid" ] || die "The database container is not running, so it cannot be backed up. Start it with: bash bedroc.sh up"
  mkdir -p backups; chmod 700 backups; give_back backups
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  f="backups/${PROJECT}-${ts}.dump"
  tmp="${f}.partial"
  info "Dumping database → $f"
  if ! "${DOCKER[@]}" exec "$cid" pg_dump -U postgres -d bedroc --format=custom > "$tmp"; then
    rm -f "$tmp"; die "pg_dump failed — no backup was written."
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; die "Backup file is empty — aborting."; }
  if ! "${DOCKER[@]}" exec -i "$cid" pg_restore --list < "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"; die "The backup could not be read back (corrupt?) — aborting."
  fi
  mv -- "$tmp" "$f"; chmod 600 "$f"; give_back "$f"
  LAST_BACKUP=$f
  ok "Backup verified: $f ($(du -h "$f" | cut -f1))"
  info "Backups contain usernames, verifiers and encrypted notes. Keep them private, and keep a copy of $ENV_FILE separately."
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_help() {
  cat <<EOF
${C_B}bedroc.sh${C_0} — manage a self-hosted Bedroc server

  ${C_B}bash bedroc.sh setup${C_0}            First-time setup: pick a mode, create the env file with fresh secrets
  ${C_B}bash bedroc.sh check${C_0}            Run all pre-flight checks (offers fixes, changes nothing without asking)
  ${C_B}bash bedroc.sh up${C_0}               Start the stack, or apply config changes
  ${C_B}bash bedroc.sh update${C_0}           After 'git pull': verified backup → rebuild → restart → health check
  ${C_B}bash bedroc.sh down${C_0}             Stop the stack (all data is kept)
  bash bedroc.sh restart [service]  Restart everything or one service
  bash bedroc.sh status            Containers, health, data volume, latest backup
  bash bedroc.sh logs [service]    Recent logs (add -f to follow, e.g. 'logs server -f')
  bash bedroc.sh backup            Verified database dump into ./backups/
  bash bedroc.sh restore <file>    Replace the database with a backup (asks for typed confirmation)
  bash bedroc.sh admin start|stop  Optional Adminer database GUI (localhost / BIND_IP only)
  bash bedroc.sh psql              Open a PostgreSQL shell
  bash bedroc.sh access-log        Show the login access log (if ENABLE_ACCESS_LOG=true)
  bash bedroc.sh compose <args>    Run any 'docker compose' command with the right project/env file

Options:  --yes  answer "yes" to routine prompts (never to destructive ones)
          --skip-backup  (update) don't take a backup first
          --new-database  allow creating a fresh, empty database even if other data volumes exist

The env file is .env.public (public VPS) or .env (WireGuard/private). Override with
BEDROC_ENV_FILE=<file>. Docs: GUIDE.md, VPS-DEPLOY.md, MANAGEMENT-GUIDE.md.
EOF
}

cmd_setup() {
  local existing=''
  if [ -f .env.public ]; then existing=.env.public; fi
  if [ -f .env ]; then existing="${existing:+$existing and }.env"; fi
  if [ -n "$existing" ] && [ -z "${BEDROC_ENV_FILE:-}" ]; then
    die "$existing already exists — setup never overwrites an env file. Run 'bash bedroc.sh check' instead."
  fi

  hdr "Bedroc setup"
  say "  Which kind of deployment?"
  say "    1) public     API only, behind a reverse proxy on this host (Caddy/nginx with a domain)."
  say "                  Users use the hosted frontend (or the desktop app) and enter your API URL."
  say "    2) wireguard  Everything (frontend + API + TLS) reachable only on a private address"
  say "                  such as a WireGuard/Tailscale/LAN IP."
  local choice
  choice=$(ask_value "Choose 1 or 2" 1)
  case "$choice" in
    1|public)    MODE=public;    ENV_FILE=${BEDROC_ENV_FILE:-.env.public} ;;
    2|wireguard) MODE=wireguard; ENV_FILE=${BEDROC_ENV_FILE:-.env} ;;
    *) die "Please answer 1 or 2." ;;
  esac
  if [ -e "$ENV_FILE" ]; then die "$ENV_FILE already exists — not overwriting it."; fi

  local bind_ip='' port='' cors reg
  if [ "$MODE" = wireguard ]; then
    bind_ip=$(ask_value "Private IP to listen on (WireGuard/Tailscale/LAN)" 10.66.66.1)
    cors=$(ask_value "Frontend origins allowed to use this server" "https://$bind_ip,https://bedroc.cagancalidag.com,http://localhost:*")
  else
    port=$(ask_value "Local port for the API (your reverse proxy forwards to 127.0.0.1:<port>)" 3000)
    cors=$(ask_value "Frontend origins allowed to use this server" "https://bedroc.cagancalidag.com,http://localhost:*")
  fi
  if printf '%s' ",$cors," | tr -d ' ' | grep -q ',\*,'; then die "'*' is not allowed in the origin list."; fi
  reg=$(ask_value "Allow new accounts to register? (you can turn this off later)" true)

  local pg app tmp
  pg=$(gen_secret); app=$(gen_secret)
  tmp=$(mktemp "${ENV_FILE}.tmp.XXXXXX")
  cat > "$tmp" <<EOF
# =============================================================================
# Bedroc environment — generated by bedroc.sh on $(date -u +%Y-%m-%d)
# KEEP THIS FILE PRIVATE (mode 600) and back it up separately from the data:
# without these secrets a restored database cannot be used.
# All options are documented in .env.example.
# =============================================================================
BEDROC_MODE=$MODE

# Database: superuser (used only for first-time setup and migrations) and the
# least-privilege application user. Changing these later does NOT change the
# passwords inside an existing database.
POSTGRES_PASSWORD=$pg
DATABASE_URL=postgres://bedroc_app:$app@postgres:5432/bedroc

# Redis (login challenges only; memory-only, password-protected)
REDIS_PASSWORD=$(gen_secret)

# Token signing keys (changing them logs everyone out)
JWT_ACCESS_SECRET=$(gen_secret)
JWT_REFRESH_SECRET=$(gen_secret)
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=30d

# Exact frontend origins allowed to call this server ('*' is rejected)
CORS_ORIGIN=$cors

# Reverse-proxy hops in front of the server (see .env.example)
TRUST_PROXY=1

ALLOW_REGISTRATION=$reg
RECORD_LOGIN_IP=true
ENABLE_ACCESS_LOG=false
EOF
  if [ "$MODE" = wireguard ]; then
    printf '\n# Address and ports nginx listens on\nBIND_IP=%s\nHTTP_PORT=80\nHTTPS_PORT=443\n' "$bind_ip" >> "$tmp"
  else
    printf '\n# 127.0.0.1 port the API listens on (your reverse proxy forwards here)\nBEDROC_PORT=%s\n' "$port" >> "$tmp"
  fi
  chmod 600 "$tmp"
  mv -- "$tmp" "$ENV_FILE"
  give_back "$ENV_FILE"
  ok "Created $ENV_FILE (mode 600) with freshly generated secrets"

  if [ "$MODE" = wireguard ] && { [ ! -f docker/ssl/cert.pem ] || [ ! -f docker/ssl/key.pem ]; }; then
    if ask "Create a self-signed TLS certificate for $bind_ip now?" Y; then make_self_signed "$bind_ip" || true; fi
  fi

  hdr "Next steps"
  say "  1. Review $ENV_FILE (optional)."
  say "  2. Start:  bash bedroc.sh up"
  if [ "$MODE" = public ]; then
    say "  3. Point your reverse proxy at 127.0.0.1:$port — example Caddy site block in VPS-DEPLOY.md."
    say "     (bedroc.sh never edits your reverse-proxy configuration.)"
  fi
}

cmd_check()   { ensure_docker; resolve_config; run_checks check || exit 1; }

cmd_up() {
  ensure_docker; resolve_config
  run_checks up || exit 1
  build_images
  start_stack
  print_endpoints
}

cmd_update() {
  ensure_docker; resolve_config
  run_checks update || exit 1

  if [ "$SKIP_BACKUP" = 1 ]; then
    warn "Skipping the pre-update backup (--skip-backup)."
  elif volume_exists "$(DB_VOLUME)"; then
    hdr "Backup before update"
    if [ -z "$(container_id postgres)" ]; then
      info "Database is not running; starting only the database to back it up…"
      build_images
      "${COMPOSE[@]}" up -d postgres
      wait_healthy postgres 180 || die "The database did not start, so no backup could be taken. Nothing else was changed."
    fi
    do_backup
  fi

  build_images
  start_stack
  print_endpoints
  if [ -n "$LAST_BACKUP" ]; then info "Pre-update backup: $LAST_BACKUP"; fi
}

cmd_down() {
  ensure_docker; resolve_config
  hdr "Stopping"
  "${COMPOSE[@]}" --profile admin down
  ok "Stopped. All data is kept in volume $(DB_VOLUME). Start again with: bash bedroc.sh up"
}

cmd_restart() {
  ensure_docker; resolve_config
  "${COMPOSE[@]}" restart ${ARGS[@]+"${ARGS[@]}"}
}

cmd_status() {
  ensure_docker; resolve_config
  hdr "Bedroc ($MODE, project $PROJECT)"
  "${COMPOSE[@]}" --profile admin ps -a
  hdr "Data"
  if volume_exists "$(DB_VOLUME)"; then ok "Database volume $(DB_VOLUME)"; else warn "No database volume yet"; fi
  local latest
  latest=$(ls -1t backups/*.dump 2>/dev/null | head -n 1 || true)
  if [ -n "$latest" ]; then ok "Latest backup: $latest"; else info "No backups yet (bash bedroc.sh backup)"; fi
}

cmd_logs() {
  ensure_docker; resolve_config
  local follow=() svcs=()
  local a
  for a in ${ARGS[@]+"${ARGS[@]}"}; do case "$a" in -f|--follow) follow=(-f) ;; *) svcs+=("$a") ;; esac; done
  "${COMPOSE[@]}" logs --tail=200 ${follow[@]+"${follow[@]}"} ${svcs[@]+"${svcs[@]}"}
}

cmd_backup() {
  ensure_docker; resolve_config
  hdr "Backup"
  do_backup
}

cmd_restore() {
  ensure_docker; resolve_config
  local file=${ARGS[0]:-}
  [ -n "$file" ] || die "Usage: bash bedroc.sh restore <backup file>"
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then die "Cannot read '$file'."; fi
  local kind
  case "$file" in
    *.dump)   kind=custom ;;
    *.sql)    kind=sql ;;
    *.sql.gz) kind=sqlgz ;;
    *) die "Unknown backup format (expected .dump, .sql or .sql.gz)." ;;
  esac

  hdr "Restore"
  warn "This REPLACES the entire Bedroc database of project '$PROJECT' with: $file"
  info "A backup of the current database is taken first, so this can be undone."
  confirm_phrase "$PROJECT"

  local cid
  cid=$(container_id postgres)
  if [ -z "$cid" ]; then
    "${COMPOSE[@]}" up -d postgres
    wait_healthy postgres 180 || die "The database did not start."
    cid=$(container_id postgres)
  fi
  do_backup

  info "Stopping the API server during the restore…"
  "${COMPOSE[@]}" --profile admin stop server adminer >/dev/null 2>&1 || true

  local reset_sql="DROP SCHEMA public CASCADE; CREATE SCHEMA public;
GRANT USAGE, CREATE ON SCHEMA public TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bedroc_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO bedroc_app;"
  local rc=0
  case "$kind" in
    custom)
      "${DOCKER[@]}" exec -i "$cid" pg_restore -U postgres -d bedroc --clean --if-exists \
        --single-transaction --exit-on-error < "$file" || rc=$? ;;
    sql)
      { printf '%s\n' "$reset_sql"; cat -- "$file"; } \
        | "${DOCKER[@]}" exec -i "$cid" psql -q -U postgres -d bedroc -v ON_ERROR_STOP=1 --single-transaction >/dev/null || rc=$? ;;
    sqlgz)
      { printf '%s\n' "$reset_sql"; gzip -dc -- "$file"; } \
        | "${DOCKER[@]}" exec -i "$cid" psql -q -U postgres -d bedroc -v ON_ERROR_STOP=1 --single-transaction >/dev/null || rc=$? ;;
  esac
  if [ "$rc" -ne 0 ]; then
    warn "Restore failed (exit $rc). It ran in a single transaction, so the database is unchanged."
    "${COMPOSE[@]}" up -d >/dev/null 2>&1 || true
    die "Restore aborted. Your pre-restore backup: $LAST_BACKUP"
  fi
  ok "Database restored from $file"
  start_stack
  print_endpoints
}

cmd_admin() {
  ensure_docker; resolve_config
  case "${ARGS[0]:-}" in
    start)
      local port addr
      if [ "$MODE" = public ]; then addr=127.0.0.1; port=$(env_get ADMINER_PORT || echo 8081)
      else addr=$(env_get BIND_IP || echo 10.66.66.1); port=$(env_get ADMINER_PORT || echo 8080); fi
      local h; h=$(port_holder "$addr" "$port")
      [ -z "$h" ] || die "Port $addr:$port is used by $h. Set ADMINER_PORT=<free port> in $ENV_FILE."
      "${COMPOSE[@]}" --profile admin up -d adminer
      ok "Adminer: http://$addr:$port   (System: PostgreSQL · Server: postgres · Database: bedroc)"
      if [ "$MODE" = public ]; then info "From your computer: ssh -L $port:127.0.0.1:$port <user>@<vps>  then open http://localhost:$port"; fi
      warn "Stop it when done: bash bedroc.sh admin stop"
      ;;
    stop)
      "${COMPOSE[@]}" --profile admin stop adminer >/dev/null 2>&1 || true
      "${COMPOSE[@]}" --profile admin rm -f adminer >/dev/null 2>&1 || true
      ok "Adminer stopped"
      ;;
    *) die "Usage: bash bedroc.sh admin start|stop" ;;
  esac
}

cmd_psql() {
  ensure_docker; resolve_config
  local cid; cid=$(container_id postgres)
  [ -n "$cid" ] || die "The database is not running."
  "${DOCKER[@]}" exec -it "$cid" psql -U postgres -d bedroc
}

cmd_access_log() {
  ensure_docker; resolve_config
  local cid; cid=$(container_id server)
  [ -n "$cid" ] || die "The server is not running."
  "${DOCKER[@]}" exec "$cid" sh -c 'tail -n 200 /app/logs/access.log 2>/dev/null || echo "(no access log — ENABLE_ACCESS_LOG is off or nobody logged in yet)"'
}

cmd_compose() {
  ensure_docker; resolve_config
  "${COMPOSE[@]}" ${ARGS[@]+"${ARGS[@]}"}
}

case "$CMD" in
  help)               cmd_help ;;
  setup)              cmd_setup ;;
  check|doctor)       cmd_check ;;
  up|start)           cmd_up ;;
  update|upgrade)     cmd_update ;;
  down|stop)          cmd_down ;;
  restart)            cmd_restart ;;
  status|ps)          cmd_status ;;
  logs)               cmd_logs ;;
  backup)             cmd_backup ;;
  restore)            cmd_restore ;;
  admin)              cmd_admin ;;
  psql)               cmd_psql ;;
  access-log)         cmd_access_log ;;
  compose)            cmd_compose ;;
  *) cmd_help; die "Unknown command: $CMD" ;;
esac
