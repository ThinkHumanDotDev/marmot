#!/usr/bin/env bash
# Start/stop local Redis + Postgres for development when Docker is unavailable
# (e.g. inside a CI container or a cloud dev session). Prefers Docker when present.
set -euo pipefail
cmd="${1:-up}"
DATA_DIR="${MARMOT_DEV_DATA:-$(pwd)/data/dev-services}"
mkdir -p "$DATA_DIR"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if [ "$cmd" = "up" ]; then
    docker compose -f docker/docker-compose.dev.yml up -d
  else
    docker compose -f docker/docker-compose.dev.yml down
  fi
  exit 0
fi

echo "[dev-services] docker unavailable, using local binaries"
if [ "$cmd" = "up" ]; then
  if ! redis-cli ping >/dev/null 2>&1; then
    redis-server --daemonize yes --port 6379 --dir "$DATA_DIR" --save "" --appendonly no >/dev/null
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster 16 main start 2>/dev/null || true
    sleep 1
    su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='marmot'\"" | grep -q 1 \
      || su postgres -c "psql -c \"CREATE USER marmot WITH PASSWORD 'marmot' SUPERUSER;\""
    for db in marmot marmot_test; do
      su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" | grep -q 1 \
        || su postgres -c "psql -c 'CREATE DATABASE $db OWNER marmot;'"
    done
  fi
  echo "[dev-services] redis: $(redis-cli ping) | postgres: $(pg_lsclusters | tail -1 | awk '{print $4}')"
else
  redis-cli shutdown nosave >/dev/null 2>&1 || true
  pg_ctlcluster 16 main stop 2>/dev/null || true
fi
