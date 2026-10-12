/**
 * Client calls and row shapes for the org-scoped resources (tags, proxies, Docker hosts, templates).
 * Payload REST is used directly: `orgScoped` access already expresses who may read and write them.
 */
import { api } from '@/lib/api'
import type { DockerConnectionType, ProxyProtocol } from '@/lib/monitor-resources'
import type { SshTunnelAuthMethod } from '@/lib/ssh-tunnels'
import { toTemplateRow } from '@/lib/templates'

type Id = string | number

export interface TagRow {
  id: string
  name: string
  color: string
}

export interface ProxyRow {
  id: string
  protocol: ProxyProtocol
  host: string
  port: number
  auth: boolean
  username: string | null
  /** Absent for users who may not edit proxies (field-level access). */
  password?: string | null
  active: boolean
  default: boolean
}

export interface DockerHostRow {
  id: string
  name: string
  connectionType: DockerConnectionType
  socketPath: string | null
  url: string | null
}

/** An SSH tunnel as the settings list it: credentials are never readable, only whether they are set. */
export interface SshTunnelRow {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: SshTunnelAuthMethod
  knownHostFingerprint: string
  hasPassword: boolean
  hasPrivateKey: boolean
  hasPassphrase: boolean
}

type Doc = { id: Id } & Record<string, unknown>

/** Payload interfaces have no index signature; read any document as a field bag. */
const fields = <T>(input: object, map: (doc: Doc) => T): T => map(input as Doc)

export const toTagRow = (input: object): TagRow =>
  fields(input, (doc) => ({
    id: String(doc.id),
    name: String(doc.name ?? ''),
    color: String(doc.color ?? '#4B5563'),
  }))

export const toProxyRow = (input: object): ProxyRow =>
  fields(input, (doc) => ({
    id: String(doc.id),
    protocol: (doc.protocol as ProxyProtocol) ?? 'https',
    host: String(doc.host ?? ''),
    port: Number(doc.port ?? 0),
    auth: Boolean(doc.auth),
    username: (doc.username as string | null | undefined) ?? null,
    ...(doc.password !== undefined ? { password: (doc.password as string | null) ?? null } : {}),
    active: doc.active !== false,
    default: Boolean(doc.default),
  }))

export const toDockerHostRow = (input: object): DockerHostRow =>
  fields(input, (doc) => ({
    id: String(doc.id),
    name: String(doc.name ?? ''),
    connectionType: (doc.connectionType as DockerConnectionType) ?? 'socket',
    socketPath: (doc.socketPath as string | null | undefined) ?? null,
    url: (doc.url as string | null | undefined) ?? null,
  }))

export const toSshTunnelRow = (input: object): SshTunnelRow =>
  fields(input, (doc) => ({
    id: String(doc.id),
    name: String(doc.name ?? ''),
    host: String(doc.host ?? ''),
    port: Number(doc.port ?? 22),
    username: String(doc.username ?? ''),
    authMethod: (doc.authMethod as SshTunnelAuthMethod) ?? 'password',
    knownHostFingerprint: String(doc.knownHostFingerprint ?? ''),
    hasPassword: Boolean(doc.hasPassword),
    hasPrivateKey: Boolean(doc.hasPrivateKey),
    hasPassphrase: Boolean(doc.hasPassphrase),
  }))

/**
 * Relationship value for an organization id the page passed as a string: Postgres ids are numbers
 * and Payload refuses `"1"` for them; MongoDB ids (24 hex characters) stay strings.
 */
const orgRef = (id: Id): Id => (typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : id)

function collectionApi<Row>(slug: string, toRow: (doc: Doc) => Row) {
  const query = { depth: 0 }
  return {
    create: async (orgId: Id, data: Record<string, unknown>) =>
      toRow(
        (
          await api.post<{ doc: Doc }>(
            `/api/${slug}`,
            { ...data, organization: orgRef(orgId) },
            { query },
          )
        ).doc,
      ),
    update: async (id: Id, data: Record<string, unknown>) =>
      toRow((await api.patch<{ doc: Doc }>(`/api/${slug}/${id}`, data, { query })).doc),
    remove: (id: Id) => api.delete<unknown>(`/api/${slug}/${id}`),
  }
}

export const tagsApi = collectionApi('tags', toTagRow)
export const templatesApi = collectionApi('templates', toTemplateRow)
export const proxiesApi = collectionApi('proxies', toProxyRow)
export const dockerHostsApi = {
  ...collectionApi('docker-hosts', toDockerHostRow),
  test: (
    orgId: Id,
    body:
      | { dockerHostId: Id }
      | { connectionType: DockerConnectionType; socketPath?: string | null; url?: string | null },
  ) => api.post<{ ok: true; containers: number }>(`/api/orgs/${orgId}/docker-hosts/test`, body),
}

/** Connection fields of the SSH tunnel test (`POST /api/orgs/:orgId/ssh-tunnels/test`). */
export type SshTunnelTestBody = {
  sshTunnelId?: Id
  fetchFingerprint?: boolean
  host?: string
  port?: number
  username?: string
  authMethod?: SshTunnelAuthMethod
  password?: string
  privateKey?: string
  passphrase?: string
  knownHostFingerprint?: string
}

export const sshTunnelsApi = {
  ...collectionApi('ssh-tunnels', toSshTunnelRow),
  test: (orgId: Id, body: SshTunnelTestBody) =>
    api.post<{ ok: true; fingerprint: string; ms?: number }>(
      `/api/orgs/${orgId}/ssh-tunnels/test`,
      body,
    ),
}

export const proxyLabel = (proxy: Pick<ProxyRow, 'protocol' | 'host' | 'port'>) =>
  `${proxy.protocol}://${proxy.host}:${proxy.port}`
