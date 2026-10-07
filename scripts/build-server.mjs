#!/usr/bin/env node
// Bundles the long-running server entrypoints, the production migrate step and the CLI into plain JavaScript
// (dist/server/*.mjs) so the container runs `node` directly. Loading TypeScript at runtime through
// tsx's async loader proved unreliable inside the image: the import of the Payload config module graph
// intermittently never settles (the worker sits silently forever, `payload migrate` exits 0 having run
// nothing). Only our own sources are bundled; every package stays external and is resolved from
// node_modules at runtime, so native modules (sharp, pg) and the database adapters work unchanged.
import { chmod } from 'node:fs/promises'

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

// The `marmot` CLI (#116, `bin` in package.json): one self-contained file with its dependencies
// (zod, yaml, the message catalogue) bundled in, so it runs anywhere Node runs, without the app's
// node_modules. It talks to Marmot over HTTP only and never loads the Payload config.
await build({
  entryPoints: { marmot: 'src/cli/marmot.ts' },
  outdir: 'dist/cli',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Bundled CommonJS dependencies (yaml) `require()` Node built-ins.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __marmotCreateRequire } from 'node:module'\nconst require = __marmotCreateRequire(import.meta.url)",
  },
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
})
await chmod('dist/cli/marmot.mjs', 0o755)
