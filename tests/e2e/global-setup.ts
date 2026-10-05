import { build } from 'esbuild'

import { RESET_DB_BUNDLE } from './e2e-env'

/**
 * Bundles `support/reset-db.ts` (and with it the Payload config) into plain JavaScript so the
 * database can be reset with `node` instead of loading TypeScript at runtime. Same options as
 * `scripts/build-server.mjs`: only our sources are bundled, packages stay external.
 */
export default async function globalSetup(): Promise<void> {
  await build({
    entryPoints: ['tests/e2e/support/reset-db.ts'],
    outfile: RESET_DB_BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    tsconfig: 'tsconfig.json',
    logLevel: 'warning',
  })
}
