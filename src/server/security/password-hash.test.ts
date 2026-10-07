import { describe, expect, it } from 'vitest'

import { hashPassword, verifyPassword } from './password-hash'

const CHEAP = { N: 2 ** 10, r: 8, p: 1 }

describe('password hashing', () => {
  it('verifies the right password and refuses others', async () => {
    const hash = await hashPassword('correct horse', CHEAP)
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/)
    expect(await verifyPassword('correct horse', hash)).toBe(true)
    expect(await verifyPassword('correct horse ', hash)).toBe(false)
    expect(await verifyPassword('', hash)).toBe(false)
  })

  it('salts every hash', async () => {
    expect(await hashPassword('same', CHEAP)).not.toBe(await hashPassword('same', CHEAP))
  })

  it('uses the default cost when none is given', async () => {
    const hash = await hashPassword('default cost')
    expect(hash.startsWith('scrypt$32768$8$1$')).toBe(true)
    expect(await verifyPassword('default cost', hash)).toBe(true)
  })

  it('treats missing, malformed and absurd hashes as a mismatch', async () => {
    const hash = await hashPassword('pw', CHEAP)
    const [, , , , salt, key] = hash.split('$')
    for (const stored of [
      null,
      undefined,
      '',
      'plain',
      'bcrypt$x',
      `scrypt$1000$8$1$${salt}$${key}`, // N not a power of two
      `scrypt$${2 ** 24}$8$1$${salt}$${key}`, // too expensive
      `scrypt$1024$8$1$${salt}$${key.slice(0, 10)}`, // truncated key
    ]) {
      expect(await verifyPassword('pw', stored)).toBe(false)
    }
  })
})
