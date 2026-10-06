import { describe, expect, it } from 'vitest'

import { loadEnv } from '@/env'
import { resolveHomeRoute } from '@/server/home'

/** `/` routing: the landing page must only ever replace the login redirect for signed-out visitors. */
describe('home route', () => {
  const base = { userHome: null, setupNeeded: false, landingEnabled: false }

  it('keeps self-hosted behaviour by default', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      PAYLOAD_SECRET: 'x'.repeat(16),
      DATABASE_URL: 'postgres://localhost/x',
    })
    expect(env.LANDING_PAGE_ENABLED).toBe(false)
    expect(resolveHomeRoute({ ...base, landingEnabled: env.LANDING_PAGE_ENABLED })).toEqual({
      kind: 'redirect',
      to: '/login',
    })
  })

  it('shows the landing page to signed-out visitors when enabled', () => {
    expect(resolveHomeRoute({ ...base, landingEnabled: true })).toEqual({ kind: 'landing' })
  })

  it('sends a fresh install to the setup wizard whatever the flag says', () => {
    for (const landingEnabled of [false, true]) {
      expect(resolveHomeRoute({ ...base, setupNeeded: true, landingEnabled })).toEqual({
        kind: 'redirect',
        to: '/setup',
      })
    }
  })

  it('sends signed-in users to their organization whatever the flag says', () => {
    for (const landingEnabled of [false, true]) {
      expect(resolveHomeRoute({ ...base, userHome: '/acme', landingEnabled })).toEqual({
        kind: 'redirect',
        to: '/acme',
      })
    }
  })
})
