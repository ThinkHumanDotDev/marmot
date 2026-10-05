import path from 'path'
import { fileURLToPath } from 'url'
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import type { Config } from 'payload'

import { env } from '@/env'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Database adapter factory. Marmot is database-agnostic in the same way Payload is:
 * pick the adapter with `DATABASE_ADAPTER` and point `DATABASE_URL` at it.
 *
 * - postgres (default, production): migrations in `src/migrations/postgres`
 * - mongodb: migrations in `src/migrations/mongodb`
 * - sqlite: development / tiny installs; schema is pushed, no migrations are maintained
 *
 * Collections MUST stay portable across adapters: no `point` fields, no raw SQL, no
 * adapter-specific query operators. Compound indexes via `indexes` are fine.
 */
export function getDatabaseAdapter(): Config['db'] {
  const isProd = env.NODE_ENV === 'production'

  switch (env.DATABASE_ADAPTER) {
    case 'mongodb':
      return mongooseAdapter({
        url: env.DATABASE_URL,
        migrationDir: path.resolve(dirname, '../migrations/mongodb'),
      })
    case 'sqlite':
      return sqliteAdapter({
        client: { url: env.DATABASE_URL },
        push: !isProd,
        migrationDir: path.resolve(dirname, '../migrations/sqlite'),
      })
    case 'postgres':
    default:
      return postgresAdapter({
        pool: { connectionString: env.DATABASE_URL },
        push: !isProd,
        migrationDir: path.resolve(dirname, '../migrations/postgres'),
      })
  }
}
