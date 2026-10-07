#!/usr/bin/env bash
# Prepare a Marmot release locally. Never commits, tags or pushes; it prints those steps instead.
#
#   pnpm release:prepare 0.1.0        # or v0.1.0, or a prerelease such as 0.2.0-rc.1
#
# It:
#   1. sets "version" in package.json
#   2. sets the default image tag (MARMOT_VERSION) in docker/docker-compose.yml
#   3. sets the image tag in the Railway template images (deploy/railway/*/Dockerfile)
#   4. regenerates CHANGELOG.md with git-cliff (cliff.toml), treating unreleased commits as v<version>
#
# Override the git-cliff command with GIT_CLIFF (default: `pnpm dlx git-cliff@2`).
# Full procedure: docs/Release-Checklist.md
set -euo pipefail

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

[ $# -eq 1 ] || usage 2
case "$1" in -h | --help) usage 0 ;; esac

VERSION="${1#v}"
TAG="v${VERSION}"
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
if ! [[ "$VERSION" =~ $SEMVER ]]; then
  echo "error: '$1' is not a semantic version (expected X.Y.Z or X.Y.Z-pre)" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE=docker/docker-compose.yml
GIT_CLIFF="${GIT_CLIFF:-pnpm dlx git-cliff@2}"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "error: tag ${TAG} already exists" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "warning: the working tree has uncommitted changes; they will end up in the release commit" >&2
fi
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "warning: releasing from '${branch}', not main" >&2
fi

echo "==> package.json version -> ${VERSION}"
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$VERSION"

echo "==> ${COMPOSE_FILE}: MARMOT_VERSION default -> ${VERSION}"
# shellcheck disable=SC2016 # the literal compose interpolation, not a shell expansion
if ! grep -qF 'ghcr.io/thinkhumandotdev/marmot:${MARMOT_VERSION:-' "$COMPOSE_FILE"; then
  echo "error: no 'ghcr.io/thinkhumandotdev/marmot:\${MARMOT_VERSION:-…}' image in ${COMPOSE_FILE}" >&2
  exit 1
fi
sed -i.bak -E "s#(ghcr\.io/thinkhumandotdev/marmot:\\\$\{MARMOT_VERSION:-)[^}]*\}#\1${VERSION}}#" "$COMPOSE_FILE"
rm -f "${COMPOSE_FILE}.bak"

echo "==> deploy/railway/*/Dockerfile: marmot image -> ${VERSION}"
RAILWAY_DOCKERFILES=(deploy/railway/*/Dockerfile)
for f in "${RAILWAY_DOCKERFILES[@]}"; do
  sed -i.bak -E "s#^(FROM ghcr\.io/thinkhumandotdev/marmot:)[^[:space:]]+#\1${VERSION}#" "$f"
  rm -f "${f}.bak"
done
node scripts/check-railway.mjs

echo "==> CHANGELOG.md (${GIT_CLIFF} --tag ${TAG})"
$GIT_CLIFF --config cliff.toml --tag "$TAG" --output CHANGELOG.md
pnpm exec prettier --log-level warn --write CHANGELOG.md package.json "$COMPOSE_FILE"

git --no-pager diff --stat -- package.json "$COMPOSE_FILE" CHANGELOG.md deploy/railway

cat <<EOF

Release ${TAG} prepared. Review CHANGELOG.md, then:

  git switch -c chore/release-${VERSION}
  git add package.json docker/docker-compose.yml deploy/railway CHANGELOG.md
  git commit -m "chore(release): ${TAG}"
  git push -u origin chore/release-${VERSION}     # open a PR, wait for CI, squash-merge

  git switch main && git pull --ff-only
  git tag -a ${TAG} -m "${TAG}"
  git push origin ${TAG}                          # triggers .github/workflows/release.yml

Then follow docs/Release-Checklist.md (published image smoke test, GHCR visibility, release notes).
EOF
