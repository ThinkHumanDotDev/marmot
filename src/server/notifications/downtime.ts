import type { Payload } from 'payload'

import type { Heartbeat } from '@/payload-types'

const relationId = (value: Heartbeat['monitor']): string | number =>
  typeof value === 'object' && value !== null ? value.id : value

/**
 * How long a monitor was DOWN before the recovery `heartbeat` (#126), in seconds: the time since
 * the important beat right before it, when that beat is the DOWN transition. `null` when the outage
 * start is unknown (pruned by retention, or the previous transition was not DOWN), so a message
 * never shows a made-up duration.
 */
export async function recoveryDowntimeSeconds(
  payload: Payload,
  heartbeat: Pick<Heartbeat, 'id' | 'monitor' | 'time'>,
): Promise<number | null> {
  const end = new Date(heartbeat.time).getTime()
  if (Number.isNaN(end)) return null
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: {
      and: [
        { monitor: { equals: relationId(heartbeat.monitor) } },
        { important: { equals: true } },
        { time: { less_than: heartbeat.time } },
      ],
    },
    sort: '-time',
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { status: true, time: true },
  })
  const start = docs[0] as Pick<Heartbeat, 'status' | 'time'> | undefined
  if (!start || start.status !== 'down') return null
  const seconds = Math.round((end - new Date(start.time).getTime()) / 1000)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}
