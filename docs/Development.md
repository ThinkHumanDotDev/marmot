# Development

Marmot is one TypeScript codebase (Payload CMS 3 + Next.js, pnpm) that runs as three processes. This page
gets you from a clone to a running stack and through the test, migration and build workflows. Project
conventions live in [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md) and `.claude/skills/marmot-conventions/SKILL.md`.

## Prerequisites

- Node.js 22 and pnpm 10 (`corepack enable` installs the pinned version).
- Postgres 16 and Redis 7, either through Docker or as local binaries. MongoDB 7 optionally.
- For Playwright: a Chromium (`pnpm exec playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_PATH`).

## Setup

```bash
pnpm install
cp .env.example .env            # defaults point at local Postgres + Redis
pnpm services:up                # Postgres + Redis (+ Mongo with Docker)
pnpm dev                        # web :3000 · worker · realtime :3001
```

Set `PAYLOAD_SECRET` in `.env` to any string of 16+ characters. `pnpm services:up` runs
`scripts/dev-services.sh`: with a Docker daemon it starts `docker/docker-compose.dev.yml` (Postgres, Redis,
MongoDB on their default ports); without one it starts local `redis-server` and a Postgres 16 cluster via
`pg_ctlcluster` and creates the `marmot` role (password `marmot`) with the `marmot` and `marmot_test`
databases. `pnpm services:down` stops them.

### Without Docker

Install Postgres and Redis from your package manager, then either let `pnpm services:up` manage them or run
them yourself and point `DATABASE_URL` / `REDIS_URL` at them. For a zero-dependency database use SQLite:

```bash
DATABASE_ADAPTER=sqlite DATABASE_URL=file:./data/marmot.db pnpm dev:web
```

SQLite has no migrations (the schema is pushed in development) and is not supported in production; Redis is
still required by the worker and realtime processes.

## The three processes

| Command             | Process                                                       | Notes                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:web`      | Next.js dev server with Payload (UI, `/admin`, REST, GraphQL) | Pushes schema changes to the dev database on the fly (Postgres/SQLite in development).                                                                                                                                                          |
| `pnpm dev:worker`   | `src/worker.ts` through `scripts/run-ts.mjs`                  | BullMQ job schedulers, checks, stats, notifications. Needs Redis.                                                                                                                                                                               |
| `pnpm dev:realtime` | `src/realtime.ts` through `scripts/run-ts.mjs`                | socket.io on `REALTIME_PORT`. The Next dev server does not proxy `/socket.io`, so set `NEXT_PUBLIC_REALTIME_URL=http://localhost:3001` in `.env` for live updates in development (the realtime server allows `NEXT_PUBLIC_SERVER_URL` in CORS). |
| `pnpm dev`          | all three with `concurrently`                                 | Coloured, prefixed logs.                                                                                                                                                                                                                        |

`scripts/run-ts.mjs` is the TypeScript loader for the long-running processes. Do not run them with
`payload run` or bare `tsx` — both exit before the schedulers are up. In production the same entrypoints are
bundled by `pnpm build:server` (below).

Once `web` is up, open `http://localhost:3000`: the setup wizard creates your superadmin and first
organization. `/admin` is the Payload admin panel (superadmins only).

## Everyday commands

| Command                     | What it does                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm check`                | `lint` + `typecheck` + `test:int`. Run before every push.                                              |
| `pnpm lint` / `pnpm format` | ESLint / Prettier check (`pnpm format:fix` writes).                                                    |
| `pnpm typecheck`            | `tsc --noEmit` over app, server and tests.                                                             |
| `pnpm generate:types`       | Regenerate `src/payload-types.ts` after changing a collection or global. Never edit that file by hand. |
| `pnpm generate:importmap`   | Regenerate the admin import map after adding admin components.                                         |
| `pnpm build`                | Production Next.js build (also typechecks test files against `DATABASE_ADAPTER`).                      |
| `pnpm build:server`         | esbuild bundles of worker, realtime and migrate to `dist/server/*.mjs` (what the Docker image runs).   |

## Tests

### Integration tests (Vitest)

`tests/int/*.int.spec.ts` and `src/**/*.test.ts` run with `pnpm test:int` against a **real database**
(`vitest.config.mts`, `vitest.setup.ts`). They boot Payload with the collection access rules on, so they
cover what can break silently: RBAC, the engine state machine, stats rollups, provider payloads, route
handlers. Files run serially (`fileParallelism: false`) because they share one database.

- The database comes from `DATABASE_URL` in your environment or `.env`. Use a **dedicated** database, not
  the one your dev server uses: in development Vitest pushes the schema into it.
- If a run fails on boot with a schema-push error (e.g. "column contains null values") or hangs, the
  database has drifted. Point `DATABASE_URL` at a fresh one and rerun:

  ```bash
  createdb -h localhost -U marmot marmot_test2
  DATABASE_URL=postgres://marmot:marmot@localhost:5432/marmot_test2 pnpm test:int
  ```

  Never answer Payload's data-loss prompt interactively in a test run.

- Redis is not required: `vitest.setup.ts` sets `MARMOT_DISABLE_ENGINE_HOOKS=1` so collection hooks skip the
  scheduler sync; engine behaviour is tested directly.
- Run one file with `pnpm test:int tests/int/members.int.spec.ts`.
- On MongoDB ids are strings, so fixtures must not assume numbers: cast through `unknown`
  (`as unknown as Monitor`) or create real documents.

### End-to-end tests (Playwright)

`tests/e2e/*.e2e.spec.ts` cover the critical paths (setup wizard, login, monitors, members, status pages,
admin). CI runs them on Postgres **and** MongoDB against a production build (`pnpm build`, `pnpm migrate`,
`E2E_WEB_COMMAND="pnpm start"`). Locally:

```bash
pnpm exec playwright install chromium        # once
pnpm test:e2e                                # starts `pnpm dev:web` for you
```

`00-setup.e2e.spec.ts` needs a database without users and is skipped outside CI. Set
`PLAYWRIGHT_CHROMIUM_PATH` to use an existing Chromium binary.

### What to test where

Integration tests for behaviour that matters (access control, state machines, rollups, provider payloads,
route handlers). E2E only for critical user paths. No snapshot tests, no tests of trivial getters.

## Localisation

User-facing text goes through [next-intl](https://next-intl.dev) in "without i18n routing" mode: URLs
carry no locale prefix, the language comes from the signed-in user. Everything lives in `src/i18n/`:

| File                      | Role                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `locales.ts`              | `locales`, `defaultLocale`, `localeNames` (each language in its own language) and the pure resolver. The only list of languages.        |
| `messages/<locale>.json`  | One catalogue per language, namespaced by area (`common`, `auth`, `settings`, `statusPages`, …). English is the reference.              |
| `messages/index.ts`       | Static map of catalogues (no computed `import()`, so the worker bundle can include it).                                                 |
| `formats.ts`              | Named date and number formats (`short`, `zoned`, `percent`, …) and the default time zone.                                               |
| `request.ts`, `server.ts` | next-intl request config; locale of the current request (`getRequestLocale`, `getStatusPageLocale`).                                    |
| `resolve.ts`              | Locale and time zone of a request or a status page from plain `Headers`; usable in route handlers and tests.                            |
| `translator.ts`           | `getTranslator(locale)` / `getStaticFormatter(locale, timeZone)` for code outside React (RSS, emails, notification bodies, the worker). |
| `admin.ts`                | Payload admin languages and the `marmot:` translations used for collection labels (`adminT('marmot:language')`).                        |

Keys are type-checked: `src/types/next-intl.d.ts` derives them from `en.json`, so a missing or misspelt
key fails `pnpm typecheck`, and `tests/int/i18n.int.spec.ts` checks that every catalogue has the same keys.

### Adding a string

1. Add the key to `src/i18n/messages/en.json` under the namespace of the area (`statusPages.footer.rss`).
   Use camelCase leaves, name the key after its meaning rather than its English text, and keep whole
   sentences in one message (translators need the full sentence to reorder it).
2. Use it:
   - server components and `generateMetadata`: `const t = await getTranslations('statusPages.footer')`,
     then `t('rss')`;
   - client islands and shared components: `const t = useTranslations('statusPages.footer')`;
   - outside React (route handlers, worker): `getTranslator(locale)('statusPages.footer.rss')`.
3. Values are ICU messages: `{name}` placeholders, plurals
   `"{count, plural, one {# check} other {# checks}}"`, selects `"{status, select, up {…} other {…}}"`, and
   rich text `"No account yet? <link>Create one</link>"` rendered with
   `t.rich('noAccount', { link: (chunks) => <Link …>{chunks}</Link> })`.
4. Dates and numbers never go through `toLocaleString()`: use `useFormatter()` / `getFormatter()` with a
   named format (`format.dateTime(date, 'short')`, `format.number(fraction, 'percent')`). The request config
   renders in UTC, public status pages in the organization's `settings.timezone`; passing the zone explicitly
   is what keeps the server HTML and the client hydration identical.
5. Stable identifiers stay untranslated: monitor type slugs, status enum values, webhook payload keys, log
   lines and the `code` of API errors. Only their display labels are messages.

### Locale resolution

User preference (`users.language`) → `marmot-locale` cookie (signed-out pages; the language picker sets
it) → `Accept-Language` matched by base language → `defaultLocale`. Public status pages use their own
`language` setting, or follow the visitor when it is `auto`. `<html lang>` always reflects the result.

### Adding a language

1. Copy `src/i18n/messages/en.json` to `<locale>.json` and translate it (same keys; the catalogue format
   is plain nested JSON with ICU messages, which Crowdin, Weblate and Lingo.dev all handle).
2. Register it in `src/i18n/messages/index.ts` and append the locale to `locales` and `localeNames` in
   `src/i18n/locales.ts`. The language picker in **Settings → Account** and the status page builder
   appear automatically once more than one locale exists.
3. For the Payload admin, add the matching pack from `@payloadcms/translations/languages/<locale>` and
   translate the `marmot:` keys in `src/i18n/admin.ts`.
4. Run `pnpm check`: the typecheck and the catalogue test fail on missing keys.

## Migrations

Postgres uses Payload migrations in `src/migrations/postgres` (chained in `index.ts`); MongoDB needs none
(indexes are created on boot). After changing a collection, global or field:

```bash
pnpm generate:types
DATABASE_URL=postgres://marmot:marmot@localhost:5432/marmot_fresh pnpm migrate:create <name> --force-accept-warning
```

Create the migration against a **fresh** database that has only the existing migrations applied, so the
diff contains exactly your change: `createdb marmot_fresh`, then
`NODE_ENV=production DATABASE_URL=… pnpm migrate --force-accept-warning` to bring it to `main`, then
`migrate:create`. Never edit generated migration files by hand. If `main` gains a migration while your branch
is open, delete yours, restore `src/migrations/postgres/index.ts` from `main`, and regenerate on a fresh
database.

Migrations run automatically when the `web` role starts in the Docker image (`dist/server/migrate.mjs`,
`SKIP_MIGRATIONS=true` opts out) and can be run by hand with `pnpm migrate` (development) or
`pnpm migrate:prod` (from the bundle). `DATABASE_ADAPTER=mongodb pnpm migrate:create` creates a MongoDB
migration for the rare data or index migration.

## Server bundles

The Docker image does not ship TypeScript tooling. `pnpm build:server` (`scripts/build-server.mjs`) bundles
`src/worker.ts`, `src/realtime.ts` and `src/cli/migrate.ts` into `dist/server/{worker,realtime,migrate}.mjs`
with esbuild, keeping every package external. Consequences for server code:

- no `import.meta.url`-relative paths to repository files (use `process.cwd()`);
- no dynamic imports with computed specifiers; optional drivers are imported with a literal specifier;
- run `pnpm build:server` once when you touch `src/worker.ts`, `src/realtime.ts`, `src/server/**`,
  `src/collections/**` or `src/db/**`.

`pnpm start:worker`, `pnpm start:realtime` and `pnpm migrate:prod` run the bundles locally.

## Where things are

```
src/payload.config.ts            buildConfig; wires collections, plugins, db factory, email
src/env.ts                       zod-validated env (the only place process.env is read)
src/collections/                 one file per collection; register in index.ts
src/globals/                     instance settings
src/access/                      org RBAC helpers (orgScoped, permissions map)
src/auth/sso/                    single sign-on (payload-auth plugin wiring, providers, user matching)
src/server/engine/               BullMQ queues, schedulers, check worker, heartbeat state machine
src/server/monitor-types/        one file per type, self-registering
src/server/notification-providers/ one file per provider, self-registering
src/server/notifications/        dispatch, templates, notification worker
src/server/stats/                uptime calculator and rollups
src/server/realtime/             socket.io event names, emitter helpers, server auth
src/server/status-pages/         public payload, RSS, route helpers
src/app/(frontend)/              Marmot UI (App Router)
src/i18n/                        locales, message catalogues, formats, request locale (next-intl)
src/app/api/                     route handlers (org-scoped and public)
src/components/                  UI; shadcn primitives under components/ui
src/stores/                      Zustand stores fed by the socket client
tests/int, tests/e2e             Vitest integration tests, Playwright E2E
docker/                          Dockerfile, compose files, Caddyfile, entrypoint
```

Extension points (adding a monitor type or a notification provider) are described in
[`CONTRIBUTING.md`](../.github/CONTRIBUTING.md); the data flow is in [Architecture](Architecture.md).
