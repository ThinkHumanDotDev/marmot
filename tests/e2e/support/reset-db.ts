/**
 * Standalone database reset for the e2e suite: deletes every document of every collection through
 * the Payload Local API, leaving the instance in "needs setup" state. Works on Postgres and MongoDB;
 * collection hooks run, so deleting monitors also removes their BullMQ schedulers.
 *
 * The Playwright process never imports the Payload config (loading its module graph through a
 * runtime TypeScript loader intermittently never settles). Instead `global-setup.ts` bundles this
 * file with esbuild, like `scripts/build-server.mjs` does for the worker, and `resetDatabase()` in
 * `fixtures.ts` runs the bundle with plain `node`.
 */
import { getPayload, type CollectionSlug } from 'payload'

import config from '@payload-config'
import { deleteInBatches } from '@/db/delete-in-batches'

// Never touched: dropping applied migrations would make `payload migrate` re-run them.
const KEEP = new Set<string>(['payload-migrations'])
// Removed last so nothing that references them is left behind (hooks may look them up).
const LAST = ['users', 'organizations']

async function main(): Promise<void> {
  const payload = await getPayload({ config })
  const slugs = payload.config.collections
    .map((c) => c.slug)
    .filter((slug) => !KEEP.has(slug))
    .sort((a, b) => LAST.indexOf(a) - LAST.indexOf(b))

  let failures: string[] = []
  // A second pass catches documents a hook recreated or a reference that blocked the first one.
  for (let pass = 0; pass < 2; pass++) {
    failures = []
    for (const slug of slugs) {
      try {
        // In batches, so a large heartbeat table never has to fit in memory (#237).
        await deleteInBatches(payload, slug as CollectionSlug, {}, { hooks: true })
      } catch (error) {
        failures.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length === 0) break
  }

  const { totalDocs } = await payload.count({ collection: 'users', overrideAccess: true })
  if (failures.length > 0 || totalDocs > 0) {
    throw new Error(`Database reset failed (${totalDocs} users left):\n${failures.join('\n')}`)
  }
  await payload.db.destroy?.()
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  },
)
