# Contributing to Marmot

Thanks for helping! Marmot is developed in the open; issues and pull requests are the unit of work.

## Workflow

1. **Open or pick an issue first.** Features without an approved issue may be closed.
2. Branch from `main` using a plain name: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `ci/<slug>`.
3. Keep PRs focused (ideally under ~1,500 changed lines). One issue per PR; reference it with `Closes #NN`.
4. Run `pnpm check` before pushing. CI runs lint, typecheck, integration tests and Playwright E2E on
   **both Postgres and MongoDB**, plus a Docker build.
5. PRs are squash-merged; the PR title becomes the commit subject and must follow Conventional Commits.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`.

- Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`, `build`, `perf`.
- Scopes (see `commitlint.config.mjs`): `engine`, `collections`, `access`, `auth`, `ui`, `realtime`,
  `notifications`, `status-pages`, `maintenance`, `monitors`, `stats`, `infra`, `docker`, `ci`, `docs`, `deps`,
  `tests`, `billing`, `telemetry`, `api`, `email`, `settings`, `release`.
- No trailers (`Co-authored-by`, `Signed-off-by`, tool links). Keep the body for the _why_.

## Code conventions

- TypeScript strict, ESM only. Prettier formats, ESLint lints (`pnpm format:fix`, `pnpm lint`).
- Payload collections live in `src/collections/*` and are registered in `src/collections/index.ts`.
  Collections must work on Postgres **and** MongoDB: no `point` fields, no raw SQL, no adapter-specific operators.
- Backend extension points mirror Uptime Kuma: one file per monitor type in `src/server/monitor-types/`, one
  file per notification provider in `src/server/notification-providers/`, each registering itself in the
  directory's `index.ts`.
- UI lives in `src/app/(frontend)` (App Router) with shadcn/ui primitives under `src/components/ui`. Keep
  live data in Zustand stores (`src/stores`) fed by the socket client (`src/lib/socket.ts`).
- Configuration is read through `src/env.ts` only. Document every new variable in `.env.example` and
  `docs/configuration.md`.
- Tests: Vitest integration tests in `tests/int` for behaviour that matters (access control, engine state
  machine, stats rollups). Playwright E2E in `tests/e2e` for critical user paths only.
- Porting code from Uptime Kuma (MIT) is encouraged where it saves time; keep a short attribution comment
  at the top of the file and list the file in `THIRD_PARTY_NOTICES.md`.

## Licensing

By contributing you agree that your contributions are licensed under the AGPL-3.0-only license.
