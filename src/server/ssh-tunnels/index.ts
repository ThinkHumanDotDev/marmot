/**
 * SSH tunnels (#160): opening a monitor's tunnel for a check and testing a tunnel's connection.
 * See `connection.ts` for the pool and the forwarding, `docs/Monitors.md` → SSH tunnels.
 */
import type { Payload } from 'payload'

import { DEFAULT_SSH_PORT, type SshTunnelAuthMethod } from '@/lib/ssh-tunnels'
import type { SshTunnel } from '@/payload-types'

import { acquireSshConnection, connectSsh, TunnelSession, type SshTunnelConfig } from './connection'
import { openTunnelSecret } from './secrets'

export {
  closeSshConnections,
  fetchHostFingerprint,
  hostKeyFingerprint,
  privateKeyProblem,
  SshTunnelError,
  TunnelSession,
  type SshTunnelConfig,
} from './connection'

/** The plaintext connection settings of a stored tunnel (credentials opened). */
export function tunnelConfigFromDoc(doc: SshTunnel): SshTunnelConfig {
  return {
    id: doc.id,
    name: doc.name,
    host: doc.host,
    port: doc.port || DEFAULT_SSH_PORT,
    username: doc.username,
    authMethod: (doc.authMethod ?? 'password') as SshTunnelAuthMethod,
    password: openTunnelSecret(doc.password),
    privateKey: openTunnelSecret(doc.privateKey),
    passphrase: openTunnelSecret(doc.passphrase),
    knownHostFingerprint: doc.knownHostFingerprint,
  }
}

/** A check's tunnel could not be opened: the monitor is DOWN with this message. */
export class SshTunnelUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshTunnelUnreachableError'
  }
}

export const isSshTunnelUnreachable = (err: unknown): err is SshTunnelUnreachableError =>
  err instanceof Error && err.name === 'SshTunnelUnreachableError'

/**
 * Open the tunnel `ref` (an id, or the document) for one check: the pooled SSH connection plus a
 * session the check forwards its connections through. Throws `SshTunnelUnreachableError`
 * ("SSH tunnel <name> unreachable: <reason>") when the bastion cannot be reached, so a bastion
 * outage is reported as such and not as a failure of the target.
 */
export async function openCheckTunnel(
  payload: Payload,
  ref: string | number | SshTunnel,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<TunnelSession> {
  const doc =
    typeof ref === 'object'
      ? ref
      : ((await payload
          .findByID({ collection: 'ssh-tunnels', id: ref, depth: 0, overrideAccess: true })
          .catch(() => null)) as SshTunnel | null)
  if (!doc) throw new SshTunnelUnreachableError('SSH tunnel unreachable: the tunnel was deleted')
  try {
    const { client, release } = await acquireSshConnection(tunnelConfigFromDoc(doc), options)
    return new TunnelSession(doc.name, client, release)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new SshTunnelUnreachableError(`SSH tunnel ${doc.name} unreachable: ${reason}`)
  }
}

export interface SshTunnelTestResult {
  /** The host key fingerprint the bastion presented (and that matched). */
  fingerprint: string
  /** Time to connect and authenticate, in ms. */
  ms: number
}

/**
 * Connect to the bastion once (not pooled), verify the host key, authenticate and disconnect.
 * Throws `SshTunnelError`; on a host key mismatch its `fingerprint` is what the server presented.
 */
export async function testSshTunnel(
  config: SshTunnelConfig,
  timeoutMs = 15_000,
): Promise<SshTunnelTestResult> {
  const startedAt = Date.now()
  const signal = AbortSignal.timeout(timeoutMs)
  const { client, fingerprint } = await connectSsh(config, { timeoutMs, signal })
  client.end()
  return { fingerprint, ms: Date.now() - startedAt }
}
