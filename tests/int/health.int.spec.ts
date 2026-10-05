import { getPayload, type Payload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'

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
