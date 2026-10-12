/**
 * Audience-specific status pages (#151): one page, several audiences, each seeing only its
 * components and the incidents and maintenance that affect them.
 *
 * The filtering is anchored on the page object itself, so every public surface (page, history,
 * permalinks, feeds, Markdown, `llms.txt`, Statuspage JSON, badges, subscriptions) gets it from the
 * same place:
 *
 * 1. `findPublishedStatusPage` returns an `audience` page **locked**: `groups` is empty and the real
 *    groups are kept in a non-enumerable slot only this module reads. Code that forgets to scope the
 *    page therefore shows no component, never every component.
 * 2. After the access check, `scopePageForVisitor(page, decision)` returns a copy whose `groups` hold
 *    only the rows of the visitor's audiences (empty groups dropped). Everything that iterates the
 *    page's groups is scoped from then on.
 * 3. Incidents and maintenance are read through loaders that take the page and keep only what
 *    `isIncidentVisibleOn` / `isMaintenanceVisibleOn` admit: on an `audience` page, those naming
 *    a component left in the scoped page's groups, plus page-wide ones (no component).
 *
 * The scope comes only from the server side: the signed access cookie names a viewer row, whose
 * address is matched against the page's audiences on every request; nothing in the URL or the
 * query string can widen it.
 */
import type { Payload } from 'payload'

import {
  audienceComponents,
  incidentComponentIds,
  isAudienceMember,
  isVisibleToComponents,
  type IncidentComponentRefs,
} from '@/lib/status-page-audiences'
import { MAX_AUDIENCES_PER_PAGE } from '@/lib/status-page-audiences'

import type { StatusPage, StatusPageAudience } from '@/payload-types'

/** The visitor's audiences, as granted by the access check. */
export interface AudienceGrant {
  /** Audience ids (strings on every adapter). */
  audiences: string[]
  /** Union of their component ids. */
  components: string[]
}

type Groups = StatusPage['groups']

const RAW_GROUPS = Symbol('marmot.statusPage.rawGroups')

type LockablePage = { groups?: Groups; [RAW_GROUPS]?: Groups }

export const isAudiencePage = (page: Pick<StatusPage, 'access'>): boolean =>
  page.access === 'audience'

/**
 * Hides the groups of an `audience` page until `scopePageForVisitor` (or `scopePageToAudiences`)
 * picks the visitor's components. Other pages are returned unchanged.
 */
export function lockAudiencePage<T extends Pick<StatusPage, 'access' | 'groups'>>(page: T): T {
  if (!isAudiencePage(page)) return page
  const locked = { ...page, groups: [] as Groups }
  Object.defineProperty(locked, RAW_GROUPS, {
    value: rawGroupsOf(page),
    enumerable: false,
  })
  return locked
}

function rawGroupsOf(page: Pick<StatusPage, 'groups'>): Groups {
  const raw = (page as LockablePage)[RAW_GROUPS]
  return raw !== undefined ? raw : (page.groups ?? [])
}

/** `page` with only the rows whose id is in `components` (groups left empty are dropped). */
export function scopePageToComponents<T extends Pick<StatusPage, 'access' | 'groups'>>(
  page: T,
  components: Iterable<string>,
): T {
  const keep = new Set([...components].map(String))
  const groups = (rawGroupsOf(page) ?? []).flatMap((group) => {
    const rows = (group.monitors ?? []).filter((row) => row.id && keep.has(String(row.id)))
    return rows.length > 0 ? [{ ...group, monitors: rows }] : []
  })
  const scoped = { ...page, groups }
  delete (scoped as LockablePage)[RAW_GROUPS]
  return scoped
}

/**
 * The page as the visitor behind `decision` may see it: unchanged for every mode but `audience`;
 * for `audience` pages only the components of the visitor's audiences (none without a grant).
 */
export function scopePageForVisitor<T extends Pick<StatusPage, 'access' | 'groups'>>(
  page: T,
  decision: { allowed: boolean; audience?: AudienceGrant | null },
): T {
  if (!isAudiencePage(page)) return page
  const components = decision.allowed ? (decision.audience?.components ?? []) : []
  return scopePageToComponents(page, components)
}

/** Component ids left in the (scoped) page's groups. */
export function visibleComponentIds(page: Pick<StatusPage, 'groups'>): Set<string> {
  const ids = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) if (row.id) ids.add(String(row.id))
  }
  return ids
}

/** Monitor ids of the monitor components left in the (scoped) page's groups. */
function visibleMonitorIds(page: Pick<StatusPage, 'groups'>): Set<string> {
  const ids = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      if (row.type === 'static' || row.monitor == null) continue
      const id = typeof row.monitor === 'object' ? row.monitor.id : row.monitor
      ids.add(String(id))
    }
  }
  return ids
}

/** The page fields the visibility rules read. */
export type AudienceScopedPage = Pick<StatusPage, 'id' | 'access' | 'groups'>

/** True when `incident` may be listed on (scoped) `page`. Every incident on other modes. */
export function isIncidentVisibleOn(
  page: Pick<StatusPage, 'access' | 'groups'>,
  incident: IncidentComponentRefs,
): boolean {
  if (!isAudiencePage(page)) return true
  return isVisibleToComponents(incidentComponentIds(incident), visibleComponentIds(page))
}

/** Keeps the incidents visible on `page`. */
export const visibleIncidents = <T extends IncidentComponentRefs>(
  page: Pick<StatusPage, 'access' | 'groups'>,
  incidents: readonly T[],
): T[] =>
  isAudiencePage(page)
    ? incidents.filter((incident) => isIncidentVisibleOn(page, incident))
    : [...incidents]

/**
 * True when a maintenance covering `monitors` may be listed on (scoped) `page`: always on other
 * modes; on `audience` pages when it covers no monitor (page-wide) or one of a visible component.
 */
export function isMaintenanceVisibleOn(
  page: Pick<StatusPage, 'access' | 'groups'>,
  maintenance: { monitors?: readonly unknown[] | null },
): boolean {
  if (!isAudiencePage(page)) return true
  const covered = (maintenance.monitors ?? []).map((m) =>
    String(typeof m === 'object' && m !== null ? (m as { id: unknown }).id : m),
  )
  if (covered.length === 0) return true
  const visible = visibleMonitorIds(page)
  return covered.some((id) => visible.has(id))
}

/**
 * True when a custom metric (#155) may be shown on (scoped) `page`: always on other modes; on
 * `audience` pages a monitor-backed metric only when its monitor is a visible component, a pushed
 * metric (no monitor) like page-wide incidents.
 */
export function isMetricVisibleOn(
  page: Pick<StatusPage, 'access' | 'groups'>,
  metric: { monitor?: unknown },
): boolean {
  if (!isAudiencePage(page)) return true
  const monitor = metric.monitor
  if (monitor == null) return true
  const id = String(typeof monitor === 'object' ? (monitor as { id: unknown }).id : monitor)
  return visibleMonitorIds(page).has(id)
}

// ---------------------------------------------------------------------------------------------
// Audiences of a page

/** Every audience of a page (bounded by `MAX_AUDIENCES_PER_PAGE`), oldest first. */
export async function findPageAudiences(
  payload: Payload,
  pageId: string | number,
): Promise<StatusPageAudience[]> {
  const { docs } = await payload.find({
    collection: 'status-page-audiences',
    where: { statusPage: { equals: pageId } },
    sort: 'createdAt',
    depth: 0,
    limit: MAX_AUDIENCES_PER_PAGE,
    pagination: false,
    overrideAccess: true,
  })
  return docs
}

/** The audiences of `pageId` that list `email` (by address or domain), as a grant; null if none. */
export async function audienceGrantFor(
  payload: Payload,
  pageId: string | number,
  email: string,
): Promise<AudienceGrant | null> {
  const audiences = (await findPageAudiences(payload, pageId)).filter((audience) =>
    isAudienceMember(audience, email),
  )
  if (audiences.length === 0) return null
  return grantOf(audiences)
}

export const grantOf = (audiences: readonly StatusPageAudience[]): AudienceGrant => ({
  audiences: audiences.map((a) => String(a.id)),
  components: [...audienceComponents(audiences)],
})

/**
 * The page restricted to `audienceIds` (admin preview, subscription management): only audiences
 * of this page count; unknown ids are ignored.
 */
export async function scopePageToAudiences<T extends AudienceScopedPage>(
  payload: Payload,
  page: T,
  audienceIds: readonly (string | number)[],
): Promise<T> {
  const wanted = new Set(audienceIds.map(String))
  const audiences = (await findPageAudiences(payload, page.id)).filter((a) =>
    wanted.has(String(a.id)),
  )
  return scopePageToComponents(page, audienceComponents(audiences))
}

/** Component ids per audience id of a page (subscriber fan-out). */
export async function audienceComponentMap(
  payload: Payload,
  pageId: string | number,
): Promise<Map<string, Set<string>>> {
  const audiences = await findPageAudiences(payload, pageId)
  return new Map(audiences.map((a) => [String(a.id), audienceComponents([a])]))
}

/** Union of the components of the audiences in `ids` (null when none of them exists). */
export function componentsOfAudiences(
  map: ReadonlyMap<string, ReadonlySet<string>>,
  ids: readonly unknown[] | null | undefined,
): Set<string> | null {
  let found = false
  const out = new Set<string>()
  for (const raw of ids ?? []) {
    const id = String(typeof raw === 'object' && raw !== null ? (raw as { id: unknown }).id : raw)
    const components = map.get(id)
    if (!components) continue
    found = true
    for (const c of components) out.add(c)
  }
  return found ? out : null
}
