#!/usr/bin/env bash
# Creates a complete Marmot project on Railway from .railway/railway.ts. That covers the services,
# Postgres, the volumes, every variable and fresh secrets, and the public domain on edge.
#
#   bash deploy/railway/bootstrap.sh                               # new project "marmot", from main
#   MARMOT_BRANCH=feat/x PROJECT_NAME=marmot-test bash deploy/railway/bootstrap.sh
#   MARMOT_REGION=us-west2 bash deploy/railway/bootstrap.sh      # default europe-west4-drams3a
#
# Needs the Railway CLI 5.42.1 or newer (`npm i -g @railway/cli`), `railway login`, pnpm and openssl.
# It always creates a NEW project and links this checkout to it. To change an existing project later,
# edit .railway/railway.ts and run `railway config plan` and then `railway config apply`, with the same
# MARMOT_BRANCH and MARMOT_REGION as the first run. Secrets are kept.
set -euo pipefail

cd "$(dirname "$0")/../.."

die() {
  echo "error: $*" >&2
  exit 1
}

command -v railway >/dev/null || die "the Railway CLI is not installed (npm i -g @railway/cli)"
command -v openssl >/dev/null || die "openssl is required to generate secrets"
version="$(railway --version | awk '{print $2}')"
[ "$(printf '%s\n' 5.42.1 "$version" | sort -V | head -1)" = 5.42.1 ] ||
  die "Railway CLI $version is too old for infrastructure as code; 5.42.1 or newer is needed"
railway whoami >/dev/null || die "not logged in; run \`railway login\` first"
[ -d node_modules/railway ] || pnpm install --frozen-lockfile

export MARMOT_BRANCH="${MARMOT_BRANCH:-main}"
name="${PROJECT_NAME:-marmot}"
echo "==> Creating Railway project '$name' (services deploy from branch $MARMOT_BRANCH)"
railway init --name "$name"

# Read by .railway/railway.ts on this first apply only; later applies preserve the stored values.
PAYLOAD_SECRET="$(openssl rand -hex 32)"
REDIS_PASSWORD="$(openssl rand -hex 24)"
export PAYLOAD_SECRET REDIS_PASSWORD

echo "==> Applying .railway/railway.ts"
railway config apply --yes

echo "==> Generating the public domain for edge (port 8080)"
railway domain --service edge --port 8080

# The first deploys started before the domain existed, so NEXT_PUBLIC_SERVER_URL was empty for them.
# Deploy each Marmot service again from source. Railway refuses while a build is still running, so retry.
echo "==> Redeploying web, worker and realtime with the domain in place (waits for running builds)"
for svc in web worker realtime; do
  for attempt in $(seq 1 60); do
    if railway service redeploy --service "$svc" --from-source --yes >/dev/null 2>&1; then
      echo "    $svc: deploy started"
      break
    fi
    if [ "$attempt" -eq 60 ]; then
      echo "    $svc: still busy after 15 minutes; deploy it later with" >&2
      echo "    railway service redeploy --service $svc --from-source --yes" >&2
      break
    fi
    sleep 15
  done
done

cat <<EOF

Done. Open the edge domain above and complete the setup wizard. Then check that the dashboard updates
live and that a monitor goes up. Follow progress with \`railway service logs --service web\`.

To publish the template, generate it from this project in the Railway dashboard. Then set
PAYLOAD_SECRET (on web) and REDIS_PASSWORD (on redis) to \${{secret(64)}} in the template editor, so
every deployment gets its own secrets. See deploy/railway/README.md.
EOF
