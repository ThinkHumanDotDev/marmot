#!/usr/bin/env bash
# Local development services: Postgres + Redis (+ MongoDB when Docker is available).
#
#   scripts/dev-services.sh up      start (idempotent: already-running services are left alone)
#   scripts/dev-services.sh down    stop (safe to run when nothing is running)
#   scripts/dev-services.sh status  print what is reachable
#
# With a Docker daemon the services come from docker/docker-compose.dev.yml. Without one (CI containers,
# cloud dev sessions) local `redis-server` and Postgres 16 (pg_ctlcluster) binaries are used and the
# `marmot` role plus the `marmot` and `marmot_test` databases are created.
set -euo pipefail
cd "$(dirname "$0")/.."

cmd="${1:-up}"
DATA_DIR="${MARMOT_DEV_DATA:-$(pwd)/data/dev-services}"
COMPOSE_FILE=docker/docker-compose.dev.yml
PG_CLUSTER_VERSION="${MARMOT_PG_VERSION:-16}"
PG_CLUSTER_NAME="${MARMOT_PG_CLUSTER:-main}"

log() { echo "[dev-services] $*"; }

have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

probe() {
  # probe <name> <command...>: prints "name: up|down"
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then echo "$name: up"; else echo "$name: down"; fi
}

status_local() {
  probe redis redis-cli -p 6379 ping
  probe postgres pg_isready -h localhost -p 5432
  probe mongo mongosh --quiet --eval 'db.adminCommand("ping").ok' mongodb://localhost:27017
}

# Run psql as the postgres superuser, whether we are root (su) or the postgres user itself.
pg_admin() {
  if [ "$(id -un)" = "postgres" ]; then
    psql "$@"
  elif [ "$(id -u)" = "0" ]; then
    su postgres -c "psql $(printf '%q ' "$@")"
  else
    sudo -u postgres psql "$@"
  fi
}

ensure_pg_objects() {
  if ! pg_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname='marmot'" | grep -q 1; then
    pg_admin -c "CREATE USER marmot WITH PASSWORD 'marmot' SUPERUSER;"
  fi
  for db in marmot marmot_test; do
    if ! pg_admin -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
      pg_admin -c "CREATE DATABASE $db OWNER marmot;"
    fi
  done
}

up_local() {
  mkdir -p "$DATA_DIR"
  if redis-cli -p 6379 ping >/dev/null 2>&1; then
    log "redis already running"
  elif command -v redis-server >/dev/null 2>&1; then
    redis-server --daemonize yes --port 6379 --dir "$DATA_DIR" --save "" --appendonly no >/dev/null
    log "redis started"
  else
    log "redis-server not found; install Redis or Docker"
  fi

  if command -v pg_ctlcluster >/dev/null 2>&1; then
    if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
      log "postgres already running"
    else
      pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" start
      for _ in $(seq 1 20); do
        pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
        sleep 0.5
      done
      log "postgres started"
    fi
    ensure_pg_objects
  else
    log "pg_ctlcluster not found; install Postgres 16 or Docker"
  fi

  log "mongodb is only available through Docker; CI covers the MongoDB adapter"
  status_local
}

down_local() {
  if redis-cli -p 6379 ping >/dev/null 2>&1; then
    redis-cli -p 6379 shutdown nosave >/dev/null 2>&1 || true
    log "redis stopped"
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1 && pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" stop || true
    log "postgres stopped"
  fi
}

if have_docker; then
  case "$cmd" in
    up)
      docker compose -f "$COMPOSE_FILE" up -d --wait
      log "postgres :5432 · redis :6379 · mongo :27017 (docker)"
      ;;
    down) docker compose -f "$COMPOSE_FILE" down --remove-orphans ;;
    status) docker compose -f "$COMPOSE_FILE" ps ;;
    *)
      echo "usage: $0 up|down|status" >&2
      exit 2
      ;;
  esac
  exit 0
fi

log "docker unavailable, using local binaries"
case "$cmd" in
  up) up_local ;;
  down) down_local ;;
  status) status_local ;;
  *)
    echo "usage: $0 up|down|status" >&2
    exit 2
    ;;
esac
