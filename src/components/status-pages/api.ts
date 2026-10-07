/**
 * Client for the status-page builder routes (`/api/orgs/:orgId/status-pages/**`). All calls run
 * with the user's session; the server enforces organization scoping and role permissions.
 */
import { api } from '@/lib/api'
import type { Incident, Monitor, StatusPage } from '@/payload-types'

export type OrgId = string | number

export type StatusPageGroup = NonNullable<StatusPage['groups']>[number]
export type StatusPageGroupMonitor = NonNullable<StatusPageGroup['monitors']>[number]
export type StatusPageDomain = NonNullable<StatusPage['domains']>[number]

/** The subset of a monitor the builder needs for pickers and labels. */
export type MonitorOption = Pick<Monitor, 'id' | 'name' | 'type' | 'active'> & {
  publicName?: string | null
  url?: string | null
  hostname?: string | null
  lastStatus?: 'up' | 'down' | 'pending' | 'maintenance' | null
}

export type StatusPagePatch = Partial<
  Pick<
    StatusPage,
    | 'title'
    | 'slug'
    | 'description'
    | 'logo'
    | 'homepageUrl'
    | 'contactUrl'
    | 'theme'
    | 'themePreset'
    | 'themeOverrides'
    | 'bannerText'
    | 'language'
    | 'published'
    | 'searchEngineIndex'
    | 'showTags'
    | 'showCertificateExpiry'
    | 'showPoweredBy'
    | 'showValues'
    | 'autoRefreshInterval'
    | 'footerText'
    | 'customCSS'
    | 'googleAnalyticsId'
    | 'domains'
    | 'groups'
    | 'access'
  >
> & {
  /** New page password (write-only; never returned). */
  password?: string
}

export type IncidentPatch = Partial<
  Pick<Incident, 'title' | 'content' | 'style' | 'pinned' | 'active' | 'affectedComponents'>
>

export type StatusPageAssetKind = 'logo' | 'logoDark' | 'favicon'

const ASSET_PATHS: Record<StatusPageAssetKind, string> = {
  logo: 'logo',
  logoDark: 'logo-dark',
  favicon: 'favicon',
}

const base = (orgId: OrgId) => `/api/orgs/${encodeURIComponent(String(orgId))}/status-pages`

export const statusPagesApi = {
  list: (orgId: OrgId) => api.get<{ docs: StatusPage[] }>(base(orgId)),
  create: (orgId: OrgId, data: { title: string; slug: string; description?: string }) =>
    api.post<{ doc: StatusPage }>(base(orgId), data),
  get: (orgId: OrgId, id: OrgId) => api.get<{ doc: StatusPage }>(`${base(orgId)}/${id}`),
  update: (orgId: OrgId, id: OrgId, data: StatusPagePatch) =>
    api.patch<{ doc: StatusPage }>(`${base(orgId)}/${id}`, data as Record<string, unknown>),
  remove: (orgId: OrgId, id: OrgId) => api.delete<{ ok: true }>(`${base(orgId)}/${id}`),

  /** Uploads the light logo, dark logo or favicon (multipart `file`). */
  uploadAsset: async (orgId: OrgId, id: OrgId, kind: StatusPageAssetKind, file: File) => {
    const body = new FormData()
    body.append('file', file)
    const res = await fetch(`${base(orgId)}/${id}/${ASSET_PATHS[kind]}`, {
      method: 'POST',
      body,
      credentials: 'include',
    })
    const json = (await res.json()) as { doc?: StatusPage; error?: string }
    if (!res.ok || !json.doc) throw new Error(json.error ?? '')
    return json.doc
  },
  removeAsset: (orgId: OrgId, id: OrgId, kind: StatusPageAssetKind) =>
    api.delete<{ doc: StatusPage }>(`${base(orgId)}/${id}/${ASSET_PATHS[kind]}`),

  incidents: {
    list: (orgId: OrgId, id: OrgId) =>
      api.get<{ docs: Incident[] }>(`${base(orgId)}/${id}/incidents`),
    create: (orgId: OrgId, id: OrgId, data: IncidentPatch & { title: string }) =>
      api.post<{ doc: Incident }>(
        `${base(orgId)}/${id}/incidents`,
        data as Record<string, unknown>,
      ),
    update: (orgId: OrgId, id: OrgId, incidentId: OrgId, data: IncidentPatch) =>
      api.patch<{ doc: Incident }>(
        `${base(orgId)}/${id}/incidents/${incidentId}`,
        data as Record<string, unknown>,
      ),
    remove: (orgId: OrgId, id: OrgId, incidentId: OrgId) =>
      api.delete<{ ok: true }>(`${base(orgId)}/${id}/incidents/${incidentId}`),
  },
}

/** Public URL of a page, as shown in the builder. */
export const publicStatusPagePath = (slug: string) => `/status/${encodeURIComponent(slug)}`

/** "My Status Page" → "my-status-page". */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

export const relationId = (value: unknown): string => {
  if (value && typeof value === 'object' && 'id' in value) {
    return String((value as { id: unknown }).id)
  }
  return String(value)
}
