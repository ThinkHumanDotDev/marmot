/**
 * SLA targets on status page components and groups (#274), computed from the same sources as the
 * page's own uptime (#112, `src/server/status-pages/uptime-history.ts`):
 *
 * - a monitor component under `duration` or `checks`: its monitor's figures (`loadMonitorFigures`),
 *   and the preserved daily snapshots (`status-page-uptime-history`) for the days whose statistics
 *   retention has pruned (weighted by the share of the day that counts);
 * - a static component, or any component under `manual`: the incident impacts of the page (a
 *   major outage counts as down, a partial outage as half down), over the counted time since the
 *   page was created; maintenance windows of the page covering the component are its maintenance;
 * - a group: its visible components taken together, as the average of their figures (time
 *   figures divided by the number of components, check counts summed), so the uptime is the mean
 *   availability of the group and the budget is that of one component.
 *
 * The incidents listed for a target are the monitor incidents of a monitor component measured by
 * its checks, and otherwise the page's incidents that gave the component an impact (or named no
 * component at all).
 */
import type { Payload } from 'payload'

import {
  clipIntervals,
  emptySlaFigures,
  intervalsSeconds,
  overlapMs,
  type SlaCalculation,
  type SlaFigures,
  type SlaPeriod,
  type TimeInterval,
} from '@/lib/sla'
import {
  componentImpactSpans,
  DAY_SECONDS,
  impactWithin,
  utcDayStart,
  type BeatStatus,
} from '@/lib/uptime-history'
import type { SlaTarget, StatusPage } from '@/payload-types'
import { relationId } from '@/server/maintenance/serialize'
import { pageComponents } from '@/server/status-pages/events'
import {
  loadSnapshots,
  windowIncidents,
  windowMaintenance,
  type WindowIncident,
} from '@/server/status-pages/uptime-history'

import { loadMonitorFigures, loadPeriodIncidents, type PeriodIncident } from './compute'

type Id = string | number

const DAY_MS = DAY_SECONDS * 1000

export interface SubjectComponent {
  /** Row id. */
  id: string
  name: string
  type: 'monitor' | 'static'
  /** Monitor id as the adapter stores it (monitor components). */
  monitorId: Id | null
  lastStatus: BeatStatus | null
}

export interface PageSubject {
  page: StatusPage
  /** `Page › Component` or `Page › Group`. */
  name: string
  /** One component, or the visible components of a group in page order. */
  components: SubjectComponent[]
}

/**
 * The status page subjects of component and group targets, keyed by target id. Targets whose page,
 * component or group is gone are left out.
 */
export async function resolvePageSubjects(
  payload: Payload,
  targets: readonly Pick<SlaTarget, 'id' | 'subject' | 'statusPage' | 'component'>[],
): Promise<Map<string, PageSubject>> {
  const out = new Map<string, PageSubject>()
  const wanted = targets.filter((t) => t.subject === 'component' || t.subject === 'group')
  const pageIds = [
    ...new Set(wanted.map((t) => relationId(t.statusPage)).filter((id) => id !== null)),
  ] as Id[]
  if (pageIds.length === 0) return out
  const { docs } = await payload.find({
    collection: 'status-pages',
    where: { id: { in: pageIds } },
    depth: 0,
    limit: pageIds.length,
    pagination: false,
    overrideAccess: true,
  })
  const pages = new Map((docs as StatusPage[]).map((page) => [String(page.id), page]))

  const componentsOf = new Map<string, Map<string, SubjectComponent>>()
  for (const page of pages.values()) {
    const visible = await pageComponents(payload, page)
    const monitorIds = visible.flatMap((c) => (c.monitorId ? [c.monitorId] : []))
    const { docs: monitors } =
      monitorIds.length === 0
        ? { docs: [] }
        : await payload.find({
            collection: 'monitors',
            where: { id: { in: monitorIds } },
            depth: 0,
            limit: monitorIds.length,
            pagination: false,
            overrideAccess: true,
            select: { status: true },
          })
    // Ids as the adapter stores them (numbers on Postgres), for the statistics queries.
    const byId = new Map(monitors.map((m) => [String(m.id), m]))
    componentsOf.set(
      String(page.id),
      new Map(
        visible.map((c) => {
          const monitor = c.monitorId ? byId.get(c.monitorId) : undefined
          return [
            c.id,
            {
              id: c.id,
              name: c.name,
              type: c.type,
              monitorId: monitor?.id ?? c.monitorId,
              lastStatus: (monitor?.status?.lastStatus as BeatStatus | null | undefined) ?? null,
            },
          ]
        }),
      ),
    )
  }

  for (const target of wanted) {
    const page = pages.get(String(relationId(target.statusPage)))
    const visible = page ? componentsOf.get(String(page.id)) : undefined
    if (!page || !visible || !target.component) continue
    if (target.subject === 'component') {
      const component = visible.get(target.component)
      if (!component) continue
      out.set(String(target.id), {
        page,
        name: `${page.title} › ${component.name}`,
        components: [component],
      })
      continue
    }
    const group = (page.groups ?? []).find((g) => g.id === target.component)
    if (!group) continue
    out.set(String(target.id), {
      page,
      name: `${page.title} › ${group.name}`,
      components: (group.monitors ?? []).flatMap((row) =>
        row.id && visible.has(row.id) ? [visible.get(row.id)!] : [],
      ),
    })
  }
  return out
}

/** Union of possibly overlapping intervals, sorted. */
function union(intervals: readonly TimeInterval[]): TimeInterval[] {
  const sorted = [...intervals].sort((a, b) => a.from - b.from)
  const out: TimeInterval[] = []
  for (const interval of sorted) {
    const last = out[out.length - 1]
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to)
    else out.push({ ...interval })
  }
  return out
}

const pageIncident = (incident: WindowIncident, pageId: string, to: number): PeriodIncident => ({
  source: 'statusPage',
  statusPageId: pageId,
  id: incident.id,
  cause: incident.title,
  status: incident.active ? 'open' : 'resolved',
  startedAt: new Date(incident.start).toISOString(),
  resolvedAt: incident.active || incident.end >= to ? null : new Date(incident.end).toISOString(),
})

/**
 * Figures and incidents of a component or group subject over the counted `intervals` of `period`
 * under `mode` (static components always use `manual`).
 */
export async function loadSubjectFigures(
  payload: Payload,
  subject: PageSubject,
  mode: SlaCalculation,
  period: Pick<SlaPeriod, 'from' | 'to'>,
  intervals: readonly TimeInterval[],
  now: Date,
): Promise<{ figures: SlaFigures; incidents: PeriodIncident[] }> {
  const total = emptySlaFigures()
  const counted = clipIntervals(intervals, Number.NEGATIVE_INFINITY, now.getTime())
  if (counted.length === 0 || subject.components.length === 0) {
    return { figures: total, incidents: [] }
  }
  const { page } = subject
  const pageId = String(page.id)
  const from = counted[0].from
  const to = counted[counted.length - 1].to
  const effective = (c: SubjectComponent): SlaCalculation => (c.type === 'static' ? 'manual' : mode)
  const anyManual = subject.components.some((c) => effective(c) === 'manual')
  const byChecks = subject.components.filter((c) => effective(c) !== 'manual')

  const [incidents, maintenance, snapshots] = await Promise.all([
    windowIncidents(payload, page.id, Math.min(from, period.from), Math.max(to, period.to)),
    anyManual ? windowMaintenance(payload, page.id, from, to) : Promise.resolve([]),
    byChecks.length > 0
      ? loadSnapshots(
          payload,
          page.id,
          byChecks.map((c) => c.id),
          utcDayStart(from),
          utcDayStart(to - 1),
        )
      : Promise.resolve(new Map()),
  ])
  const created = Date.parse(page.createdAt)
  const listed = new Map<string, PeriodIncident>()

  for (const component of subject.components) {
    const figures =
      effective(component) === 'manual'
        ? manualFigures(component, counted, Number.isFinite(created) ? created : from)
        : await checkedFigures(component)
    total.up += figures.up
    total.down += figures.down
    total.maintenanceChecks += figures.maintenanceChecks
    total.downSeconds += figures.downSeconds
    total.knownSeconds += figures.knownSeconds
    total.maintenanceSeconds += figures.maintenanceSeconds
    total.elapsedSeconds += figures.elapsedSeconds

    const own =
      effective(component) === 'manual' || component.monitorId === null
        ? incidents
            .filter(
              (incident) =>
                incident.end > period.from &&
                incident.start < period.to &&
                (incident.named.size === 0 ||
                  componentImpactSpans(incident.updates, component.id).length > 0),
            )
            .map((incident) => pageIncident(incident, pageId, now.getTime()))
        : await loadPeriodIncidents(payload, component.monitorId, period)
    for (const incident of own) listed.set(`${incident.source}:${incident.id}`, incident)
  }

  // A group counts as one component: the mean of its components' times.
  const n = subject.components.length
  if (n > 1) {
    total.downSeconds /= n
    total.knownSeconds /= n
    total.maintenanceSeconds /= n
    total.elapsedSeconds /= n
  }
  return {
    figures: total,
    incidents: [...listed.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
  }

  function manualFigures(
    component: SubjectComponent,
    within: readonly TimeInterval[],
    since: number,
  ): SlaFigures {
    const parts = clipIntervals(within, since, Number.POSITIVE_INFINITY)
    const spans = incidents.flatMap((incident) =>
      componentImpactSpans(incident.updates, component.id),
    )
    const covering = union(
      maintenance
        .filter(
          (m) =>
            component.type === 'static' ||
            (component.monitorId !== null && m.monitors.has(String(component.monitorId))),
        )
        .map((m) => ({ from: m.start, to: m.end })),
    )
    const seconds = intervalsSeconds(parts)
    let impactSeconds = 0
    let maintenanceMs = 0
    for (const part of parts) {
      impactSeconds += impactWithin(spans, part.from, part.to).impactSeconds
      maintenanceMs += overlapMs(covering, part.from, part.to)
    }
    return {
      ...emptySlaFigures(),
      downSeconds: impactSeconds,
      knownSeconds: seconds,
      maintenanceSeconds: maintenanceMs / 1000,
      elapsedSeconds: seconds,
    }
  }

  async function checkedFigures(component: SubjectComponent): Promise<SlaFigures> {
    const { figures, days } = await loadMonitorFigures(
      payload,
      { id: component.monitorId as Id, lastStatus: component.lastStatus },
      counted,
      now,
    )
    // Days pruned by retention: the preserved snapshot, weighted by the share that counts.
    for (let day = utcDayStart(from); day * 1000 < to; day += DAY_SECONDS) {
      if (days.has(day)) continue
      const row = snapshots.get(`${component.id}:${day}`)
      if (!row) continue
      const dayFrom = day * 1000
      const share = overlapMs(counted, dayFrom, Math.min(dayFrom + DAY_MS, now.getTime())) / DAY_MS
      if (share <= 0) continue
      figures.up += (row.up ?? 0) * share
      figures.down += (row.down ?? 0) * share
      figures.maintenanceChecks += (row.maintenance ?? 0) * share
      figures.downSeconds += (row.downSeconds ?? 0) * share
      figures.knownSeconds += (row.knownSeconds ?? 0) * share
      figures.elapsedSeconds += share * DAY_SECONDS
    }
    return figures
  }
}
