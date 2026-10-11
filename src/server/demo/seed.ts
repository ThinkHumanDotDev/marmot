/**
 * Creates the demo dataset (`./dataset.ts`) in an empty database (#159): the organization and its
 * members, tags, simulated probe locations, notification channels pointing at the sink, monitors,
 * status pages with incidents, maintenance windows, resolved on-call incidents and the synthetic
 * history (`./history.ts`).
 *
 * Documents go through the Local API (`overrideAccess`, so hooks derive their state as for a real
 * write) with `DEMO_SEED_CONTEXT` (passes the guard rails), the audit skip flag (the audit log stays
 * empty) and `skipEngineSync` (the reset resyncs every scheduler once at the end).
 */
import { randomBytes } from 'node:crypto'

import type { CollectionSlug, Payload, RequestContext } from 'payload'

import { MARMOT_VERSION } from '@/lib/version'
import type { Monitor, StatusPage } from '@/payload-types'
import { AUDIT_SKIP_CONTEXT } from '@/server/audit/context'
import { generateProbeToken } from '@/server/probes/tokens'

import { DEMO_ACCOUNT, DEMO_ORGANIZATION_SLUG, DEMO_SEED_CONTEXT } from './config'
import {
  DEMO_CHANNELS,
  DEMO_INCIDENTS,
  DEMO_LOCATIONS,
  DEMO_MAINTENANCE,
  DEMO_MEMBERS,
  DEMO_MONITOR_INCIDENTS,
  DEMO_MONITORS,
  DEMO_ORGANIZATION,
  DEMO_PROBE_HOSTNAME,
  DEMO_STATUS_PAGES,
  DEMO_TAGS,
  type DemoMonitor,
} from './dataset'
import { writeMonitorHistory, type HistoryCounts } from './history'

type Id = string | number

export interface SeedOptions {
  /** The reset instant; history ends here. */
  now?: Date
  /** Days of history (default 90). */
  historyDays?: number
}

export interface SeedResult {
  organizationId: Id
  userIds: Id[]
  /** Monitor ids by dataset key. */
  monitors: Record<string, Id>
  statusPages: Record<string, Id>
  history: HistoryCounts
}

const MINUTE = 60_000

/** Everything the seed writes carries this context. */
export const seedContext = (): RequestContext => ({
  [DEMO_SEED_CONTEXT]: true,
  [AUDIT_SKIP_CONTEXT]: true,
  skipEngineSync: true,
})

export async function seedDemoData(
  payload: Payload,
  { now = new Date(), historyDays = 90 }: SeedOptions = {},
): Promise<SeedResult> {
  const context = seedContext()
  const create = async <T extends { id: Id }>(
    collection: CollectionSlug,
    data: Record<string, unknown>,
  ): Promise<T> =>
    (await payload.create({
      collection,
      data: data as never,
      depth: 0,
      overrideAccess: true,
      context,
    })) as unknown as T
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString()

  // Organization and members. The organization exists first so memberships can be written along
  // with the users (the owner grant of the organization hook needs a request user).
  const organization = await create<{ id: Id }>('organizations', {
    name: DEMO_ORGANIZATION.name,
    slug: DEMO_ORGANIZATION_SLUG,
    settings: { timezone: DEMO_ORGANIZATION.timezone, weekStart: 'monday' },
  })
  const orgId = organization.id
  const userIds: Id[] = []
  for (const account of [
    {
      email: DEMO_ACCOUNT.email,
      name: DEMO_ACCOUNT.name,
      role: 'owner',
      password: DEMO_ACCOUNT.password,
    },
    // Colleagues nobody can sign in as: their passwords are random and never shown.
    ...DEMO_MEMBERS.map((m) => ({ ...m, password: randomBytes(24).toString('base64url') })),
  ]) {
    const user = await create<{ id: Id }>('users', {
      email: account.email,
      name: account.name,
      password: account.password,
      // Verified, whatever `requireEmailVerification` says (#253): nobody can confirm these inboxes.
      emailVerified: true,
      emailVerifiedAt: now.toISOString(),
      organizations: [{ organization: orgId, role: account.role }],
    })
    userIds.push(user.id)
  }
  const ownerId = userIds[0]

  const tags = new Map<string, Id>()
  for (const tag of DEMO_TAGS) {
    tags.set(tag.name, (await create<{ id: Id }>('tags', { ...tag, organization: orgId })).id)
  }

  const locations = new Map<string, { id: Id; slug: string }>()
  for (const location of DEMO_LOCATIONS) {
    const token = generateProbeToken()
    const doc = await create<{ id: Id }>('locations', {
      organization: orgId,
      name: location.name,
      slug: location.slug,
      labels: [{ key: 'region', value: location.region }],
      tokenHash: token.tokenHash,
      tokenPrefix: token.prefix,
      status: 'online',
      statusChangedAt: ago(7 * 24 * 60),
      lastSeenAt: now.toISOString(),
      agent: { version: MARMOT_VERSION, hostname: DEMO_PROBE_HOSTNAME, platform: 'linux' },
      createdBy: ownerId,
    })
    locations.set(location.slug, { id: doc.id, slug: location.slug })
  }

  const channels = new Map<string, Id>()
  for (const channel of DEMO_CHANNELS) {
    const doc = await create<{ id: Id }>('notifications', {
      organization: orgId,
      name: channel.name,
      type: channel.type,
      config: channel.config,
      isDefault: channel.isDefault ?? false,
      active: true,
    })
    channels.set(channel.key, doc.id)
  }

  // Monitors: groups come first in the dataset, so parents exist before their children.
  const monitors: Record<string, Id> = {}
  const created: { spec: DemoMonitor; doc: Monitor }[] = []
  for (const spec of DEMO_MONITORS) {
    const production = spec.tags?.some(([name]) => name === 'production') ?? false
    const doc = await create<Monitor>('monitors', {
      organization: orgId,
      key: spec.key,
      name: spec.name,
      type: spec.type,
      description: spec.description ?? null,
      active: !spec.paused,
      parent: spec.parent ? monitors[spec.parent] : null,
      interval: 60,
      retryInterval: 30,
      maxRetries: 2,
      resendInterval: 0,
      timeout: 30,
      ...spec.fields,
      tags: (spec.tags ?? []).map(([name, value]) => ({
        tag: tags.get(name),
        value: value ?? null,
      })),
      notifications:
        spec.type === 'group'
          ? []
          : production
            ? [channels.get('slack'), channels.get('webhook')]
            : [channels.get('slack')],
      locations: (spec.locations ?? []).map((slug) => locations.get(slug)?.id),
      includeLocal: spec.fields?.includeLocal ?? !spec.locations?.length,
    })
    monitors[spec.key] = doc.id
    created.push({ spec, doc })
  }

  // Maintenance before the history, so the running window shows as MAINTENANCE beats.
  const statusPages: Record<string, Id> = {}
  const pageDocs = new Map<string, StatusPage>()
  for (const page of DEMO_STATUS_PAGES) {
    const doc = await create<StatusPage>('status-pages', {
      organization: orgId,
      title: page.title,
      slug: page.slug,
      description: page.description,
      published: true,
      access: 'public',
      showTags: page.key === 'internal',
      showCertificateExpiry: false,
      searchEngineIndex: false,
      subscriptions: { enabled: page.key === 'public', deliveryMode: 'auto', channels: ['email'] },
      groups: page.groups.map((group) => ({
        name: group.name,
        defaultOpen: true,
        monitors: group.rows.map((row) =>
          'monitor' in row
            ? { type: 'monitor', monitor: monitors[row.monitor], name: row.name ?? null }
            : { type: 'static', name: row.static, description: row.description ?? null },
        ),
      })),
    })
    statusPages[page.key] = doc.id
    pageDocs.set(page.key, doc)
  }

  const maintenanceWindows = new Map<string, { from: Date; to: Date }[]>()
  for (const maintenance of DEMO_MAINTENANCE) {
    await create('maintenance', {
      organization: orgId,
      title: maintenance.title,
      description: maintenance.description,
      strategy: maintenance.strategy,
      active: true,
      timezone: DEMO_ORGANIZATION.timezone,
      ...(maintenance.window
        ? {
            dateRange: {
              start: new Date(now.getTime() + maintenance.window.startIn * MINUTE).toISOString(),
              end: new Date(now.getTime() + maintenance.window.endIn * MINUTE).toISOString(),
            },
          }
        : {}),
      ...(maintenance.weekdays ? { weekdays: [...maintenance.weekdays] } : {}),
      ...(maintenance.timeRange ? { timeRange: maintenance.timeRange } : {}),
      monitors: maintenance.monitors.map((key) => monitors[key]),
      statusPages: maintenance.pages.map((key) => statusPages[key]),
    })
    // The manual window runs from the reset on; show its last 40 minutes as maintenance too.
    if (maintenance.strategy === 'manual') {
      for (const key of maintenance.monitors) {
        maintenanceWindows.set(key, [
          { from: new Date(now.getTime() - 40 * MINUTE), to: new Date(now.getTime() + MINUTE) },
        ])
      }
    }
  }

  // Status page incidents with their timelines. Components are the page's rows, by row id.
  for (const incident of DEMO_INCIDENTS) {
    const page = pageDocs.get(incident.page)
    if (!page) continue
    const rowIds = new Map<string, string>()
    for (const group of page.groups ?? []) {
      for (const row of group.monitors ?? []) {
        const monitorId =
          row.monitor && typeof row.monitor === 'object' ? row.monitor.id : row.monitor
        const key = Object.entries(monitors).find(([, id]) => String(id) === String(monitorId))?.[0]
        if (key && row.id) rowIds.set(key, row.id)
      }
    }
    await create('incidents', {
      statusPage: page.id,
      organization: orgId,
      title: incident.title,
      pinned: incident.pinned ?? false,
      updates: incident.updates.map((update) => ({
        status: update.status,
        postedAt: ago(update.minutesAgo),
        message: update.message,
        components: (update.components ?? [])
          .filter(([key]) => rowIds.has(key))
          .map(([key, impact]) => ({ component: rowIds.get(key), impact })),
      })),
    })
  }

  // History, then each monitor's status from its last simulated beat.
  const history: HistoryCounts = {
    heartbeats: 0,
    minutely: 0,
    hourly: 0,
    daily: 0,
    locationHourly: 0,
  }
  for (const { spec, doc } of created) {
    if (!spec.profile) continue
    const located = (spec.locations ?? []).map((slug) => ({
      key: String(locations.get(slug)?.id),
      slug,
    }))
    const local = doc.includeLocal || located.length === 0 ? [{ key: 'local', slug: null }] : []
    const { counts, last } = await writeMonitorHistory(
      payload,
      orgId,
      {
        id: doc.id,
        key: spec.key,
        type: spec.type,
        url: doc.url,
        interval: doc.interval,
        degradedAfter: doc.degradedAfter,
        profile: spec.profile,
        locations: [...local, ...located],
        until: spec.paused ? new Date(now.getTime() - 6 * 24 * 60 * MINUTE) : null,
        maintenance: maintenanceWindows.get(spec.key),
      },
      { now, days: historyDays },
    )
    for (const key of Object.keys(history) as (keyof HistoryCounts)[]) history[key] += counts[key]
    if (!last) continue
    await payload.update({
      collection: 'monitors',
      id: doc.id,
      data: {
        status: {
          lastStatus: last.status,
          settledStatus: last.status,
          lastCheckAt: last.time.toISOString(),
          lastPing: last.status === 'down' ? null : last.outcome.ping,
          lastMsg: last.outcome.msg,
          retries: 0,
          downCount: 0,
        },
      },
      depth: 0,
      overrideAccess: true,
      context,
    })
  }

  // The push monitor last reported three hours ago.
  if (monitors['nightly-backup'] !== undefined) {
    await payload.update({
      collection: 'monitors',
      id: monitors['nightly-backup'],
      data: {
        status: {
          lastStatus: 'up',
          settledStatus: 'up',
          lastCheckAt: ago(180),
          lastPushAt: ago(180),
          lastPushStatus: 'up',
          lastMsg: 'Backup finished: 42 GB in 18 min',
        },
      },
      depth: 0,
      overrideAccess: true,
      context,
    })
  }

  // Resolved on-call incidents for the incident history (#100).
  for (const incident of DEMO_MONITOR_INCIDENTS) {
    const monitorId = monitors[incident.monitor]
    if (monitorId === undefined) continue
    const started = incident.startedMinutesAgo
    const acknowledged =
      incident.acknowledgedAfter !== undefined ? ago(started - incident.acknowledgedAfter) : null
    const resolved = ago(started - incident.resolvedAfter)
    await create('monitor-incidents', {
      organization: orgId,
      monitor: monitorId,
      status: 'resolved',
      cause: incident.cause,
      startedAt: ago(started),
      acknowledgedAt: acknowledged,
      acknowledgedBy: acknowledged ? userIds[1] : null,
      acknowledgedVia: acknowledged ? 'dashboard' : null,
      resolvedAt: resolved,
      autoResolved: true,
      timeline: [
        { type: 'opened', at: ago(started), message: incident.cause },
        ...(acknowledged
          ? [{ type: 'acknowledged', at: acknowledged, by: userIds[1], via: 'dashboard' }]
          : []),
        { type: 'resolved', at: resolved },
      ],
    })
  }

  return { organizationId: orgId, userIds, monitors, statusPages, history }
}
