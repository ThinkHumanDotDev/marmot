/**
 * Client-safe constants and helpers for SSH tunnels (#160): the org-scoped `ssh-tunnels` bastions
 * that monitors opening TCP connections can reach their target through. No server-only imports.
 */

export const SSH_TUNNEL_AUTH_METHODS = ['password', 'privateKey'] as const
export type SshTunnelAuthMethod = (typeof SSH_TUNNEL_AUTH_METHODS)[number]

export const DEFAULT_SSH_PORT = 22

/**
 * Monitor types whose connections can go through an SSH tunnel: the ones that open plain TCP
 * connections to one target the worker dials itself (HTTP family, TCP port, SQL databases, Redis,
 * SMTP). UDP, ICMP and multi-host protocols (MongoDB replica sets, Kafka) are not tunnelled.
 */
export const SSH_TUNNEL_MONITOR_TYPES = [
  'http',
  'keyword',
  'json-query',
  'port',
  'postgres',
  'mysql',
  'sqlserver',
  'redis',
  'smtp',
] as const

export const supportsSshTunnel = (type: string | null | undefined): boolean =>
  typeof type === 'string' && (SSH_TUNNEL_MONITOR_TYPES as readonly string[]).includes(type)

/**
 * The OpenSSH SHA-256 host key fingerprint (`SHA256:<43 base64 characters>`, as printed by
 * `ssh-keygen -lf` and by `ssh` on first connect) in canonical form, or `null` when `value` is not
 * one. The `SHA256:` prefix and base64 padding are optional on input.
 */
export function normalizeHostFingerprint(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const bare = value
    .trim()
    .replace(/^sha256:/i, '')
    .replace(/=+$/, '')
  return /^[A-Za-z0-9+/]{43}$/.test(bare) ? `SHA256:${bare}` : null
}
