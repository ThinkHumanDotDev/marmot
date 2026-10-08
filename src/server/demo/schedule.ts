/**
 * When the next demo reset happens, for the banner (#159). Read from the `demo-reset` job scheduler
 * in Redis, cached for 30 seconds per process and bounded by a short timeout, so a page never
 * waits on Redis for long. `null` outside demo mode or when Redis cannot tell.
 */
import { childLogger } from '@/lib/logger'
import { getMaintenanceQueue } from '@/server/maintenance/queue'

import { isDemoMode } from './config'
import { nextScheduledReset } from './reset'

const log = childLogger('demo:schedule')

const CACHE_MS = 30_000
const TIMEOUT_MS = 1_500

let cached: { at: number; value: Date | null } | undefined

export async function getNextDemoReset(now: number = Date.now()): Promise<Date | null> {
  if (!isDemoMode()) return null
  if (cached && now - cached.at < CACHE_MS && (!cached.value || cached.value.getTime() > now)) {
    return cached.value
  }
  let value: Date | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    value = await Promise.race([
      nextScheduledReset(getMaintenanceQueue()),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    log.warn({ err }, 'could not read the demo reset schedule')
  } finally {
    clearTimeout(timer)
  }
  cached = { at: now, value }
  return value
}
