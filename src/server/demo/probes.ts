/**
 * Simulated probe agents for demo mode (#159). The seeded locations have no agent behind them, so
 * the `demo-probes` job (every minute on the `marmot:maintenance` queue, demo mode only) plays their
 * part: it stamps `lastSeenAt` (the locations stay online) and feeds each due monitor a simulated
 * result through the real ingest path (`ingestProbeResults`: quorum, stats, realtime, incidents and
 * notifications, which end in the sink). Locations visitors create stay agent-less, as usual.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { isMultiLocation, monitorLocationIds, probeSupportsType } from '@/lib/probe-locations'
import { MARMOT_VERSION } from '@/lib/version'
import type { Location, Monitor } from '@/payload-types'
import { locationLastCheckAt } from '@/server/engine/quorum-store'
import { touchLocation } from '@/server/probes'
import { ingestProbeResults } from '@/server/probes/ingest'

import { isDemoMode } from './config'
import { DEMO_PROBE_HOSTNAME } from './dataset'
import { isSimulatedType, simulateCheck } from './simulate'

const log = childLogger('demo:probes')

export const DEMO_PROBES_JOB_NAME = 'demo-probes'
export const DEMO_PROBES_INTERVAL_MS = 60_000
/** A check is due a little early so a one-minute tick never skips a one-minute interval. */
const EARLY_MS = 5_000

export interface DemoProbesResult {
  locations: number
  results: number
}

export async function runDemoProbes(
  payload: Payload,
  now: Date = new Date(),
  { pipeline = false }: { pipeline?: boolean } = {},
): Promise<DemoProbesResult> {
  if (!isDemoMode()) return { locations: 0, results: 0 }
  const { docs: locations } = (await payload.find({
    collection: 'locations',
    where: { 'agent.hostname': { equals: DEMO_PROBE_HOSTNAME } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })) as { docs: Location[] }

  let results = 0
  for (const location of locations) {
    await touchLocation(
      payload,
      location,
      { version: MARMOT_VERSION, hostname: DEMO_PROBE_HOSTNAME, platform: 'linux' },
      now,
    )
    const { docs: monitors } = (await payload.find({
      collection: 'monitors',
      where: { and: [{ active: { equals: true } }, { locations: { in: [location.id] } }] },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
    })) as { docs: Monitor[] }

    for (const monitor of monitors) {
      if (!probeSupportsType(monitor.type) || !isSimulatedType(monitor.type)) continue
      if (!monitorLocationIds(monitor).some((id) => String(id) === String(location.id))) continue
      const previous = isMultiLocation(monitor)
        ? await locationLastCheckAt(payload, monitor.id, String(location.id))
        : monitor.status?.lastCheckAt
      const due = previous
        ? now.getTime() - Date.parse(previous) >= monitor.interval * 1000 - EARLY_MS
        : true
      if (!due) continue
      const check = simulateCheck(monitor, now, location.slug)
      try {
        await ingestProbeResults(
          payload,
          location,
          [
            {
              monitorId: monitor.id,
              time: now.toISOString(),
              ok: check.ok,
              ...(check.ok ? { status: 'up' as const } : {}),
              msg: check.msg,
              ping: check.ping ?? null,
              duration: null,
              timing: check.timing ?? null,
            },
          ],
          { now, pipeline },
        )
        results += 1
      } catch (err) {
        log.warn({ err, monitorId: monitor.id, location: location.slug }, 'simulated probe failed')
      }
    }
  }
  return { locations: locations.length, results }
}
