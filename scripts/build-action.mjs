#!/usr/bin/env node
// Bundles the Marmot GitHub Action (#118, src/action) into action/dist/index.mjs: one self-contained
// file with the CLI core, zod, yaml and the message catalogue, run by the runner's own Node
// (`runs.using: node24` in action/action.yml). The bundle is committed so `uses: …/marmot/action@<ref>`
// works for any tag, branch or commit without building the app; CI rebuilds it and fails when the
// committed file is stale (`pnpm build:action && git diff --exit-code action/dist`).
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { build } from 'esbuild'

/**
 * Message namespaces the action renders: its own and the CLI's (`cli`) and the monitor validation
 * messages of the plan (`monitors.validation`). Only these are bundled, so the committed bundle does
 * not go stale with every change to the rest of the catalogue.
 */
const MESSAGE_NAMESPACES = ['cli', 'monitors.validation']

const pick = (messages, path) => {
  const parts = path.split('.')
  const value = parts.reduce((node, part) => node?.[part], messages)
  if (value === undefined) throw new Error(`en.json has no namespace ${path}`)
  return parts.reduceRight((inner, part) => ({ [part]: inner }), value)
}

const merge = (a, b) => {
  const out = { ...a }
  for (const [key, value] of Object.entries(b)) {
    out[key] = out[key] && typeof value === 'object' ? merge(out[key], value) : value
  }
  return out
}

/** @type {import('esbuild').Plugin} */
const trimJson = {
  name: 'trim-json',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]i18n[\\/]messages[\\/]en\.json$/ }, async (args) => {
      const messages = JSON.parse(await readFile(args.path, 'utf8'))
      const subset = MESSAGE_NAMESPACES.map((ns) => pick(messages, ns)).reduce(merge, {})
      return { contents: JSON.stringify(subset), loader: 'json' }
    })
    // The CLI reads only `version` from package.json (the User-Agent); dependency changes must not
    // change the bundle.
    build.onLoad({ filter: /[\\/]package\.json$/ }, async (args) => {
      if (args.path !== path.resolve('package.json')) return undefined
      const { version } = JSON.parse(await readFile(args.path, 'utf8'))
      return { contents: JSON.stringify({ version }), loader: 'json' }
    })
  },
}

await build({
  entryPoints: { index: 'src/action/index.ts' },
  outdir: 'action/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  // next-intl's React dependency: the production build is smaller and has no dev warnings.
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  // Bundled CommonJS dependencies (yaml) `require()` Node built-ins.
  banner: {
    js: "import { createRequire as __marmotCreateRequire } from 'node:module'\nconst require = __marmotCreateRequire(import.meta.url)",
  },
  plugins: [trimJson],
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
})
