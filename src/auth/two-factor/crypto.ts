import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * Encryption at rest for TOTP secrets and hashing for backup codes. Both keys are derived from
 * `PAYLOAD_SECRET` (SHA-256 of a purpose string + the secret), so no extra configuration is
 * needed and rotating the Payload secret invalidates every stored 2FA secret (users re-enrol).
 */

const ENCRYPTION_PURPOSE = 'marmot:2fa-secret'
const BACKUP_PURPOSE = 'marmot:2fa-backup-code'
const VERSION = 'v1'

/** 256-bit key scoped to `purpose`. */
export function deriveKey(secret: string, purpose: string): Buffer {
  return createHash('sha256').update(`${purpose}:${secret}`).digest()
}

/** `v1.<iv>.<ciphertext>.<tag>` (base64url), AES-256-GCM. */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, ENCRYPTION_PURPOSE), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

/** Inverse of `encryptSecret`; `null` for malformed, tampered or foreign-key input. */
export function decryptSecret(sealed: string | null | undefined, secret: string): string | null {
  if (!sealed) return null
  const [version, iv, ciphertext, tag] = sealed.split('.')
  if (version !== VERSION || !iv || !ciphertext || !tag) return null
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(secret, ENCRYPTION_PURPOSE),
      Buffer.from(iv, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ])
    return plain.toString('utf8')
  } catch {
    return null
  }
}

/** Keyed digest of a (normalised) backup code; what is stored instead of the code. */
export function hashBackupCode(code: string, secret: string): string {
  return createHmac('sha256', deriveKey(secret, BACKUP_PURPOSE)).update(code).digest('hex')
}
