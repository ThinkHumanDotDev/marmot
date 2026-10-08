/**
 * Which collector a monitor's checks go to (#99), with a short per-process cache so a check costs
 * no extra query: the monitor's own collector, else the organization's active default. Collector
 * changes clear this process's cache through the collection hooks; other processes (the worker
 * next to the web app) pick them up within `COLLECTOR_CACHE_TTL_MS`.
 */
import type { Payload } from 'payload'

import type { OtelCollector } from '@/payload-types'

export const COLLECTOR_CACHE_TTL_MS = 30_000

type Entry = { collector: OtelCollector | null; expiresAt: number }

const cache = new Map<string, Entry>()

export function invalidateOtelCollectors(): void {
  cache.clear()
}

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

async function load(
  payload: Payload,
  organizationId: string | number,
  collectorId: string | number | null,
): Promise<OtelCollector | null> {
  if (collectorId !== null) {
    const doc = (await payload
      .findByID({
        collection: 'otel-collectors',
        id: collectorId,
        depth: 0,
        overrideAccess: true,
      })
      .catch(() => null)) as OtelCollector | null
    // A collector of another organization is never used, whatever the monitor points at.
    if (!doc || String(relId(doc.organization)) !== String(organizationId)) return null
    return doc
  }
  const { docs } = await payload.find({
    collection: 'otel-collectors',
    where: {
      and: [
        { organization: { equals: organizationId } },
        { default: { equals: true } },
        { active: { equals: true } },
      ],
    },
    sort: '-updatedAt',
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: true,
  })
  return (docs[0] as OtelCollector | undefined) ?? null
}

/**
 * The active collector for a monitor, or `null` (no default, opted out, or its own collector is
 * inactive: a monitor with an explicit collector never falls back to the default).
 */
export async function resolveCollector(
  payload: Payload,
  organizationId: string | number,
  monitor: { otlpExport?: boolean | null; otlpCollector?: unknown },
  now = Date.now(),
): Promise<OtelCollector | null> {
  if (monitor.otlpExport === false) return null
  const collectorId = relId(monitor.otlpCollector)
  const key = `${String(organizationId)}:${collectorId === null ? 'default' : String(collectorId)}`
  let entry = cache.get(key)
  if (!entry || entry.expiresAt <= now) {
    entry = {
      collector: await load(payload, organizationId, collectorId),
      expiresAt: now + COLLECTOR_CACHE_TTL_MS,
    }
    cache.set(key, entry)
  }
  return entry.collector && entry.collector.active !== false ? entry.collector : null
}
