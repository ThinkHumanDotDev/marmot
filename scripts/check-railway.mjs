#!/usr/bin/env node
// Checks the Railway config: .railway/railway.ts and the service images in deploy/railway/ (run by CI's
// lint job).
//
//   node scripts/check-railway.mjs
//
// .railway/railway.ts must evaluate and declare exactly one service per deploy/railway/<service>/
// folder, built from that folder's Dockerfile with the DOCKERFILE builder and watching the folder.
// Files a Dockerfile COPYs must exist: the build context is the repository root. Marmot images must use
// the version in package.json, so a release (scripts/release.sh) cannot leave Railway on an old image.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { tsImport } from 'tsx/esm/api'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIR = 'deploy/railway'
const IAC = '.railway/railway.ts'
const IMAGE = 'ghcr.io/thinkhumandotdev/marmot'

const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const errors = []

const services = readdirSync(path.join(ROOT, DIR)).filter((name) =>
  statSync(path.join(ROOT, DIR, name)).isDirectory(),
)
if (services.length === 0) errors.push(`${DIR}: no service folders`)

for (const service of services) {
  const dockerfile = `${DIR}/${service}/Dockerfile`
  if (!existsSync(path.join(ROOT, dockerfile))) {
    errors.push(`${dockerfile}: missing`)
    continue
  }
  const lines = readFileSync(path.join(ROOT, dockerfile), 'utf8').split('\n')
  for (const line of lines) {
    const from = line.match(/^FROM\s+(\S+)/i)
    if (from && from[1].startsWith(`${IMAGE}:`) && from[1] !== `${IMAGE}:${version}`) {
      errors.push(`${dockerfile}: ${from[1]} does not match package.json version ${version}`)
    }
    const copy = line.match(/^COPY\s+(?!--from)(?:--\S+\s+)*(\S+)\s+\S+/i)
    if (copy && !existsSync(path.join(ROOT, copy[1]))) {
      errors.push(
        `${dockerfile}: COPY source ${copy[1]} does not exist (context is the repository root)`,
      )
    }
  }
}

// Evaluate the program the way the Railway CLI does and compare its services with the folders.
try {
  const { createRailwayContext, project } = await import('railway/iac')
  const mod = await tsImport(pathToFileURL(path.join(ROOT, IAC)).href, import.meta.url)
  const program = mod.default?.default ?? mod.default
  const definition = await program(createRailwayContext({ environment: 'production' }), project)
  const declared = new Map(
    definition.resources
      .flat(Infinity)
      .filter((resource) => resource.type === 'service')
      .map((resource) => [resource.name, resource]),
  )
  for (const service of services) {
    const node = declared.get(service)
    const where = `${IAC}: service "${service}"`
    if (!node) {
      errors.push(`${IAC}: no service "${service}" for ${DIR}/${service}`)
      continue
    }
    if (node.build?.builder !== 'DOCKERFILE')
      errors.push(`${where}: build.builder must be DOCKERFILE`)
    if (node.build?.dockerfilePath !== `${DIR}/${service}/Dockerfile`) {
      errors.push(`${where}: build.dockerfilePath must be "${DIR}/${service}/Dockerfile"`)
    }
    if (!node.build?.watchPatterns?.includes(`${DIR}/${service}/**`)) {
      errors.push(`${where}: build.watchPatterns must include "${DIR}/${service}/**"`)
    }
  }
  for (const name of declared.keys()) {
    if (!services.includes(name))
      errors.push(`${IAC}: service "${name}" has no ${DIR}/${name} folder`)
  }
} catch (err) {
  errors.push(`${IAC}: failed to evaluate (${err.message})`)
}

if (errors.length > 0) {
  console.error(`Railway config check failed:\n  ${errors.join('\n  ')}`)
  process.exit(1)
}
console.log(`Railway config OK: ${services.join(', ')} (marmot ${version})`)
