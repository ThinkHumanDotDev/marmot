import { isDemoMode } from '@/server/demo/config'
import { getNextDemoReset } from '@/server/demo/schedule'
import { env } from '@/env'

import { DemoBanner } from './demo-banner'

/** Server side of the demo banner (#159): nothing at all unless `DEMO_MODE` is set. */
export async function DemoBannerSlot() {
  if (!isDemoMode()) return null
  const next = await getNextDemoReset()
  return (
    <DemoBanner
      intervalMinutes={env.DEMO_RESET_INTERVAL_MINUTES}
      nextResetAt={next ? next.toISOString() : null}
    />
  )
}
