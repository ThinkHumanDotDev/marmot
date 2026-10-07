import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Password hashing for secrets Marmot stores itself (status page passwords). User passwords are
 * hashed by Payload. scrypt is memory-hard and ships with Node, so no native dependency is needed.
 *
 * Format: `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url), so the cost can be raised later without
 * invalidating existing hashes: verification reads the parameters from the stored value.
 */

const PREFIX = 'scrypt'
const KEY_LENGTH = 32
const SALT_LENGTH = 16
/** N = 2^15, r = 8: 32 MiB and roughly 50–100 ms per hash on a small server. */
const DEFAULT_COST = { N: 2 ** 15, r: 8, p: 1 }
/** Upper bounds for parameters read back from the database. */
const MAX_N = 2 ** 20
const MAX_R = 32
const MAX_P = 16

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }) {
  const options: ScryptOptions = { ...cost, maxmem: 256 * cost.N * cost.r + 1024 * 1024 }
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

export async function hashPassword(
  password: string,
  cost: { N: number; r: number; p: number } = DEFAULT_COST,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, cost)
  return [
    PREFIX,
    cost.N,
    cost.r,
    cost.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$')
}

/** Constant-time check of `password` against a `hashPassword` value; false for malformed hashes. */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored || typeof password !== 'string') return false
  const [prefix, n, r, p, saltRaw, keyRaw] = stored.split('$')
  if (prefix !== PREFIX || !saltRaw || !keyRaw) return false
  const cost = { N: Number(n), r: Number(r), p: Number(p) }
  const valid =
    Number.isInteger(cost.N) &&
    cost.N > 1 &&
    cost.N <= MAX_N &&
    (cost.N & (cost.N - 1)) === 0 &&
    Number.isInteger(cost.r) &&
    cost.r > 0 &&
    cost.r <= MAX_R &&
    Number.isInteger(cost.p) &&
    cost.p > 0 &&
    cost.p <= MAX_P
  if (!valid) return false

  const expected = Buffer.from(keyRaw, 'base64url')
  if (expected.length !== KEY_LENGTH) return false
  try {
    const actual = await derive(password, Buffer.from(saltRaw, 'base64url'), cost)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
