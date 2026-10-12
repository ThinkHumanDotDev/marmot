import {
  DEFAULT_SSH_PORT,
  normalizeHostFingerprint,
  SSH_TUNNEL_AUTH_METHODS,
} from '@/lib/ssh-tunnels'
import type { SshTunnel } from '@/payload-types'
import { demoRefusal } from '@/server/demo/config'
import { jsonError, parseDocId, readJson, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { literalTargetDenial } from '@/server/security/outbound-guard'
import {
  fetchHostFingerprint,
  SshTunnelError,
  testSshTunnel,
  tunnelConfigFromDoc,
  type SshTunnelConfig,
} from '@/server/ssh-tunnels'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

type TestBody = {
  sshTunnelId?: string | number | null
  fetchFingerprint?: boolean
  host?: string
  port?: number | string
  username?: string
  authMethod?: string
  password?: string
  privateKey?: string
  passphrase?: string
  knownHostFingerprint?: string
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/**
 * POST /api/orgs/:orgId/ssh-tunnels/test — connect to an SSH bastion, verify its host key and
 * authenticate ("Test connection"; `ssh-tunnel:update`, the users who may save a tunnel).
 *
 * Body: `{ sshTunnelId }` tests a saved tunnel; connection fields (`host`, `port`, `username`,
 * `authMethod`, `password` | `privateKey` [+ `passphrase`], `knownHostFingerprint`) test unsaved
 * values, falling back to the saved tunnel's (credentials included) when `sshTunnelId` is given
 * too. `{ host, port, fetchFingerprint: true }` only reads the host key the bastion presents.
 *
 * Responds `{ ok: true, fingerprint, ms }` or 400 `{ ok: false, error, fingerprint? }`, where
 * `fingerprint` is the presented host key (on a mismatch, so it can be compared). Credentials are
 * never part of a response.
 */
export async function POST(request: Request, { params }: RouteContext) {
  // Demo mode (#159): the server would connect to a user-supplied host.
  const refused = demoRefusal(request, 'sshTunnels')
  if (refused) return refused
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'ssh-tunnel:update')
  if (ctx instanceof Response) return ctx

  const body = await readJson<TestBody>(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'), { ok: false })

  let saved: SshTunnel | null = null
  if (body.sshTunnelId !== undefined && body.sshTunnelId !== null && body.sshTunnelId !== '') {
    try {
      const id = parseDocId(ctx.payload, String(body.sshTunnelId))
      // Access check as the caller, then the stored (sealed) credentials as the server.
      const visible = (await ctx.payload.findByID({
        collection: 'ssh-tunnels',
        id,
        depth: 0,
        user: ctx.user,
        overrideAccess: false,
      })) as SshTunnel
      const org =
        typeof visible.organization === 'object' ? visible.organization.id : visible.organization
      if (String(org) !== String(ctx.orgId)) throw new Error('wrong organization')
      saved = (await ctx.payload.findByID({
        collection: 'ssh-tunnels',
        id,
        depth: 0,
        overrideAccess: true,
      })) as SshTunnel
    } catch {
      return jsonError(404, errorText(request, 'sshTunnelNotFound'), { ok: false })
    }
  }

  const base: Partial<SshTunnelConfig> = saved ? tunnelConfigFromDoc(saved) : {}
  const host = text(body.host) ?? base.host
  const port = Number(body.port) || base.port || DEFAULT_SSH_PORT
  if (!host || port < 1 || port > 65535) {
    return jsonError(400, errorText(request, 'sshTunnelTestTargetRequired'), { ok: false })
  }
  const denial = literalTargetDenial(host)
  if (denial) return Response.json({ ok: false, error: denial }, { status: 400 })

  if (body.fetchFingerprint === true) {
    try {
      return Response.json({ ok: true, fingerprint: await fetchHostFingerprint(host, port) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ ok: false, error: message }, { status: 400 })
    }
  }

  const authMethod = (SSH_TUNNEL_AUTH_METHODS as readonly string[]).includes(body.authMethod ?? '')
    ? (body.authMethod as SshTunnelConfig['authMethod'])
    : (base.authMethod ?? 'password')
  // Saved credentials only apply while the method is unchanged.
  const keep = base.authMethod === authMethod
  const config: SshTunnelConfig = {
    id: null,
    name: saved?.name ?? host,
    host,
    port,
    username: text(body.username) ?? base.username ?? '',
    authMethod,
    password: (body.password || null) ?? (keep ? base.password : null) ?? null,
    privateKey: (body.privateKey || null) ?? (keep ? base.privateKey : null) ?? null,
    passphrase: (body.passphrase || null) ?? (keep ? base.passphrase : null) ?? null,
    knownHostFingerprint:
      normalizeHostFingerprint(body.knownHostFingerprint) ?? base.knownHostFingerprint ?? '',
  }
  if (!config.username || !normalizeHostFingerprint(config.knownHostFingerprint)) {
    return jsonError(400, errorText(request, 'sshTunnelTestTargetRequired'), { ok: false })
  }

  try {
    const result = await testSshTunnel(config)
    return Response.json({ ok: true, fingerprint: result.fingerprint, ms: result.ms })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const fingerprint = error instanceof SshTunnelError ? error.fingerprint : null
    return Response.json(
      { ok: false, error: message, ...(fingerprint ? { fingerprint } : {}) },
      { status: 400 },
    )
  }
}
