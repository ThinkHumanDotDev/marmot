#!/bin/sh
# Marmot container entrypoint.
#
#   entrypoint.sh [start]      start the role selected by MARMOT_ROLE (web | worker | realtime | all)
#   entrypoint.sh migrate      run database migrations and exit
#   entrypoint.sh healthcheck  exit 0 when the role is healthy (used by HEALTHCHECK / compose)
#   entrypoint.sh <command>    run an arbitrary command inside the image
#
# Environment knobs (besides the Marmot variables documented in docs/configuration.md):
#   SKIP_MIGRATIONS=true  do not run `payload migrate` before starting web/all
set -eu

cd /app

ROLE="${MARMOT_ROLE:-all}"
PORT="${PORT:-3000}"
REALTIME_PORT="${REALTIME_PORT:-3001}"
ADAPTER="${DATABASE_ADAPTER:-postgres}"
export MARMOT_ROLE="$ROLE"

PAYLOAD=node_modules/.bin/payload
NEXT=node_modules/.bin/next
# Long-running TypeScript entrypoints go through scripts/run-ts.mjs (tsx with a boot keep-alive).
# `payload run` is for one-shot scripts: it calls process.exit(0) as soon as the module has been
# imported, which would kill the worker/realtime servers.
RUN_TS="node scripts/run-ts.mjs"

log() { echo "[marmot] $*"; }

http_ok() {
  wget -q -T 5 -O /dev/null "$1"
}

run_migrations() {
  if [ "${SKIP_MIGRATIONS:-false}" = "true" ]; then
    log "SKIP_MIGRATIONS=true, not running migrations"
    return 0
  fi
  if [ "$ADAPTER" = "sqlite" ]; then
    # The sqlite adapter pushes its schema in development; it is not supported for production.
    return 0
  fi
  log "running database migrations ($ADAPTER)"
  # --force-accept-warning answers the "database was pushed in dev mode" prompt so the
  # container never blocks on stdin.
  "$PAYLOAD" migrate --force-accept-warning
}

healthcheck() {
  case "$ROLE" in
    web) http_ok "http://127.0.0.1:${PORT}/api/health" ;;
    realtime) http_ok "http://127.0.0.1:${REALTIME_PORT}/healthz" ;;
    worker) exit 0 ;; # the process exiting is the failure signal for a queue consumer
    all)
      http_ok "http://127.0.0.1:${PORT}/api/health" &&
        http_ok "http://127.0.0.1:${REALTIME_PORT}/healthz"
      ;;
    *) exit 1 ;;
  esac
}

start_web() { exec "$NEXT" start -H 0.0.0.0 -p "$PORT"; }
start_worker() { exec $RUN_TS src/worker.ts; }
start_realtime() { exec $RUN_TS src/realtime.ts; }

# Single-container mode: supervise the three processes and exit when any of them dies so the
# orchestrator restarts the container instead of leaving it half-alive.
start_all() {
  stopping=0
  $RUN_TS src/worker.ts &
  worker_pid=$!
  $RUN_TS src/realtime.ts &
  realtime_pid=$!
  "$NEXT" start -H 0.0.0.0 -p "$PORT" &
  web_pid=$!

  stop_all() {
    stopping=1
    kill -TERM "$worker_pid" "$realtime_pid" "$web_pid" 2>/dev/null || true
  }
  trap stop_all TERM INT

  while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$realtime_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
    sleep 2
  done

  if [ "$stopping" -eq 0 ]; then
    log "a child process exited unexpectedly, shutting down"
    stop_all
  fi
  wait || true
  [ "$stopping" -eq 1 ] && exit 0 || exit 1
}

case "${1:-start}" in
  healthcheck) healthcheck ;;
  migrate) run_migrations ;;
  start)
    log "starting role: $ROLE"
    case "$ROLE" in
      web)
        run_migrations
        start_web
        ;;
      worker) start_worker ;;
      realtime) start_realtime ;;
      all)
        run_migrations
        start_all
        ;;
      *)
        echo "Unknown MARMOT_ROLE: $ROLE (expected web, worker, realtime or all)" >&2
        exit 1
        ;;
    esac
    ;;
  *) exec "$@" ;;
esac
