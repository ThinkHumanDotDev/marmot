import { generateSync } from 'otplib'
import { describe, expect, it } from 'vitest'

import {
  consumeBackupCode,
  generateBackupCodes,
  hashBackupCodes,
  looksLikeBackupCode,
  normalizeBackupCode,
} from './backup-codes'
import {
  challengeCookie,
  clearChallengeCookie,
  openChallenge,
  sealChallenge,
  TWO_FACTOR_CHALLENGE_COOKIE,
} from './challenge'
import { decryptSecret, encryptSecret, hashBackupCode } from './crypto'
import { generateTotpSecret, TOTP_PERIOD_SECONDS, totpStep, totpUri, verifyTotp } from './totp'

const secret = 'test-secret-test-secret-test-secret'
const now = Date.UTC(2026, 9, 5, 12, 0, 0)
const step = TOTP_PERIOD_SECONDS * 1000

const codeAt = (totpSecret: string, at: number) =>
  generateSync({ secret: totpSecret, epoch: Math.floor(at / 1000) })

describe('TOTP verification', () => {
  const totpSecret = generateTotpSecret()

  it('generates base32 secrets and otpauth URIs for authenticator apps', () => {
    expect(totpSecret).toMatch(/^[A-Z2-7]+$/)
    const uri = totpUri('ada@example.com', totpSecret)
    expect(uri.startsWith('otpauth://totp/Marmot:ada%40example.com?')).toBe(true)
    expect(uri).toContain(`secret=${totpSecret}`)
    expect(uri).toContain('issuer=Marmot')
  })

  it('accepts the current code and the adjacent steps, nothing further', () => {
    expect(verifyTotp(codeAt(totpSecret, now), totpSecret, { now })).toEqual({
      valid: true,
      step: totpStep(now),
    })
    expect(verifyTotp(codeAt(totpSecret, now - step), totpSecret, { now })).toMatchObject({
      valid: true,
      step: totpStep(now) - 1,
    })
    expect(verifyTotp(codeAt(totpSecret, now + step), totpSecret, { now })).toMatchObject({
      valid: true,
      step: totpStep(now) + 1,
    })
    expect(verifyTotp(codeAt(totpSecret, now - 2 * step), totpSecret, { now })).toEqual({
      valid: false,
    })
    expect(verifyTotp(codeAt(totpSecret, now + 2 * step), totpSecret, { now })).toEqual({
      valid: false,
    })
  })

  it('rejects wrong, malformed and foreign-secret codes', () => {
    const code = codeAt(totpSecret, now)
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
    expect(verifyTotp(wrong, totpSecret, { now })).toEqual({ valid: false })
    expect(verifyTotp('12345', totpSecret, { now })).toEqual({ valid: false })
    expect(verifyTotp('abcdef', totpSecret, { now })).toEqual({ valid: false })
    expect(verifyTotp(code, generateTotpSecret(), { now })).toEqual({ valid: false })
  })

  it('tolerates whitespace in the typed code', () => {
    const code = codeAt(totpSecret, now)
    expect(verifyTotp(`${code.slice(0, 3)} ${code.slice(3)}`, totpSecret, { now }).valid).toBe(true)
  })

  it('refuses a replayed code (same or earlier step than the last accepted one)', () => {
    const code = codeAt(totpSecret, now)
    const first = verifyTotp(code, totpSecret, { now })
    expect(first.valid).toBe(true)
    const lastUsedStep = first.valid ? first.step : 0
    expect(verifyTotp(code, totpSecret, { now, lastUsedStep })).toEqual({ valid: false })
    // The previous step's code is inside the window but older than the accepted one.
    expect(verifyTotp(codeAt(totpSecret, now - step), totpSecret, { now, lastUsedStep })).toEqual({
      valid: false,
    })
    // The next step is fine.
    expect(
      verifyTotp(codeAt(totpSecret, now + step), totpSecret, { now: now + step, lastUsedStep }),
    ).toMatchObject({ valid: true })
  })
})

describe('secret encryption at rest', () => {
  it('round-trips and never stores the plaintext', () => {
    const plain = generateTotpSecret()
    const sealed = encryptSecret(plain, secret)
    expect(sealed.startsWith('v1.')).toBe(true)
    expect(sealed).not.toContain(plain)
    expect(decryptSecret(sealed, secret)).toBe(plain)
    expect(encryptSecret(plain, secret)).not.toBe(sealed) // fresh IV every time
  })

  it('rejects the wrong key, tampering and garbage', () => {
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP', secret)
    expect(decryptSecret(sealed, `${secret}x`)).toBeNull()
    const [v, iv, ct, tag] = sealed.split('.')
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)
    expect(decryptSecret([v, iv, flipped, tag].join('.'), secret)).toBeNull()
    expect(decryptSecret('v0.a.b.c', secret)).toBeNull()
    expect(decryptSecret('nonsense', secret)).toBeNull()
    expect(decryptSecret(null, secret)).toBeNull()
  })
})

describe('backup codes', () => {
  it('generates ten unambiguous xxxxx-xxxxx codes', () => {
    const codes = generateBackupCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const code of codes) {
      expect(code).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/)
      expect(looksLikeBackupCode(code)).toBe(true)
    }
    expect(looksLikeBackupCode('123456')).toBe(false)
  })

  it('is consumed exactly once, regardless of formatting', () => {
    const codes = generateBackupCodes(3)
    const hashes = hashBackupCodes(codes, secret)
    expect(hashes).not.toContain(normalizeBackupCode(codes[0]))

    const typed = codes[1].toUpperCase().replace('-', ' ')
    const remaining = consumeBackupCode(typed, hashes, secret)
    expect(remaining).toHaveLength(2)
    expect(remaining).not.toContain(hashBackupCode(normalizeBackupCode(codes[1]), secret))

    expect(consumeBackupCode(codes[1], remaining, secret)).toBeNull()
    expect(consumeBackupCode(codes[0], remaining, secret)).toHaveLength(1)
    expect(consumeBackupCode(codes[0], hashBackupCodes(codes, `${secret}x`), secret)).toBeNull()
    expect(consumeBackupCode(codes[0], 'not-a-list', secret)).toBeNull()
  })
})

describe('login challenge cookie', () => {
  it('round-trips the user id and attempt counter', async () => {
    // A distinctive id: a short one like '42' turns up in random base64url ciphertext now and then.
    const userId = 'user-id-in-plaintext'
    const sealed = await sealChallenge({ userId, attempts: 2 }, secret, { now })
    expect(sealed).not.toContain(userId)
    expect(await openChallenge(sealed, secret, { now })).toEqual({ userId, attempts: 2 })
  })

  it('expires, and rejects foreign or malformed tokens', async () => {
    const sealed = await sealChallenge({ userId: '42', attempts: 0 }, secret, { now })
    expect(await openChallenge(sealed, secret, { now: now + 6 * 60 * 1000 })).toBeNull()
    expect(await openChallenge(sealed, `${secret}x`, { now })).toBeNull()
    expect(await openChallenge('garbage', secret, { now })).toBeNull()
    expect(await openChallenge(undefined, secret, { now })).toBeNull()
  })

  it('scopes the cookie to the auth endpoints', () => {
    const set = challengeCookie('abc', { secure: true })
    expect(set).toContain(`${TWO_FACTOR_CHALLENGE_COOKIE}=abc`)
    expect(set).toContain('Path=/api/auth')
    expect(set).toContain('HttpOnly')
    expect(set).toContain('Secure')
    expect(clearChallengeCookie({ secure: false })).toContain('Max-Age=0')
  })
})
