/**
 * Client calls and row shapes for the org-scoped resources (tags, proxies, Docker hosts, templates).
 * Payload REST is used directly: `orgScoped` access already expresses who may read and write them.
 */
import { api } from '@/lib/api'
import type { DockerConnectionType, ProxyProtocol } from '@/lib/monitor-resources'
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

function collectionApi<Row>(slug: string, toRow: (doc: Doc) => Row) {
  const query = { depth: 0 }
  return {
    create: async (orgId: Id, data: Record<string, unknown>) =>
      toRow(
        (await api.post<{ doc: Doc }>(`/api/${slug}`, { ...data, organization: orgId }, { query }))
          .doc,
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

export const proxyLabel = (proxy: Pick<ProxyRow, 'protocol' | 'host' | 'port'>) =>
  `${proxy.protocol}://${proxy.host}:${proxy.port}`
