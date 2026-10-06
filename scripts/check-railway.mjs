#!/usr/bin/env node
// Checks the Railway template config in deploy/railway/ (run by CI's lint job).
//
//   node scripts/check-railway.mjs
//
// Every service folder needs a Dockerfile and a railway.json whose build points at that Dockerfile and
// watches the folder. Files a Dockerfile COPYs must exist: the build context is the repository root. Marmot
// images must use the version in package.json, so a release (scripts/release.sh) cannot leave the template
// on an old image. The deploy/railway/README.md lists how the folders map to the published template.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIR = 'deploy/railway'
const IMAGE = 'ghcr.io/thinkhumandotdev/marmot'

const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const errors = []

const services = readdirSync(path.join(ROOT, DIR)).filter((name) =>
  statSync(path.join(ROOT, DIR, name)).isDirectory(),
)
if (services.length === 0) errors.push(`${DIR}: no service folders`)

for (const service of services) {
  const folder = `${DIR}/${service}`
  const dockerfile = `${folder}/Dockerfile`
  const configFile = `${folder}/railway.json`

  if (!existsSync(path.join(ROOT, dockerfile))) {
    errors.push(`${dockerfile}: missing`)
    continue
  }
  if (!existsSync(path.join(ROOT, configFile))) {
    errors.push(`${configFile}: missing`)
    continue
  }

  let config
  try {
    config = JSON.parse(readFileSync(path.join(ROOT, configFile), 'utf8'))
  } catch (err) {
    errors.push(`${configFile}: invalid JSON (${err.message})`)
    continue
  }
  const build = config.build ?? {}
  if (build.builder !== 'DOCKERFILE') {
    errors.push(`${configFile}: build.builder must be "DOCKERFILE"`)
  }
  if (build.dockerfilePath !== dockerfile) {
    errors.push(`${configFile}: build.dockerfilePath must be "${dockerfile}"`)
  }
  if (!build.watchPatterns?.includes(`${folder}/**`)) {
    errors.push(`${configFile}: build.watchPatterns must include "${folder}/**"`)
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

if (errors.length > 0) {
  console.error(`Railway config check failed:\n  ${errors.join('\n  ')}`)
  process.exit(1)
}
console.log(`Railway config OK: ${services.join(', ')} (marmot ${version})`)
