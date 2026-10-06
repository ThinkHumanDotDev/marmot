# Marmot — agent guide

Marmot is a self-hosted status monitor (Uptime Kuma feature set, kan.bn-style organizations) built on
Payload CMS 3 + Next.js. Read `.claude/skills/marmot-conventions/SKILL.md` before changing anything and
`.claude/skills/payload/SKILL.md` for Payload specifics. The architecture is described in
`docs/Architecture.md`.

## Commands

- `pnpm services:up` – start Postgres + Redis (Docker, or local binaries when Docker is missing)
- `pnpm dev` – web (:3000) + worker + realtime (:3001); `pnpm dev:web` for the web app only
- `pnpm check` – lint + typecheck + integration tests (run before every push)
- `pnpm test:e2e` – Playwright (set `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` in this cloud env)
- `pnpm generate:types` – regenerate `src/payload-types.ts` after changing collections
- `pnpm migrate:create` – create a Postgres migration (set `DATABASE_ADAPTER=mongodb` for Mongo)

## Hard rules

- Conventional Commits, **no trailers** (no Co-authored-by, no session links). Plain branch names
  (`feat/…`, `fix/…`, `chore/…`); never `claude/*`.
- Collections must work on Postgres and MongoDB. No `point` fields, no raw SQL, no adapter-specific operators.
- Read configuration via `src/env.ts` only; document new variables in `.env.example` and `docs/Configuration.md`.
- Never skip or disable tests to get green. Keep PRs focused; one issue per PR.
- When porting from Uptime Kuma, add an attribution comment and list the file in `THIRD_PARTY_NOTICES.md`.
