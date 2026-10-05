# Release checklist

Marmot is versioned with semver tags (`vMAJOR.MINOR.PATCH`). Pushing a tag runs `.github/workflows/release.yml`,
which builds the multi-arch image and publishes it to `ghcr.io/thinkhumandotdev/marmot` as `X.Y.Z`, `X.Y` and
`latest`. Everything before the tag is manual; this is the list.

## Before cutting the release

- [ ] `main` is green: lint, typecheck, Vitest and Playwright on **Postgres and MongoDB**, and the Docker
      job (image build, compose smoke test, single-container smoke test).
- [ ] Every PR meant for the release is squash-merged with a Conventional Commits title; nothing is left on
      a feature branch that the release notes promise.
- [ ] **Migrations**: the Postgres chain in `src/migrations/postgres` applies cleanly to an empty database
      (`NODE_ENV=production pnpm migrate`) and to a database at the previous release (upgrade path).
      No migration file was edited by hand.
- [ ] `pnpm generate:types` produces no diff.
- [ ] **Dependencies**: `pnpm audit` has no unaddressed high/critical findings; Dependabot PRs are merged
      or consciously deferred.
- [ ] **Configuration docs**: every key in `src/env.ts` is in `.env.example` and `docs/configuration.md`
      (`tests/int/docs.int.spec.ts` enforces it); new instance settings are documented.
- [ ] **Documentation**: pages marked _(landing in the current release)_ in `docs/` describe features that
      actually merged; remove the markers (and the matching allowance in `docs.int.spec.ts`) or move the
      feature to _planned_ in `docs/comparison.md`.
- [ ] `THIRD_PARTY_NOTICES.md` lists every file ported from Uptime Kuma or kan.bn.
- [ ] `package.json` `version` is bumped to the release version in a `chore(release): vX.Y.Z` commit.
- [ ] `CHANGELOG` / release notes drafted from the commit log: features, fixes, **breaking changes** and
      **manual steps** (new required variables, proxy changes, migrations that take long).

## Manual smoke test

Run on the release candidate image (`docker build -f docker/Dockerfile -t marmot:rc .` or the CI image):

- [ ] Fresh compose stack with Postgres: setup wizard, create an HTTP monitor, see heartbeats arrive live,
      send a test notification (webhook to a request bin is enough), publish a status page and open it
      anonymously, invite a user and accept the invitation.
- [ ] Same with `docker-compose.mongo.yml`.
- [ ] Upgrade path: start the previous release, add data, swap the image tag, `docker compose up -d`; the
      web container migrates, the worker reconnects, history is intact.
- [ ] `MARMOT_ROLE=all` container boots and `docker stop` exits 0.
- [ ] Backup and restore according to [deployment.md](deployment.md#backups-and-restore).
- [ ] OIDC login against a test provider when the release touched `src/auth/`.

## Cutting the release

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

- [ ] The release workflow succeeded; `docker pull ghcr.io/thinkhumandotdev/marmot:X.Y.Z` works on amd64 and
      arm64.
- [ ] Create the GitHub release from the tag with the notes; attach nothing (the image is the artifact).
- [ ] Update `MARMOT_VERSION` guidance or pinned examples in the docs if the minor changed.

## After the release

- [ ] Announce (project README badge, discussions, chat).
- [ ] Open the next milestone; move unfinished _landing_ items there.
- [ ] Watch issues for upgrade reports during the first days; a `vX.Y.Z+1` patch release follows the same
      list with the smoke test reduced to the affected area.
