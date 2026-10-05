#!/usr/bin/env node
// Bundles the long-running server entrypoints and the production migrate step into plain JavaScript
// (dist/server/*.mjs) so the container runs `node` directly. Loading TypeScript at runtime through
// tsx's async loader proved unreliable inside the image: the import of the Payload config module graph
// intermittently never settles (the worker sits silently forever, `payload migrate` exits 0 having run
// nothing). Only our own sources are bundled; every package stays external and is resolved from
// node_modules at runtime, so native modules (sharp, pg) and the database adapters work unchanged.
import { build } from 'esbuild'

const entryPoints = {
  worker: 'src/worker.ts',
  realtime: 'src/realtime.ts',
  migrate: 'src/cli/migrate.ts',
}

await build({
  entryPoints,
  outdir: 'dist/server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  // tsconfig paths (@/…, @payload-config) are resolved from tsconfig.json automatically.
  tsconfig: 'tsconfig.json',
})
