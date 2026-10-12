/**
 * Encryption at rest for SSH tunnel credentials (password, private key, passphrase): AES-256-GCM
 * with a key derived from `PAYLOAD_SECRET` for the purpose `marmot:ssh-tunnel-secret`, the same
 * scheme as TOTP and single sign-on client secrets (`src/auth/two-factor/crypto.ts`).
 */
import { decryptSecret, encryptSecret } from '@/auth/two-factor/crypto'
import { env } from '@/env'

const PURPOSE = 'marmot:ssh-tunnel-secret'

/** The credential fields of `ssh-tunnels`, sealed at rest and never readable through the API. */
export const SSH_TUNNEL_SECRET_FIELDS = ['password', 'privateKey', 'passphrase'] as const
export type SshTunnelSecretField = (typeof SSH_TUNNEL_SECRET_FIELDS)[number]

/** Seal a plaintext credential. */
export const sealTunnelSecret = (plain: string): string =>
  encryptSecret(plain, env.PAYLOAD_SECRET, PURPOSE)

/** The plaintext of a sealed credential, or `null` when unset or sealed with another key. */
export const openTunnelSecret = (sealed: string | null | undefined): string | null =>
  decryptSecret(sealed, env.PAYLOAD_SECRET, PURPOSE)

/** Whether `value` is a credential sealed by `sealTunnelSecret` with the current key. */
export const isSealedTunnelSecret = (value: string): boolean => openTunnelSecret(value) !== null
