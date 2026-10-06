---
name: marmot-conventions
description: Project structure, coding conventions, extension points, testing and PR rules for the Marmot status monitor. Use for any change in this repository.
---

# Marmot conventions

## Layout

```
src/payload.config.ts            buildConfig; wires collections, plugins, db factory, email
src/env.ts                       zod-validated env (the only place process.env is read)
src/db/adapter.ts                DATABASE_ADAPTER factory (postgres | mongodb | sqlite)
src/collections/                 one file per collection; register in index.ts
src/access/                      org RBAC helpers (orgScoped, hasRole, permissions map)
src/auth/oidc/                   openid-client auth strategy + endpoints
src/server/monitor-types/        one file per type, self-registering (registerMonitorType)
src/server/notification-providers/ one file per provider, self-registering
src/server/engine/               BullMQ queues, schedulers, check worker, heartbeat state machine
src/server/jobs/                 rollups, retention, cert expiry, maintenance state
src/server/realtime/             socket.io event names, emitter helpers, server auth
src/server/email/                nodemailer adapter + templates
src/app/(payload)/               Payload admin + REST/GraphQL (do not edit except importMap)
src/app/(frontend)/              Marmot UI (App Router, server components + client islands)
src/app/api/                     public endpoints: health, badge, push, metrics
src/components/ui/               shadcn/ui primitives (themed); src/components/* app components
src/stores/                      Zustand stores (live monitor state, ring buffers)
src/lib/                         socket client, API client, logger, utils
src/worker.ts, src/realtime.ts   process entrypoints
tests/int/*.int.spec.ts          Vitest integration tests (real DB from .env.test)
tests/e2e/*.e2e.spec.ts          Playwright critical paths
```

## Rules

1. **Database portability**: every collection runs on Postgres and MongoDB. No `point` fields, no raw
   SQL, no `$`-operators. Use `indexes: [{ fields: [...], unique: true }]` for compound indexes. IDs may be
   numbers (Postgres) or strings (Mongo): type them as `string | number` and compare with `String(id)`.
2. **Payload access**: non-admin reads/writes go through Payload with `overrideAccess: false` and the
   request user. Worker/background code uses the Local API with `overrideAccess: true` and sets
   `organization` explicitly.
3. **Hooks**: pass `req` through nested operations (transactions) and guard against loops with
   `req.context`. Side effects that talk to Redis belong in `afterChange`/`afterDelete`.
4. **Realtime**: the web and worker processes never hold socket.io servers; they publish with
   `@socket.io/redis-emitter` to room `org:<id>` using names from `src/server/realtime/events.ts`.
5. **Extension points**: adding a monitor type or notification provider = one new file + one import line
   in the directory's `index.ts`. Port from Uptime Kuma (MIT, `scratchpad/refs/uptime-kuma` when available)
   with an attribution comment and an entry in `THIRD_PARTY_NOTICES.md`.
6. **UI**: shadcn/ui primitives only in `src/components/ui`; theme tokens live in
   `src/app/(frontend)/styles.css`. Live data flows socket → Zustand → selectors; never store heartbeats in
   React state. Pages are server components that load initial data via the Local API, hydrate stores, then
   subscribe.
7. **Config**: new env vars go in `src/env.ts`, `.env.example`, `docs/Configuration.md` and, if relevant,
   `docker/docker-compose.yml`.
8. **Tests**: integration tests for behaviour that can break silently (access control, engine state machine,
   rollups, provider payloads). E2E only for critical paths. No snapshot tests, no tests for trivial getters.
9. **Commits & PRs**: Conventional Commits (`feat(engine): …`), no trailers. Branch `feat/<slug>` from
   `main`, one issue per PR, `Closes #NN` in the body, run `pnpm check` before pushing. CI must be green on
   Postgres and MongoDB before merge; PRs are squash-merged.
10. **Don't** touch `src/app/(payload)/*` except `importMap.js` regeneration, don't edit
    `src/payload-types.ts` by hand (`pnpm generate:types`), don't add a monorepo.

## Local services in this cloud environment

No Docker daemon. Run `pnpm services:up` (starts redis-server + Postgres 16 via pg_ctlcluster, creates
`marmot` and `marmot_test`). MongoDB is not available locally; CI covers it. Chromium for Playwright is at
`/opt/pw-browsers/chromium` (`PLAYWRIGHT_CHROMIUM_PATH`).
