/**
 * Daily uptime of status page components (#112): the bars of the public page, the preserved
 * history (`status-page-uptime-history`) and the monthly history of the editor.
 *
 * Sources, per component and UTC day:
 * - monitor components: `stat-daily` (check counts, degraded and maintenance beats) and the
 *   important heartbeats (status transitions, replayed for the time spent DOWN); once retention has
 *   pruned them, the day's `status-page-uptime-history` snapshot;
 * - every component: the page's incidents (impact spans, for the `manual` mode and the bar colour)
 *   and the maintenance windows announced on the page (tooltips).
 *
 * The maths lives in `src/lib/uptime-history.ts`. Everything here reads with `overrideAccess: true`;
 * callers check access to the page first.
 */
import type { Payload, RequiredDataFromCollectionSlug } from 'payload'

import { incidentTimeline } from '@/lib/incident-timeline'
import { isMaintenanceVisibleOn } from '@/server/status-pages/audiences'
import { childLogger } from '@/lib/logger'
import type { ComponentImpact, ComponentType } from '@/lib/status-page-components'
import {
  DAY_SECONDS,
  componentImpactSpans,
  dayLabel,
  dayState,
  downtimeOf,
  emptyFigures,
  impactWithin,
  isUptimeCalculationMode,
  monthLabel,
  replayStatuses,
  sumFigures,
  uptimeOf,
  utcDayStart,
  DEFAULT_UPTIME_CALCULATION_MODE,
  type BeatStatus,
  type DayFigures,
  type DayState,
  type ImpactSpan,
  type MonthlyUptimeRow,
  type StatusChange,
  type UptimeCalculationMode,
} from '@/lib/uptime-history'
import { relationId } from '@/server/maintenance/serialize'
import type { Incident, Maintenance, MaintenanceOccurrence, StatusPage } from '@/payload-types'

import { publicIdOf } from './public-ids'

const log = childLogger('uptime-history')

/** Most status transitions read per monitor and window (a flapping monitor is capped here). */
export const MAX_TRANSITIONS = 20_000
/** Most incidents considered per page and window. */
export const MAX_WINDOW_INCIDENTS = 1000

/** A component of a page whose days are computed. */
export interface UptimeComponent {
  /** Component id (the group row id). */
  id: string
  type: ComponentType
  /** Monitor id of `monitor` components. */
  monitorId: string | number | null
  /** The monitor's current status (used when no transition is known in the window). */
  lastStatus?: BeatStatus | null
}

export interface DayIncident {
  /** Database id. */
  id: string
  /** Permalink id. */
  publicId: string
  title: string
  /** Worst impact the incident gave this component that day; null for page-wide incidents. */
  impact: ComponentImpact | null
}

export interface DayMaintenance {
  id: string
  publicId: string
  title: string
}

export interface ComponentDay {
  /** Unix seconds of the start of the UTC day. */
  day: number
  /** Something was recorded (checks for monitors, the page existed for static components). */
  hasData: boolean
  /** Where the check figures came from. */
  source: 'live' | 'snapshot' | 'none'
  figures: DayFigures
  state: DayState
  incidents: DayIncident[]
  maintenance: DayMaintenance[]
}

export interface ComponentUptime {
  /** Oldest first, one per requested day. */
  days: ComponentDay[]
  /** Sum of the days with data. */
  totals: DayFigures
}

/** Static components have no checks: their uptime always comes from the incidents. */
export const componentMode = (
  mode: UptimeCalculationMode,
  type: ComponentType,
): UptimeCalculationMode => (type === 'static' ? 'manual' : mode)

/** The page's calculation mode (default `checks`). */
export const pageUptimeMode = (
  page: Pick<StatusPage, 'uptimeCalculation'>,
): UptimeCalculationMode =>
  isUptimeCalculationMode(page.uptimeCalculation)
    ? page.uptimeCalculation
    : DEFAULT_UPTIME_CALCULATION_MODE

// ---- Live data of a monitor -------------------------------------------------------------------------

export interface LiveDay {
  figures: DayFigures
  held: Set<BeatStatus>
  degraded: number
  maintenance: number
  /** Seconds spent in MAINTENANCE, from the replayed transitions (0 for snapshots). */
  maintenanceSeconds: number
}

type StatRow = {
  timestamp: number
  up?: number | null
  down?: number | null
  extras?: unknown
}

const extrasCount = (extras: unknown, key: string): number => {
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return 0
  const value = (extras as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const dayEnd = (day: number, now: Date): number =>
  Math.min((day + DAY_SECONDS) * 1000, now.getTime())

/**
 * The days of `days` (UTC day starts, ascending) on which `monitorId` recorded checks, from
 * `stat-daily` and the important heartbeats. Days without a `stat-daily` row are left out.
 */
export async function loadMonitorDays(
  payload: Payload,
  monitor: { id: string | number; lastStatus?: BeatStatus | null },
  days: readonly number[],
  now: Date,
): Promise<Map<number, LiveDay>> {
  const out = new Map<number, LiveDay>()
  if (days.length === 0) return out
  const first = days[0]
  const last = days[days.length - 1]
  const fromIso = new Date(first * 1000).toISOString()
  const toIso = new Date(dayEnd(last, now)).toISOString()

  const [stats, changes, prior] = await Promise.all([
    payload.find({
      collection: 'stat-daily',
      where: {
        and: [
          { monitor: { equals: monitor.id } },
          { timestamp: { greater_than_equal: first } },
          { timestamp: { less_than_equal: last } },
        ],
      },
      sort: 'timestamp',
      limit: days.length,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { timestamp: true, up: true, down: true, extras: true },
    }),
    payload.find({
      collection: 'heartbeats',
      where: {
        and: [
          { monitor: { equals: monitor.id } },
          { important: { equals: true } },
          { time: { greater_than_equal: fromIso } },
          { time: { less_than: toIso } },
        ],
      },
      sort: 'time',
      limit: MAX_TRANSITIONS,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { status: true, time: true },
    }),
    payload.find({
      collection: 'heartbeats',
      where: {
        and: [
          { monitor: { equals: monitor.id } },
          { important: { equals: true } },
          { time: { less_than: fromIso } },
        ],
      },
      sort: '-time',
      limit: 1,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { status: true, time: true },
    }),
  ])
  if (stats.docs.length === 0) return out

  const transitions: StatusChange[] = changes.docs.map((beat) => ({
    time: Date.parse(beat.time),
    status: beat.status as BeatStatus,
  }))
  // Without any transition in the window the status never changed: it is the current one.
  const initial: BeatStatus | null =
    (prior.docs[0]?.status as BeatStatus | undefined) ??
    (transitions.length === 0 ? (monitor.lastStatus ?? null) : null)

  for (const row of stats.docs as StatRow[]) {
    const from = row.timestamp * 1000
    const to = dayEnd(row.timestamp, now)
    if (to <= from) continue
    const replay = replayStatuses(initial, transitions, from, to)
    out.set(row.timestamp, {
      figures: {
        ...emptyFigures(),
        up: row.up ?? 0,
        down: row.down ?? 0,
        downSeconds: replay.downSeconds,
        knownSeconds: replay.knownSeconds,
        elapsedSeconds: (to - from) / 1000,
      },
      held: replay.held,
      degraded: extrasCount(row.extras, 'degraded'),
      maintenance: extrasCount(row.extras, 'maintenance'),
      maintenanceSeconds: replay.maintenanceSeconds,
    })
  }
  return out
}

// ---- Incidents and maintenance of a page ------------------------------------------------------------

interface WindowIncident {
  id: string
  publicId: string
  title: string
  /** Components named by the incident's updates. */
  named: Set<string>
  /** From the first update to the resolution (or now). */
  start: number
  end: number
  updates: ReturnType<typeof incidentTimeline>['updates']
}

/** Incidents of the page that may overlap `[from, to)`: still active, or resolved after `from`. */
async function windowIncidents(
  payload: Payload,
  pageId: string | number,
  from: number,
  to: number,
): Promise<WindowIncident[]> {
  const { docs } = await payload.find({
    collection: 'incidents',
    where: {
      and: [
        { statusPage: { equals: pageId } },
        {
          or: [
            { active: { equals: true } },
            { resolvedAt: { greater_than_equal: new Date(from).toISOString() } },
          ],
        },
      ],
    },
    sort: 'createdAt',
    limit: MAX_WINDOW_INCIDENTS,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return (docs as Incident[]).flatMap((incident) => {
    const { updates, state } = incidentTimeline(incident)
    const start = Date.parse(updates[0]?.postedAt ?? incident.createdAt)
    const resolved = state.resolvedAt ? Date.parse(state.resolvedAt) : Number.NaN
    const end = state.active || !Number.isFinite(resolved) ? to : resolved
    if (!Number.isFinite(start) || end <= from || start >= to) return []
    const named = new Set(updates.flatMap((u) => (u.components ?? []).map((c) => c.component)))
    return [
      {
        id: String(incident.id),
        publicId: publicIdOf('incidents', incident),
        title: incident.title,
        named,
        start,
        end,
        updates,
      },
    ]
  })
}

interface WindowMaintenance {
  id: string
  publicId: string
  title: string
  /** Monitor ids the maintenance covers. */
  monitors: Set<string>
  start: number
  end: number
}

/** Maintenance windows announced on the page that ran within `[from, to)`. */
async function windowMaintenance(
  payload: Payload,
  pageId: string | number,
  from: number,
  to: number,
): Promise<WindowMaintenance[]> {
  const { docs: maintenances } = await payload.find({
    collection: 'maintenance',
    where: { statusPages: { equals: pageId } },
    depth: 0,
    limit: 500,
    pagination: false,
    overrideAccess: true,
  })
  if (maintenances.length === 0) return []
  const byId = new Map((maintenances as Maintenance[]).map((doc) => [String(doc.id), doc]))
  const { docs } = await payload.find({
    collection: 'maintenance-occurrences',
    where: {
      and: [
        { maintenance: { in: [...byId.keys()] } },
        { state: { in: ['in-progress', 'verifying', 'completed'] } },
        { start: { less_than: new Date(to).toISOString() } },
      ],
    },
    sort: 'start',
    depth: 0,
    limit: 5000,
    pagination: false,
    overrideAccess: true,
  })
  return (docs as MaintenanceOccurrence[]).flatMap((occurrence) => {
    const doc = byId.get(String(relationId(occurrence.maintenance)))
    if (!doc) return []
    const start = Date.parse(occurrence.startedAt ?? occurrence.start)
    const finished = occurrence.completedAt ?? occurrence.end
    const end = occurrence.state === 'completed' && finished ? Date.parse(finished) : to
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= from || start >= to) return []
    return [
      {
        id: String(occurrence.id),
        publicId: publicIdOf('maintenance-occurrences', occurrence),
        title: doc.title,
        monitors: new Set(
          (doc.monitors ?? []).flatMap((m) => {
            const id = relationId(m)
            return id === null ? [] : [String(id)]
          }),
        ),
        start,
        end: Math.min(end, to),
      },
    ]
  })
}

// ---- Snapshots --------------------------------------------------------------------------------------

type SnapshotRow = {
  component: string
  timestamp: number
  up?: number | null
  down?: number | null
  degraded?: number | null
  maintenance?: number | null
  downSeconds?: number | null
  knownSeconds?: number | null
  state?: DayState | null
}

async function loadSnapshots(
  payload: Payload,
  pageId: string | number,
  componentIds: readonly string[],
  first: number,
  last: number,
): Promise<Map<string, SnapshotRow>> {
  const out = new Map<string, SnapshotRow>()
  if (componentIds.length === 0) return out
  const { docs } = await payload.find({
    collection: 'status-page-uptime-history',
    where: {
      and: [
        { statusPage: { equals: pageId } },
        { component: { in: [...componentIds] } },
        { timestamp: { greater_than_equal: first } },
        { timestamp: { less_than_equal: last } },
      ],
    },
    limit: 0,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  for (const row of docs as SnapshotRow[]) out.set(`${row.component}:${row.timestamp}`, row)
  return out
}

const snapshotDay = (row: SnapshotRow): LiveDay => ({
  figures: {
    ...emptyFigures(),
    up: row.up ?? 0,
    down: row.down ?? 0,
    downSeconds: row.downSeconds ?? 0,
    knownSeconds: row.knownSeconds ?? 0,
    elapsedSeconds: DAY_SECONDS,
  },
  held: new Set<BeatStatus>(
    row.state === 'down' ? ['down'] : row.state === 'maintenance' ? ['maintenance'] : [],
  ),
  degraded: row.degraded ?? (row.state === 'degraded' ? 1 : 0),
  maintenance: row.maintenance ?? 0,
  maintenanceSeconds: 0,
})

// ---- Page uptime ------------------------------------------------------------------------------------

export interface PageUptimeOptions {
  now?: Date
  /** UTC day starts to compute, ascending (default: the page's bar window). */
  days?: readonly number[]
}

/**
 * Daily figures of `components` of `page` over `days`: live data where it is still kept, snapshots
 * where retention has removed it, incidents and maintenance for every day.
 */
export async function loadPageUptime(
  payload: Payload,
  page: Pick<StatusPage, 'id' | 'createdAt'> & Partial<Pick<StatusPage, 'access' | 'groups'>>,
  components: readonly UptimeComponent[],
  options: PageUptimeOptions & { days: readonly number[] },
): Promise<Map<string, ComponentUptime>> {
  const now = options.now ?? new Date()
  const days = options.days
  const result = new Map<string, ComponentUptime>()
  if (days.length === 0 || components.length === 0) return result
  const from = days[0] * 1000
  const to = dayEnd(days[days.length - 1], now)

  const monitorComponents = components.filter((c) => c.type === 'monitor' && c.monitorId !== null)
  const monitorIds = [...new Set(monitorComponents.map((c) => String(c.monitorId)))]
  const lastStatus = new Map(monitorComponents.map((c) => [String(c.monitorId), c.lastStatus]))

  const [live, snapshots, incidents, maintenance] = await Promise.all([
    Promise.all(
      monitorIds.map(
        async (id) =>
          [
            id,
            await loadMonitorDays(
              payload,
              {
                id: monitorComponents.find((c) => String(c.monitorId) === id)?.monitorId ?? id,
                lastStatus: lastStatus.get(id),
              },
              days,
              now,
            ),
          ] as const,
      ),
    ).then((entries) => new Map(entries)),
    loadSnapshots(
      payload,
      page.id,
      monitorComponents.map((c) => c.id),
      days[0],
      days[days.length - 1],
    ),
    windowIncidents(payload, page.id, from, to),
    // Audience pages (#151): only maintenance the scoped page may show (static components
    // otherwise list every maintenance of the page).
    windowMaintenance(payload, page.id, from, to).then((list) =>
      list.filter((m) =>
        isMaintenanceVisibleOn(
          { access: page.access, groups: page.groups },
          {
            monitors: [...m.monitors],
          },
        ),
      ),
    ),
  ])

  const pageCreated = Date.parse(page.createdAt)
  const pageFirstDay = Number.isFinite(pageCreated) ? utcDayStart(pageCreated) : days[0]

  for (const component of components) {
    const spans: { incident: WindowIncident; spans: ImpactSpan[] }[] = incidents.map(
      (incident) => ({ incident, spans: componentImpactSpans(incident.updates, component.id) }),
    )
    const allSpans = spans.flatMap((entry) => entry.spans)
    const covering = maintenance.filter(
      (m) =>
        component.type === 'static' ||
        (component.monitorId !== null && m.monitors.has(String(component.monitorId))),
    )
    const monitorDays =
      component.type === 'monitor' && component.monitorId !== null
        ? live.get(String(component.monitorId))
        : undefined

    const out: ComponentDay[] = []
    for (const day of days) {
      const dayFrom = day * 1000
      const dayTo = dayEnd(day, now)
      if (dayTo <= dayFrom) continue

      let base: LiveDay | null = null
      let source: ComponentDay['source'] = 'none'
      if (component.type === 'static') {
        if (day >= pageFirstDay) {
          base = {
            figures: { ...emptyFigures(), elapsedSeconds: (dayTo - dayFrom) / 1000 },
            held: new Set(),
            degraded: 0,
            maintenance: 0,
            maintenanceSeconds: 0,
          }
          source = 'live'
        }
      } else {
        const fromLive = monitorDays?.get(day)
        const snapshot = snapshots.get(`${component.id}:${day}`)
        if (fromLive) {
          base = fromLive
          source = 'live'
        } else if (snapshot) {
          base = snapshotDay(snapshot)
          source = 'snapshot'
        }
      }

      const impact = impactWithin(allSpans, dayFrom, dayTo)
      const figures = base
        ? { ...base.figures, impactSeconds: impact.impactSeconds }
        : emptyFigures()

      const dayIncidents: DayIncident[] = []
      for (const { incident, spans: own } of spans) {
        if (incident.end <= dayFrom || incident.start >= dayTo) continue
        if (incident.named.size === 0) {
          dayIncidents.push({ ...pickIncident(incident), impact: null })
          continue
        }
        const worst = impactWithin(own, dayFrom, dayTo).worst
        if (worst) dayIncidents.push({ ...pickIncident(incident), impact: worst })
      }
      const dayMaintenance = covering
        .filter((m) => m.end > dayFrom && m.start < dayTo)
        .map(({ id, publicId, title }) => ({ id, publicId, title }))

      const held = new Set(base?.held ?? [])
      if (component.type === 'static' && dayMaintenance.length > 0) held.add('maintenance')
      if ((base?.maintenance ?? 0) > 0) held.add('maintenance')

      out.push({
        day,
        hasData: base !== null,
        source,
        figures,
        state: dayState({
          hasData: base !== null,
          held,
          degradedChecks: base?.degraded ?? 0,
          impact: impact.worst,
        }),
        incidents: dayIncidents,
        maintenance: dayMaintenance,
      })
    }
    result.set(component.id, {
      days: out,
      totals: sumFigures(out.filter((d) => d.hasData).map((d) => d.figures)),
    })
  }
  return result
}

const pickIncident = ({ id, publicId, title }: WindowIncident) => ({ id, publicId, title })

// ---- Snapshot job -----------------------------------------------------------------------------------

export const UPTIME_SNAPSHOT_JOB_NAME = 'status-page-uptime-snapshot'
/** Every day at 00:20 UTC, once the previous UTC day is complete (and late probe results are in). */
export const UPTIME_SNAPSHOT_PATTERN = '20 0 * * *'
/** Complete days each run re-examines (missing days within it are written). */
export const SNAPSHOT_LOOKBACK_DAYS = 35
/** Days back-filled for a page without any snapshot yet (its first run). */
export const SNAPSHOT_BACKFILL_DAYS = 400

export interface SnapshotOptions {
  now?: Date
  /** Complete days examined per page (default `SNAPSHOT_LOOKBACK_DAYS`). */
  lookbackDays?: number
}

export interface SnapshotResult {
  pages: number
  created: number
}

/**
 * Preserve the daily uptime of every monitor component of every status page: for each complete
 * UTC day within the lookback (the whole retained history on a page's first run) that has check
 * data and no snapshot yet, write a `status-page-uptime-history` row. Idempotent; existing rows are
 * never rewritten, so a later run after retention cannot overwrite them with nothing.
 */
export async function snapshotUptimeHistory(
  payload: Payload,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const now = options.now ?? new Date()
  const today = utcDayStart(now.getTime())
  const lookback = Math.max(1, options.lookbackDays ?? SNAPSHOT_LOOKBACK_DAYS)
  const result: SnapshotResult = { pages: 0, created: 0 }

  const { docs: pages } = await payload.find({
    collection: 'status-pages',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { organization: true, groups: true },
  })

  // Live data per monitor and first day, shared by pages that show the same monitor.
  const cache = new Map<string, Promise<Map<number, LiveDay>>>()

  for (const page of pages as StatusPage[]) {
    const rows = (page.groups ?? []).flatMap((group) =>
      (group.monitors ?? []).flatMap((row) => {
        if (row.type === 'static' || !row.id) return []
        const monitorId = relationId(row.monitor)
        return monitorId === null ? [] : [{ id: String(row.id), monitorId }]
      }),
    )
    if (rows.length === 0) continue
    result.pages += 1

    const hasAny = await payload.find({
      collection: 'status-page-uptime-history',
      where: { statusPage: { equals: page.id } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      select: { timestamp: true },
    })
    const span = hasAny.docs.length === 0 ? Math.max(lookback, SNAPSHOT_BACKFILL_DAYS) : lookback
    const days = Array.from({ length: span }, (_, i) => today - (span - i) * DAY_SECONDS)

    const existing = await loadSnapshots(
      payload,
      page.id,
      rows.map((r) => r.id),
      days[0],
      days[days.length - 1],
    )
    const { docs: monitors } = await payload.find({
      collection: 'monitors',
      where: { id: { in: [...new Set(rows.map((r) => r.monitorId))] } },
      depth: 0,
      limit: rows.length,
      pagination: false,
      overrideAccess: true,
      select: { status: true },
    })
    const statusOf = new Map(monitors.map((m) => [String(m.id), m.status?.lastStatus ?? null]))

    for (const row of rows) {
      if (!statusOf.has(String(row.monitorId))) continue
      const key = `${String(row.monitorId)}:${days[0]}`
      if (!cache.has(key)) {
        cache.set(
          key,
          loadMonitorDays(
            payload,
            { id: row.monitorId, lastStatus: statusOf.get(String(row.monitorId)) },
            days,
            now,
          ),
        )
      }
      const live = await (cache.get(key) as Promise<Map<number, LiveDay>>)
      for (const [day, data] of live) {
        if (existing.has(`${row.id}:${day}`)) continue
        try {
          await payload.create({
            collection: 'status-page-uptime-history',
            // Ids are numbers on Postgres and strings on MongoDB; the generated types follow one
            // adapter, so the adapter-neutral ids are cast (as in the stats rollups).
            data: {
              organization: relationId(page.organization),
              statusPage: page.id,
              component: row.id,
              timestamp: day,
              day: dayLabel(day),
              month: monthLabel(day),
              up: data.figures.up,
              down: data.figures.down,
              degraded: data.degraded,
              maintenance: data.maintenance,
              downSeconds: data.figures.downSeconds,
              knownSeconds: data.figures.knownSeconds,
              state: dayState({
                hasData: true,
                held: data.held,
                degradedChecks: data.degraded,
              }),
            } as unknown as RequiredDataFromCollectionSlug<'status-page-uptime-history'>,
            depth: 0,
            overrideAccess: true,
          })
          result.created += 1
        } catch (err) {
          // Another run wrote the same day first (unique index); nothing to do.
          log.debug({ err, page: page.id, component: row.id, day }, 'snapshot already exists')
        }
      }
    }
  }
  log.info(result, 'uptime history snapshot finished')
  return result
}

// ---- Monthly history --------------------------------------------------------------------------------

/** Most months the history view and export cover. */
export const MAX_HISTORY_MONTHS = 24

/** UTC day starts from the first day of the month `months - 1` months ago through today. */
export function monthsWindow(months: number, now: Date): number[] {
  const count = Math.min(MAX_HISTORY_MONTHS, Math.max(1, Math.floor(months)))
  const firstOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1), 1)
  const today = utcDayStart(now.getTime())
  const days: number[] = []
  for (let day = firstOfMonth / 1000; day <= today; day += DAY_SECONDS) days.push(day)
  return days
}

/**
 * Monthly uptime per component of the page under its calculation mode, newest month first and
 * components in page order. Months in which a component has no data are listed with `uptime: null`.
 */
export async function monthlyUptimeHistory(
  payload: Payload,
  page: Pick<StatusPage, 'id' | 'createdAt' | 'uptimeCalculation'>,
  components: readonly (UptimeComponent & { name: string })[],
  options: { months?: number; now?: Date } = {},
): Promise<MonthlyUptimeRow[]> {
  const now = options.now ?? new Date()
  const days = monthsWindow(options.months ?? 12, now)
  const uptime = await loadPageUptime(payload, page, components, { now, days })
  const mode = pageUptimeMode(page)
  const months = [...new Set(days.map(monthLabel))].reverse()

  const rows: MonthlyUptimeRow[] = []
  for (const month of months) {
    for (const component of components) {
      const inMonth = (uptime.get(component.id)?.days ?? []).filter(
        (d) => d.hasData && monthLabel(d.day) === month,
      )
      const totals = sumFigures(inMonth.map((d) => d.figures))
      const effective = componentMode(mode, component.type)
      rows.push({
        month,
        componentId: component.id,
        component: component.name,
        uptime: inMonth.length > 0 ? uptimeOf(effective, totals) : null,
        downtimeSeconds: inMonth.length > 0 ? downtimeOf(effective, totals) : null,
        days: inMonth.length,
      })
    }
  }
  return rows
}
