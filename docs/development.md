# Development

```bash
pnpm install
cp .env.example .env
pnpm services:up      # Postgres + Redis (+ Mongo with Docker)
pnpm dev              # web :3000 · worker · realtime :3001
```

- `pnpm check` runs lint, typecheck and integration tests. Integration tests use `.env.test`
  (database `marmot_test`).
- `pnpm test:e2e` runs Playwright against `pnpm dev:web` (or `E2E_WEB_COMMAND="pnpm start"` after a build).
- Switch databases with `DATABASE_ADAPTER` / `DATABASE_URL`. Create migrations with `pnpm migrate:create`
  for Postgres and `DATABASE_ADAPTER=mongodb pnpm migrate:create` for MongoDB.
- Regenerate types after changing collections: `pnpm generate:types`.
