import { describe, expect, it } from 'vitest'

import {
  accessCookie,
  accessCookieName,
  checkStatusPageAccess,
  signAccessToken,
  verifyAccessToken,
  type AccessPage,
} from './access'

import type { Payload } from 'payload'

const page: AccessPage = { id: 42, access: 'password', passwordHash: 'scrypt$hash-one' }
const payload = {} as Payload

describe('status page access tokens', () => {
  it('round-trips for the page it was issued for', async () => {
    const token = await signAccessToken(page)
    expect(await verifyAccessToken(page, token)).toBe(true)
  })

  it('is bound to the page id and the current password hash', async () => {
    const token = await signAccessToken(page)
    expect(await verifyAccessToken({ ...page, id: 43 }, token)).toBe(false)
    expect(await verifyAccessToken({ ...page, passwordHash: 'scrypt$hash-two' }, token)).toBe(false)
  })

  it('expires', async () => {
    const now = Date.now()
    const token = await signAccessToken(page, { now, ttlSeconds: 60 })
    expect(await verifyAccessToken(page, token, { now: now + 30_000 })).toBe(true)
    expect(await verifyAccessToken(page, token, { now: now + 61_000 })).toBe(false)
  })

  it('refuses tampered and foreign tokens', async () => {
    const token = await signAccessToken(page)
    const [header, body, signature] = token.split('.')
    expect(await verifyAccessToken(page, `${header}.${body}.${signature}x`)).toBe(false)
    expect(await verifyAccessToken(page, `${header}.${body}.`)).toBe(false)
    expect(await verifyAccessToken(page, 'not-a-token')).toBe(false)
    expect(await verifyAccessToken(page, undefined)).toBe(false)
  })

  it('builds an HttpOnly, SameSite=Lax cookie named after the page', () => {
    expect(accessCookieName('65a1b2c3d4e5f60718293a4b')).toBe('marmot_sp_65a1b2c3d4e5f60718293a4b')
    const cookie = accessCookie(42, 'tok', { secure: true, maxAge: 60 })
    expect(cookie).toBe('marmot_sp_42=tok; Max-Age=60; Path=/; HttpOnly; SameSite=Lax; Secure')
  })
})

describe('checkStatusPageAccess', () => {
  it('lets everyone view public pages', async () => {
    const decision = await checkStatusPageAccess(
      payload,
      { id: 1, access: 'public' },
      { headers: new Headers() },
    )
    expect(decision).toEqual({ allowed: true, via: 'public', restricted: false })
  })

  it('grants a session to a valid cookie', async () => {
    const token = await signAccessToken(page)
    const decision = await checkStatusPageAccess(payload, page, {
      headers: new Headers({ cookie: `other=1; ${accessCookieName(page.id)}=${token}` }),
    })
    expect(decision).toEqual({ allowed: true, via: 'session', restricted: true })
  })

  it('asks for a login without credentials, and when no password is stored', async () => {
    expect(await checkStatusPageAccess(payload, page, { headers: new Headers() })).toEqual({
      allowed: false,
      reason: 'login-required',
    })
    expect(
      await checkStatusPageAccess(
        payload,
        { ...page, passwordHash: null },
        { headers: new Headers(), searchParams: new URLSearchParams('pw=anything') },
      ),
    ).toEqual({ allowed: false, reason: 'login-required' })
  })

  it('ignores ?pw= where it is not accepted (the HTML page)', async () => {
    const decision = await checkStatusPageAccess(
      payload,
      page,
      { headers: new Headers(), searchParams: new URLSearchParams('pw=anything') },
      { acceptPasswordParam: false },
    )
    expect(decision).toEqual({ allowed: false, reason: 'login-required' })
  })

  it('fails closed for unknown access modes', async () => {
    const decision = await checkStatusPageAccess(
      payload,
      { id: 1, access: 'magic-link' as never },
      { headers: new Headers() },
    )
    expect(decision.allowed).toBe(false)
  })
})
