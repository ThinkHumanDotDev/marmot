'use client'

import { FlaskConicalIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

export interface DemoBannerProps {
  /** Minutes between two resets (`DEMO_RESET_INTERVAL_MINUTES`). */
  intervalMinutes: number
  /** Next scheduled reset (ISO), when the scheduler could be read. */
  nextResetAt: string | null
}

/**
 * Demo mode banner (#159), shown on every Marmot page of a demo instance: says that checks are
 * simulated, nothing is sent and the data resets on schedule, with a live countdown to the next
 * reset. The countdown renders after mount only, so the server HTML never disagrees with the
 * client clock.
 */
export function DemoBanner({ intervalMinutes, nextResetAt }: DemoBannerProps) {
  const t = useTranslations('shell.demo')
  const format = useFormatter()
  const [now, setNow] = React.useState<number | null>(null)

  React.useEffect(() => {
    const tick = () => setNow(Date.now())
    tick()
    const timer = setInterval(tick, 15_000)
    return () => clearInterval(timer)
  }, [])

  const next = nextResetAt ? new Date(nextResetAt) : null
  let countdown: string | null = null
  if (next && now !== null) {
    countdown =
      next.getTime() <= now
        ? t('resetting')
        : t('nextReset', { time: format.relativeTime(next, now) })
  }

  return (
    <div
      role="status"
      data-testid="demo-banner"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-status-pending/40 bg-status-pending/10 px-4 py-2 text-center text-sm"
    >
      <FlaskConicalIcon className="size-4 shrink-0 text-status-pending-text" aria-hidden />
      <span className="font-medium">{t('label')}</span>
      <span className="text-muted-foreground">
        {t('description', { minutes: intervalMinutes })}
        {countdown ? ` ${countdown}` : null}
      </span>
    </div>
  )
}
