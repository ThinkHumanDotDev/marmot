# Contributing to Marmot

Thanks for helping! Marmot is developed in the open; issues and pull requests are the unit of work. This
page is the short version; [docs/Development.md](../docs/Development.md) has the local setup, test and
migration workflows and [docs/Architecture.md](../docs/Architecture.md) explains how the pieces fit. By
participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues or discussions?

- **Issues** track work: reproducible bugs and scoped feature requests.
- **[Discussions](https://github.com/ThinkHumanDotDev/marmot/discussions)** are for everything before that:
  questions (Q&A), ideas that need shaping (Ideas), and things you built (Show and tell). A maintainer turns
  an agreed idea into an issue.
- Security vulnerabilities go through the private process in [SECURITY.md](SECURITY.md), never either.

See [`.github/SUPPORT.md`](SUPPORT.md) for where to get help.

## Workflow

1. **Open or pick an issue first.** Features without an approved issue may be closed; small fixes and docs
   corrections do not need one. Use the issue templates (bug report, feature request).
2. Branch from `main` using a plain name: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`,
   `ci/<slug>`. No personal or tool prefixes.
3. Keep PRs focused (ideally under ~1,500 changed lines). One issue per PR; reference it with `Closes #NN`.
4. Run `pnpm format:fix && pnpm check` before pushing. CI runs format, lint, typecheck, integration tests
   and Playwright E2E on **both Postgres and MongoDB**, plus a Docker build and compose smoke test. A red
   check is yours to fix; never skip or disable a test to get green.
5. Fill in the pull request template (summary, how it was tested, checklist). Screenshots for UI changes.
6. PRs are squash-merged; the PR title becomes the commit subject and must follow Conventional Commits
   (a CI check enforces it).

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`.

- Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`, `build`, `perf`.
- Scopes (see `commitlint.config.mjs`): `engine`, `collections`, `access`, `auth`, `ui`, `realtime`,
  `notifications`, `status-pages`, `maintenance`, `monitors`, `stats`, `infra`, `docker`, `ci`, `docs`, `deps`,
  `tests`, `billing`, `telemetry`, `api`, `email`, `settings`, `release`.
- Subject in the imperative, no trailing period. Keep the body for the _why_.
- **No trailers of any kind**: no `Co-authored-by`, no `Signed-off-by`, no tool or session links. Commits
  that carry them are rewritten before merge.

## Code conventions

- TypeScript strict, ESM only. Prettier formats, ESLint lints (`pnpm format:fix`, `pnpm lint`).
- Payload collections live in `src/collections/*` and are registered in `src/collections/index.ts`.
  Collections must work on Postgres **and** MongoDB: no `point` fields, no raw SQL, no adapter-specific
  operators; ids are `string | number`, compare them with `String(id)`.
- Non-admin reads and writes go through Payload with `overrideAccess: false` and the request user.
  Worker and background code use the Local API with `overrideAccess: true` and set `organization`.
- Org-scoped route handlers live under `src/app/api/orgs/[orgId]/...`, authenticate with
  `payload.auth({ headers })` and return `{ error }` JSON with a proper status.
- UI lives in `src/app/(frontend)` (App Router) with shadcn/ui primitives under `src/components/ui`. Keep
  live data in Zustand stores (`src/stores`) fed by the socket client (`src/lib/socket.ts`).
- User-facing text is a next-intl message in `src/i18n/messages/en.json`; dates and numbers go through the
  i18n formatter (`docs/Development.md` → Localisation). Keys are type-checked.
- Configuration is read through `src/env.ts` only. Document every new variable in `.env.example` and
  `docs/Configuration.md` (`tests/int/docs.int.spec.ts` fails otherwise); runtime-tunable options go into
  the `instance-settings` global with the variable as default.
- Server code must be bundle-safe (`pnpm build:server`): no `import.meta.url`-relative paths to repository
  files, no dynamic imports with computed specifiers.
- Tests: Vitest integration tests in `tests/int` for behaviour that matters (access control, engine state
  machine, stats rollups, provider payloads, route handlers). Playwright E2E in `tests/e2e` for critical
  user paths only. No snapshot tests, no tests for trivial getters.
- After changing a collection: `pnpm generate:types`, and for Postgres a migration created on a fresh
  database (`pnpm migrate:create <name>`). Never edit generated migrations or `src/payload-types.ts` by hand.
- Don't touch `src/app/(payload)/*` except `importMap.js` regeneration; don't add a monorepo.

## Porting from Uptime Kuma and kan.bn

Porting code from Uptime Kuma (MIT) is encouraged where it saves time. Keep a short attribution comment at
the top of the file naming the source file, and add the file to `THIRD_PARTY_NOTICES.md`. Code taken from
kan.bn stays under the AGPL-3.0, the same license as Marmot; attribute it the same way.

## Adding a monitor type

One file plus registry lines; see [docs/Monitors.md](../docs/Monitors.md) for the concepts.

1. Create `src/server/monitor-types/<name>.ts` that calls `registerMonitorType({ name, label, group, check })`.
   `check(ctx)` receives `{ monitor, heartbeat, signal, payload }`, sets `heartbeat.status`/`msg`/`ping` and
   must honour `signal` (the engine aborts at the monitor's `timeout`). Heavy client libraries go into
   `optionalDependencies` and are imported lazily inside `check()` with a literal specifier.
2. Add `import './<name>'` to `src/server/monitor-types/index.ts`.
3. Add the type's fields to `src/collections/Monitors.ts` (and `MONITOR_TYPES`), run `pnpm generate:types`
   and create a Postgres migration.
4. Add the type to `MONITOR_TYPE_NAMES`, `MONITOR_TYPE_GROUPS` and the per-type `superRefine` rules in
   `src/lib/validation/monitor.ts`, and render its fields in `src/components/monitors/monitor-form.tsx`.
5. Write `src/server/monitor-types/<name>.test.ts` (at least an unreachable-target case, and the
   missing-driver message for optional drivers) and add a row to `docs/Monitor-Types.md`.

## Adding a notification provider

1. Create `src/server/notification-providers/<name>.ts`: a zod `configSchema` (object of string / number /
   boolean / enum fields), a `fieldMeta` map (labels, placeholders, `secret: true` for tokens,
   `multiline: true` for templates, `options` for enum labels) and
   `registerNotificationProvider({ name, label, group, docsUrl, configSchema, fieldMeta, send })`.
2. Use `postJson` / `httpRequest` from `./http` so network errors carry the HTTP status and body and tests
   can stub `globalThis.fetch`. Render user text with `renderMessageTemplate` when the provider supports
   templates.
3. Add `import './<name>'` to `src/server/notification-providers/index.ts`.
4. Add a payload test to `src/server/notification-providers/providers.test.ts` (or `providers-2.test.ts`)
   and a row to the table in `docs/Notifications.md`.
5. Ported from Uptime Kuma? Attribution header + `THIRD_PARTY_NOTICES.md` entry.

## Documentation

User documentation lives in `docs/`, laid out as a GitHub wiki: flat, Title-Case page names
(`Getting-Started.md` becomes the "Getting Started" page), [docs/Home.md](../docs/Home.md) as the index and
`_Sidebar.md`/`_Footer.md` for the wiki navigation. Link pages as `Page-Name.md` so they work in the
repository too; `.github/workflows/wiki.yml` publishes `docs/` to the wiki on every push to `main` and
`scripts/build-wiki.mjs` rewrites the links. Edit `docs/`, never the wiki. A new page needs a row in
`Home.md` and a line in `_Sidebar.md`; every linked page must exist (a test checks all of it). Write for the
reader of that page: operators in `Deployment.md`/`Configuration.md`, users in `Monitors.md`/`Status-Pages.md`,
contributors in `Development.md`/`Architecture.md`. Features that are merging alongside a docs change are
marked _(landing in the current release)_ and the marker is removed at release time
([docs/Release-Checklist.md](../docs/Release-Checklist.md)).

## Releases

Maintainers cut releases with `pnpm release:prepare <version>` and a `vX.Y.Z` tag; the
[release checklist](../docs/Release-Checklist.md) has every step. `CHANGELOG.md` and the GitHub Release notes
are generated from commit messages by git-cliff (`cliff.toml`), so a clear Conventional Commit subject is
your changelog entry.

## Licensing

By contributing you agree that your contributions are licensed under the AGPL-3.0-only license.
