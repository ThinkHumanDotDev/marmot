#!/usr/bin/env node
// Runs a long-running TypeScript entrypoint (src/worker.ts, src/realtime.ts) with tsx.
//
// Why not `payload run`? It calls process.exit(0) as soon as the module has been imported, which kills
// servers that start asynchronously. Why not the `tsx` CLI? While tsx transpiles the Payload config's
// module graph nothing holds a reference on the event loop, so Node intermittently exits with code 0
// (or 13) before the import settles. The keep-alive timer below holds the loop open until the entry
// module has finished loading; the module itself (HTTP server, DB pool, queues) keeps it alive after.
import module from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const script = process.argv[2]
if (!script) {
  console.error('usage: run-ts.mjs <entrypoint.ts> [args...]')
  process.exit(2)
}

// Prefer tsx's async `module.register()` loader over the synchronous `registerHooks` path, which
// mangles specifiers on some Node versions (payloadcms/payload#16949).
if (typeof module.registerHooks === 'function') {
  module.registerHooks = undefined
}

const { tsImport } = await import('tsx/esm/api')
// Make process.argv look like `node <entrypoint> [args...]` for the script.
process.argv.splice(1, 1)

const keepAlive = setInterval(() => {}, 1_000)
try {
  await tsImport(pathToFileURL(path.resolve(script)).href, import.meta.url)
} finally {
  clearInterval(keepAlive)
}
