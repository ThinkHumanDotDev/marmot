/**
 * Applies the alerts of one inbound payload or message to an integration (#152). Transport-agnostic:
 * `POST /api/inbound/<token>` (`./http.ts`) and inbound email (`src/server/push/email.ts`) end here.
 *
 * Per alert, keyed by `(integration, dedupKey)` in `integration-alerts`:
 *
 * - **firing**, not yet firing: the first matching rule runs. With `updateComponent` (opt-in) and/or
 *   `incident: publish` it opens a status-page incident on the rule's page (the component impact is
 *   carried by that incident, the way every component status is); `incident: draft` declares an
 *   internal incident (#101), linked to the public one when there is one; `monitor` records a push
 *   failure. The alert row remembers what was opened.
 * - **firing** while already firing: a retry or a repeat; nothing changes (`duplicate`).
 * - **resolved** while firing: what the firing opened is resolved (resolved update on the public
 *   incident, which restores the component; the declared incident moves to `resolved`; a push
 *   success). Resolved again, or never seen: nothing changes.
 *
 * The first firing of a key is claimed by the unique index, and every key is processed under a short
 * lock (Redis, plus an in-process queue), so concurrent retries cannot open two incidents.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import {
  EVENTS_PER_INTEGRATION,
  eventPayloadText,
  matchRule,
  type AlertOutcome,
  type InboundAlert,
  type IntegrationEventSource,
  type ParsedPayload,
} from '@/lib/inbound-alerts'
import type {
  DeclaredIncident,
  Incident,
  Integration,
  IntegrationAlert,
  Monitor,
} from '@/payload-types'
import { ingestPushSignal } from '@/server/push/signals'
import { createRedis } from '@/server/redis'

const log = childLogger('integrations')

type Id = string | number
type Rule = NonNullable<Integration['rules']>[number]

const relId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

export interface AlertResult {
  dedupKey: string
  status: InboundAlert['status']
  title: string
  rule: string | null
  outcome: AlertOutcome
  actions: string[]
  error?: string
}

export interface IngestOptions {
  source: IntegrationEventSource
  /** What the event log keeps (redacted and cut by `eventPayloadText`). */
  raw: unknown
  now?: Date
}

// --- per-key lock -------------------------------------------------------------------------------

const LOCK_TTL_MS = 30_000
const local = new Map<string, Promise<unknown>>()
let lockClient: ReturnType<typeof createRedis> | null = null

const redis = () => {
  lockClient ??= createRedis({ maxRetriesPerRequest: 1, commandTimeout: 1_000 })
  return lockClient
}

/** Closes the lock connection (tests, graceful shutdown). */
export async function closeIntegrationLocks(): Promise<void> {
  const client = lockClient
  lockClient = null
  if (client) await client.quit().catch(() => undefined)
}

async function withRedisLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const token = Math.random().toString(36).slice(2)
  let held = false
  try {
    for (let attempt = 0; attempt < 50 && !held; attempt += 1) {
      held = (await redis().set(key, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK'
      if (!held) await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } catch (err) {
    // Redis unavailable: the unique index still prevents duplicate first firings.
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'alert lock unavailable')
  }
  try {
    return await fn()
  } finally {
    if (held) {
      const current = await redis()
        .get(key)
        .catch(() => null)
      if (current === token)
        await redis()
          .del(key)
          .catch(() => undefined)
    }
  }
}

function withAlertLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = local.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => withRedisLock(`marmot:inbound:${key}`, fn))
  local.set(key, next)
  void next.finally(() => {
    if (local.get(key) === next) local.delete(key)
  })
  return next
}

// --- actions ------------------------------------------------------------------------------------

async function findAlert(
  payload: Payload,
  integrationId: Id,
  dedupKey: string,
): Promise<IntegrationAlert | null> {
  const { docs } = await payload.find({
    collection: 'integration-alerts',
    where: {
      and: [{ integration: { equals: integrationId } }, { dedupKey: { equals: dedupKey } }],
    },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return (docs[0] as IntegrationAlert | undefined) ?? null
}

async function openActions(
  payload: Payload,
  integration: Integration,
  rule: Rule,
  alert: InboundAlert,
  now: Date,
): Promise<{ actions: string[]; statusPageIncident: Id | null; declaredIncident: Id | null }> {
  const actions: string[] = []
  let statusPageIncident: Id | null = null
  let declaredIncident: Id | null = null
  const pageId = relId(rule.statusPage)

  if (pageId !== null && (rule.updateComponent === true || rule.incident === 'publish')) {
    const components =
      rule.updateComponent === true && rule.component
        ? [{ component: rule.component, impact: rule.impact ?? 'partial_outage' }]
        : []
    const incident = (await payload.create({
      collection: 'incidents',
      overrideAccess: true,
      depth: 0,
      data: {
        statusPage: pageId,
        organization: integration.organization,
        title: alert.title,
        impact: components.length === 0 ? (rule.impact ?? 'partial_outage') : undefined,
        updates: [
          {
            status: 'investigating',
            message: alert.description ?? '',
            postedAt: now.toISOString(),
            components,
          },
        ],
      } as Partial<Incident> as Incident,
    })) as Incident
    statusPageIncident = incident.id
    actions.push(components.length > 0 ? 'component' : 'status_page_incident')
  }

  if (rule.incident === 'draft') {
    const declared = (await payload.create({
      collection: 'declared-incidents',
      overrideAccess: true,
      depth: 0,
      context: { declaredIncidentNote: `Opened by the "${integration.name}" integration.` },
      data: {
        organization: integration.organization,
        title: alert.title,
        severity: rule.severity ?? 'major',
        summary: alert.description,
        startedAt: now.toISOString(),
        statusPageIncident,
      } as Partial<DeclaredIncident> as DeclaredIncident,
    })) as DeclaredIncident
    declaredIncident = declared.id
    actions.push('declared_incident')
  }

  if (await pushSignal(payload, rule, 'fail', alert.title, now)) actions.push('monitor')
  return { actions, statusPageIncident, declaredIncident }
}

async function pushSignal(
  payload: Payload,
  rule: Rule | undefined,
  kind: 'fail' | 'success',
  msg: string,
  now: Date,
): Promise<boolean> {
  const monitorId = relId(rule?.monitor)
  if (monitorId === null) return false
  const monitor = (await payload
    .findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true })
    .catch(() => null)) as Monitor | null
  if (!monitor || monitor.type !== 'push' || monitor.active === false) return false
  await ingestPushSignal(payload, monitor, { kind, msg, source: 'integration' }, { now })
  return true
}

async function resolveActions(
  payload: Payload,
  integration: Integration,
  row: IntegrationAlert,
  alert: InboundAlert,
  now: Date,
): Promise<string[]> {
  const actions: string[] = []
  const rule = (integration.rules ?? []).find((r) => r.id && String(r.id) === row.rule)

  const incidentId = relId(row.statusPageIncident)
  if (incidentId !== null) {
    const incident = (await payload
      .findByID({ collection: 'incidents', id: incidentId, depth: 0, overrideAccess: true })
      .catch(() => null)) as Incident | null
    if (incident && incident.active !== false) {
      await payload.update({
        collection: 'incidents',
        id: incident.id,
        overrideAccess: true,
        depth: 0,
        data: {
          updates: [
            ...(incident.updates ?? []),
            {
              status: 'resolved',
              message: alert.description ?? '',
              postedAt: now.toISOString(),
              components: [],
            },
          ],
        },
      })
      actions.push('status_page_incident')
    }
  }

  const declaredId = relId(row.declaredIncident)
  if (declaredId !== null) {
    const declared = (await payload
      .findByID({
        collection: 'declared-incidents',
        id: declaredId,
        depth: 0,
        overrideAccess: true,
      })
      .catch(() => null)) as DeclaredIncident | null
    if (declared && (declared.status === 'open' || declared.status === 'mitigated')) {
      await payload.update({
        collection: 'declared-incidents',
        id: declared.id,
        overrideAccess: true,
        depth: 0,
        context: { declaredIncidentNote: `Resolved by the "${integration.name}" integration.` },
        data: { status: 'resolved' },
      })
      actions.push('declared_incident')
    }
  }

  if (await pushSignal(payload, rule, 'success', alert.title, now)) actions.push('monitor')
  return actions
}

async function applyAlert(
  payload: Payload,
  integration: Integration,
  alert: InboundAlert,
  now: Date,
): Promise<AlertResult> {
  const result: AlertResult = {
    dedupKey: alert.dedupKey,
    status: alert.status,
    title: alert.title,
    rule: null,
    outcome: 'duplicate',
    actions: [],
  }
  let row = await findAlert(payload, integration.id, alert.dedupKey)

  if (alert.status === 'resolved') {
    if (!row) return { ...result, outcome: 'unknown' }
    result.rule = row.rule ?? null
    if (row.status === 'resolved') return result
    await payload.update({
      collection: 'integration-alerts',
      id: row.id,
      overrideAccess: true,
      depth: 0,
      data: { status: 'resolved', resolvedAt: now.toISOString(), lastEventAt: now.toISOString() },
    })
    try {
      result.actions = await resolveActions(payload, integration, row, alert, now)
      result.outcome = 'resolved'
    } catch (err) {
      log.warn({ err, integration: integration.id }, 'resolving an inbound alert failed')
      result.outcome = 'error'
      result.error = err instanceof Error ? err.message.slice(0, 300) : 'failed'
    }
    return result
  }

  if (row?.status === 'firing') {
    await payload.update({
      collection: 'integration-alerts',
      id: row.id,
      overrideAccess: true,
      depth: 0,
      data: { lastEventAt: now.toISOString() },
    })
    return { ...result, rule: row.rule ?? null }
  }

  const rule = matchRule(integration.rules ?? [], alert)
  if (!rule) return { ...result, outcome: 'unmatched' }
  result.rule = rule.id ? String(rule.id) : null

  const state = {
    status: 'firing' as const,
    title: alert.title,
    rule: result.rule,
    firedAt: now.toISOString(),
    resolvedAt: null,
    lastEventAt: now.toISOString(),
    statusPageIncident: null,
    declaredIncident: null,
  }
  if (row) {
    row = (await payload.update({
      collection: 'integration-alerts',
      id: row.id,
      overrideAccess: true,
      depth: 0,
      data: state,
    })) as IntegrationAlert
  } else {
    try {
      row = (await payload.create({
        collection: 'integration-alerts',
        overrideAccess: true,
        depth: 0,
        data: {
          ...state,
          organization: integration.organization,
          integration: integration.id,
          dedupKey: alert.dedupKey,
        },
      })) as IntegrationAlert
    } catch (err) {
      // Another process claimed this key first (unique index): its firing wins.
      if (await findAlert(payload, integration.id, alert.dedupKey)) return result
      throw err
    }
  }

  try {
    const opened = await openActions(payload, integration, rule, alert, now)
    result.actions = opened.actions
    result.outcome = 'opened'
    if (opened.statusPageIncident !== null || opened.declaredIncident !== null) {
      await payload.update({
        collection: 'integration-alerts',
        id: row.id,
        overrideAccess: true,
        depth: 0,
        data: {
          statusPageIncident: opened.statusPageIncident,
          declaredIncident: opened.declaredIncident,
        } as Partial<IntegrationAlert>,
      })
    }
  } catch (err) {
    log.warn({ err, integration: integration.id }, 'applying an inbound alert failed')
    result.outcome = 'error'
    result.error = err instanceof Error ? err.message.slice(0, 300) : 'failed'
  }
  return result
}

async function pruneEvents(payload: Payload, integrationId: Id): Promise<void> {
  const { docs } = await payload.find({
    collection: 'integration-events',
    where: { integration: { equals: integrationId } },
    sort: '-receivedAt',
    depth: 0,
    limit: 1,
    page: EVENTS_PER_INTEGRATION + 1,
    pagination: true,
    overrideAccess: true,
    select: { receivedAt: true },
  })
  const cutoff = docs[0]?.receivedAt
  if (!cutoff) return
  await payload.delete({
    collection: 'integration-events',
    where: {
      and: [
        { integration: { equals: integrationId } },
        { receivedAt: { less_than_equal: cutoff } },
      ],
    },
    depth: 0,
    overrideAccess: true,
  })
}

/** Apply `parsed` to `integration`, log the event, and return one result per alert. */
export async function ingestAlerts(
  payload: Payload,
  integration: Integration,
  parsed: ParsedPayload,
  options: IngestOptions,
): Promise<AlertResult[]> {
  const now = options.now ?? new Date()
  const results: AlertResult[] = []
  for (const alert of parsed.alerts) {
    // The same key twice in one payload is applied in order.
    const key = `${integration.id}:${alert.dedupKey}`
    results.push(await withAlertLock(key, () => applyAlert(payload, integration, alert, now)))
  }

  await payload.create({
    collection: 'integration-events',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: integration.organization,
      integration: integration.id,
      receivedAt: now.toISOString(),
      source: options.source,
      alertCount: parsed.alerts.length,
      droppedCount: parsed.dropped,
      payload: eventPayloadText(options.raw),
      results: results as unknown as Record<string, unknown>[],
    },
  })
  await payload.update({
    collection: 'integrations',
    id: integration.id,
    overrideAccess: true,
    depth: 0,
    context: { integrationBookkeeping: true },
    data: { lastEventAt: now.toISOString() },
  })
  await pruneEvents(payload, integration.id).catch((err: unknown) =>
    log.warn({ err }, 'pruning the integration event log failed'),
  )
  log.debug({ integration: integration.id, results }, 'inbound alerts applied')
  return results
}
