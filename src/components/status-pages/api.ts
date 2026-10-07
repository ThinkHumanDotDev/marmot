/**
 * Client for the status-page builder routes (`/api/orgs/:orgId/status-pages/**`). All calls run
 * with the user's session; the server enforces organization scoping and role permissions.
 */
import { api } from '@/lib/api'
import type { ComponentImpact, IncidentStatus } from '@/lib/incident-timeline'
import type { Incident, Monitor, StatusPage, StatusPageViewer } from '@/payload-types'

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
    | 'maintenanceVisibilityHours'
    | 'pastIncidentsDays'
    | 'footerText'
    | 'customCSS'
    | 'googleAnalyticsId'
    | 'domains'
    | 'groups'
    | 'access'
    | 'allowedEmailDomains'
    | 'allowedIpRanges'
  >
> & {
  /** New page password (write-only; never returned). */
  password?: string
}

export type IncidentPatch = Partial<
  Pick<Incident, 'title' | 'pinned' | 'active' | 'impact' | 'affectedComponents'>
>

export type IncidentUpdateRow = NonNullable<Incident['updates']>[number]

/**
 * A new timeline entry. `components` are component ids (group row ids); components left out keep
 * their impact. `impact` is for incidents without components.
 */
export interface IncidentUpdateDraft {
  status: IncidentStatus
  message?: string
  components?: { component: string; impact: ComponentImpact }[]
  impact?: ComponentImpact
  postedAt?: string
}

export type IncidentOpenDraft = Omit<IncidentUpdateDraft, 'postedAt'> & {
  title: string
  pinned?: boolean
}

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
    create: (orgId: OrgId, id: OrgId, data: IncidentOpenDraft) =>
      api.post<{ doc: Incident }>(`${base(orgId)}/${id}/incidents`, { ...data }),
    update: (orgId: OrgId, id: OrgId, incidentId: OrgId, data: IncidentPatch) =>
      api.patch<{ doc: Incident }>(
        `${base(orgId)}/${id}/incidents/${incidentId}`,
        data as Record<string, unknown>,
      ),
    remove: (orgId: OrgId, id: OrgId, incidentId: OrgId) =>
      api.delete<{ ok: true }>(`${base(orgId)}/${id}/incidents/${incidentId}`),
    postUpdate: (orgId: OrgId, id: OrgId, incidentId: OrgId, data: IncidentUpdateDraft) =>
      api.post<{ doc: Incident; update: IncidentUpdateRow }>(
        `${base(orgId)}/${id}/incidents/${incidentId}/updates`,
        { ...data },
      ),
    editUpdate: (orgId: OrgId, id: OrgId, incidentId: OrgId, updateId: string, message: string) =>
      api.patch<{ doc: Incident; update: IncidentUpdateRow }>(
        `${base(orgId)}/${id}/incidents/${incidentId}/updates/${encodeURIComponent(updateId)}`,
        { message },
      ),
  },

  viewers: {
    list: (orgId: OrgId, id: OrgId) =>
      api.get<{ docs: StatusPageViewer[] }>(`${base(orgId)}/${id}/viewers`),
    setStatus: (orgId: OrgId, id: OrgId, viewerId: OrgId, status: StatusPageViewer['status']) =>
      api.patch<{ doc: StatusPageViewer }>(`${base(orgId)}/${id}/viewers/${viewerId}`, {
        status,
      }),
    remove: (orgId: OrgId, id: OrgId, viewerId: OrgId) =>
      api.delete<{ ok: true }>(`${base(orgId)}/${id}/viewers/${viewerId}`),
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
