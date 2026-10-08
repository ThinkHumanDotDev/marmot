#!/usr/bin/env bash
# Smoke tests for a Marmot image, shared by CI (locally built image) and the release workflow (the image
# just published to GHCR). Expects docker/.env to exist and the compose ports from
# docker/docker-compose.smoke.yml (web :3000, realtime :3001, caddy :8080).
#
#   COMPOSE="docker compose -f docker/docker-compose.yml -f docker/docker-compose.smoke.yml" \
#     scripts/smoke-test.sh compose          # full stack: web + worker + realtime + caddy + postgres + redis
#   scripts/smoke-test.sh single <image>     # one container with MARMOT_ROLE=all on the compose network
#   scripts/smoke-test.sh logs               # dump container logs (for `if: failure()` steps)
#   scripts/smoke-test.sh down               # remove everything the other commands created
#
# Requires PAYLOAD_SECRET in the environment for `single`.
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose -f docker/docker-compose.yml -f docker/docker-compose.smoke.yml}"
SINGLE_NAME=marmot-all
# /api/health must report the version the image was built from (#238), not a fallback like 0.0.0.
EXPECTED_VERSION="$(jq -r .version "$(dirname "$0")/../package.json")"

# Fails unless the /api/health JSON on stdin is healthy and reports $EXPECTED_VERSION.
assert_health() {
  jq -e --arg v "$EXPECTED_VERSION" '.ok == true and .version == $v' >/dev/null
}

compose_smoke() {
  set -x
  $COMPOSE up -d --wait --wait-timeout 240
  # web, through Caddy
  curl -fsS --retry 10 --retry-delay 3 --retry-all-errors http://localhost:8080/api/health | assert_health
  # realtime health, direct
  curl -fsS http://localhost:3001/healthz | grep -q '"ok":true'
  # socket.io route through Caddy reaches the realtime process (polling handshake returns a sid)
  curl -fsS 'http://localhost:8080/socket.io/?EIO=4&transport=polling' | grep -q '"sid"'
  # security headers from next.config.ts
  curl -fsSI http://localhost:8080/api/health | tr -d '\r' | grep -qi '^x-content-type-options: nosniff'
  curl -fsSI http://localhost:8080/api/health | tr -d '\r' | grep -qi '^strict-transport-security:'
  # worker booted against the database (it waits up to 120s for migrations; allow 150s)
  for i in $(seq 1 50); do
    $COMPOSE logs worker | grep -q 'worker booted' && break
    if [ "$i" -eq 50 ]; then
      echo 'worker did not boot in time'
      $COMPOSE logs worker
      $COMPOSE top worker || true
      exit 1
    fi
    sleep 3
  done
  # the image healthcheck used by compose/orchestrators
  $COMPOSE exec -T web /app/entrypoint.sh healthcheck
  $COMPOSE exec -T realtime /app/entrypoint.sh healthcheck
}

single_smoke() {
  local image="${1:?usage: smoke-test.sh single <image>}"
  : "${PAYLOAD_SECRET:?PAYLOAD_SECRET must be set}"
  set -x
  # Reuses the Postgres/Redis started by `compose` (network marmot_default).
  docker run -d --name "$SINGLE_NAME" --network marmot_default -p 3100:3000 -p 3101:3001 \
    -e MARMOT_ROLE=all -e PAYLOAD_SECRET -e NEXT_PUBLIC_SERVER_URL=http://localhost:3100 \
    -e DATABASE_URL=postgres://marmot:marmot@postgres:5432/marmot -e REDIS_URL=redis://redis:6379 \
    "$image"
  curl -fsS --retry 40 --retry-delay 3 --retry-all-errors http://localhost:3100/api/health | assert_health
  curl -fsS --retry 10 --retry-delay 2 --retry-all-errors http://localhost:3101/healthz | grep -q '"ok":true'
  docker exec "$SINGLE_NAME" /app/entrypoint.sh healthcheck
  docker stop -t 30 "$SINGLE_NAME"
  test "$(docker inspect "$SINGLE_NAME" --format '{{.State.ExitCode}}')" = "0"
}

case "${1:-}" in
  compose) compose_smoke ;;
  single) single_smoke "${2:-}" ;;
  logs)
    docker logs "$SINGLE_NAME" 2>&1 | tail -n 100 || true
    $COMPOSE ps -a || true
    $COMPOSE logs --no-color --tail=150 || true
    ;;
  down)
    docker rm -f "$SINGLE_NAME" >/dev/null 2>&1 || true
    $COMPOSE down -v --remove-orphans || true
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 2
    ;;
esac
