import { describe, expect, it } from 'vitest'

import {
  clearStateCookie,
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_SECONDS,
  openTransaction,
  readCookie,
  sealTransaction,
  stateCookie,
  type OidcTransaction,
} from './state'

const secret = 'test-secret-test-secret-test-secret'
const tx: OidcTransaction = {
  state: 'state-123',
  nonce: 'nonce-456',
  codeVerifier: 'verifier-789',
  next: '/acme/monitors',
}

describe('OIDC transaction cookie', () => {
  it('round-trips through seal/open', async () => {
    const sealed = await sealTransaction(tx, secret)
    expect(sealed.split('.')).toHaveLength(5) // compact JWE
    expect(sealed).not.toContain(tx.state)
    expect(sealed).not.toContain(tx.codeVerifier)
    expect(await openTransaction(sealed, secret)).toEqual(tx)
  })

  it('rejects the wrong secret, tampering, garbage and missing values', async () => {
    const sealed = await sealTransaction(tx, secret)
    expect(await openTransaction(sealed, `${secret}x`)).toBeNull()
    const [h, k, iv, ct, tag] = sealed.split('.')
    const flipped = ct[0] === 'A' ? 'B' : 'A'
    expect(
      await openTransaction([h, k, iv, flipped + ct.slice(1), tag].join('.'), secret),
    ).toBeNull()
    expect(await openTransaction('not-a-token', secret)).toBeNull()
    expect(await openTransaction(undefined, secret)).toBeNull()
    expect(await openTransaction('', secret)).toBeNull()
  })

  it('expires after the TTL', async () => {
    const now = Date.now()
    const sealed = await sealTransaction(tx, secret, { now })
    expect(
      await openTransaction(sealed, secret, { now: now + (OIDC_STATE_TTL_SECONDS - 5) * 1000 }),
    ).not.toBeNull()
    expect(
      await openTransaction(sealed, secret, { now: now + (OIDC_STATE_TTL_SECONDS + 5) * 1000 }),
    ).toBeNull()
  })

  it('builds HttpOnly, Lax, path-scoped cookies', () => {
    const set = stateCookie('abc', { secure: true })
    expect(set).toMatch(
      new RegExp(`^${OIDC_STATE_COOKIE}=abc; Max-Age=${OIDC_STATE_TTL_SECONDS}; `),
    )
    expect(set).toContain('Path=/api/auth/oidc')
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Lax')
    expect(set).toContain('Secure')
    expect(stateCookie('abc', { secure: false })).not.toContain('Secure')

    const clear = clearStateCookie({ secure: false })
    expect(clear).toMatch(new RegExp(`^${OIDC_STATE_COOKIE}=; Max-Age=0; `))
  })

  it('reads a single cookie from the Cookie header', () => {
    const headers = new Headers({ cookie: 'a=1; marmot-oidc=x%3Dy; payload-token=zzz' })
    expect(readCookie(headers, 'marmot-oidc')).toBe('x=y')
    expect(readCookie(headers, 'payload-token')).toBe('zzz')
    expect(readCookie(headers, 'missing')).toBeUndefined()
    expect(readCookie(new Headers(), 'a')).toBeUndefined()
  })
})
