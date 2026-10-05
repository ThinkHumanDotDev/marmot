#!/bin/sh
set -eu

ROLE="${MARMOT_ROLE:-all}"
cd /app

run_migrations() {
  if [ "${SKIP_MIGRATIONS:-false}" != "true" ] && [ "${DATABASE_ADAPTER:-postgres}" != "sqlite" ]; then
    echo "[marmot] running database migrations (${DATABASE_ADAPTER:-postgres})"
    node_modules/.bin/payload migrate
  fi
}

case "${1:-start}" in
  healthcheck)
    case "$ROLE" in
      realtime) wget -qO- "http://127.0.0.1:${REALTIME_PORT:-3001}/healthz" >/dev/null ;;
      worker) exit 0 ;;
      *) wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null ;;
    esac
    ;;
  migrate)
    run_migrations
    ;;
  start)
    case "$ROLE" in
      web)
        run_migrations
        exec node_modules/.bin/next start -p "${PORT:-3000}"
        ;;
      worker)
        exec node_modules/.bin/payload run src/worker.ts
        ;;
      realtime)
        exec node_modules/.bin/payload run src/realtime.ts
        ;;
      all)
        run_migrations
        node_modules/.bin/payload run src/worker.ts &
        node_modules/.bin/payload run src/realtime.ts &
        exec node_modules/.bin/next start -p "${PORT:-3000}"
        ;;
      *)
        echo "Unknown MARMOT_ROLE: $ROLE" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    exec "$@"
    ;;
esac
