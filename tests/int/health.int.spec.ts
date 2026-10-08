import { getPayload, type Payload } from 'payload'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import pkg from '../../package.json' with { type: 'json' }
import { GET } from '@/app/api/health/route'

let payload: Payload

describe('payload boot', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
  })

  it('connects to the configured database adapter and lists users', async () => {
    const users = await payload.find({ collection: 'users', limit: 1 })
    expect(users.docs).toBeDefined()
  })

  it('registers the core collections', () => {
    const slugs = payload.config.collections.map((c) => c.slug)
    expect(slugs).toContain('users')
    expect(slugs).toContain('media')
  })
})

describe('GET /api/health', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // #238: the Docker image starts Node directly, so npm_package_version is unset there.
  it("reports package.json's version without a package-manager environment", async () => {
    vi.stubEnv('npm_package_version', undefined)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string; version: string }
    expect(body).toMatchObject({ ok: true, service: 'marmot', version: pkg.version })
    expect(body.version).not.toBe('0.0.0')
  })
})
