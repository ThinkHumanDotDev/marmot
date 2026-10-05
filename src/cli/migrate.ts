/**
 * Production migration runner (`pnpm migrate:prod`, used by docker/entrypoint.sh). It is bundled by
 * scripts/build-server.mjs together with the migrations themselves, so the container needs neither
 * the Payload CLI nor a TypeScript loader to bring the schema up to date.
 *
 * Pass `--force-accept-warning` to migrate a database that was last touched by Payload's dev-mode
 * schema push (the CLI asks interactively in that case; a container has no terminal to answer with).
 */
import 'dotenv/config'
import { getPayload, type Migration } from 'payload'

import config from '@payload-config'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { migrations as postgresMigrations } from '@/migrations/postgres'

const log = childLogger('migrate')
const forceAcceptWarning = process.argv.includes('--force-accept-warning')

async function main(): Promise<void> {
  const payload = await getPayload({ config })
  try {
    if (env.DATABASE_ADAPTER === 'sqlite') {
      log.info(
        'sqlite pushes its schema in development and is not supported in production; nothing to migrate',
      )
      return
    }
    if (forceAcceptWarning) {
      // Payload's own migrate() refuses to continue when it finds a dev-mode push marker (batch -1).
      // Accepting the warning means dropping that marker so the real migrations are recorded normally.
      try {
        await payload.delete({
          collection: 'payload-migrations',
          where: { batch: { equals: -1 } },
          depth: 0,
        })
      } catch {
        // A fresh database has no payload-migrations table yet; migrate() creates it.
      }
    }
    // MongoDB has no migrations yet (src/migrations/mongodb is empty); its collections are schemaless.
    // Payload types migration arguments as `unknown`; the generated files type them per adapter.
    const migrations: Migration[] =
      env.DATABASE_ADAPTER === 'postgres' ? (postgresMigrations as unknown as Migration[]) : []
    await payload.db.migrate({ migrations })
    log.info({ adapter: payload.db.name, migrations: migrations.length }, 'migrations complete')
  } finally {
    await payload.db.destroy?.()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err }, 'migration failed')
    process.exit(1)
  })
