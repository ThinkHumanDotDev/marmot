import { useFormatter, useTranslations } from 'next-intl'

import {
  TIMING_PHASES,
  timingTotal,
  type RequestTiming,
  type TimingPhase,
} from '@/lib/request-timing'
import { cn } from '@/lib/utils'

/** Phase colours (theme tokens in `styles.css`), shared by the waterfall and the phase chart. */
export const TIMING_PHASE_COLORS: Record<TimingPhase, string> = {
  dns: 'var(--timing-dns)',
  connect: 'var(--timing-connect)',
  tls: 'var(--timing-tls)',
  ttfb: 'var(--timing-ttfb)',
  transfer: 'var(--timing-transfer)',
}

/** `12.3 ms` with the named `milliseconds` format. */
export function useFormatPhase() {
  const t = useTranslations('monitors.timing')
  const format = useFormatter()
  return (ms: number | null) =>
    ms === null ? t('notApplicable') : t('ms', { ms: format.number(ms, 'milliseconds') })
}

/**
 * Waterfall of one check's request phases (#94): one row per phase, each bar starting where the
 * previous phase ended. Phases that did not apply (no TLS, a reused connection) show as n/a.
 * Reused by the latest-check card, the check result and the per-check log (#97).
 */
export function TimingWaterfall({
  timing,
  ping,
  className,
}: {
  timing: RequestTiming
  /** Total response time of the check, for the "add up to" line; omitted when unknown. */
  ping?: number | null
  className?: string
}) {
  const t = useTranslations('monitors.timing')
  const formatPhase = useFormatPhase()
  const total = timingTotal(timing)
  const scale = Math.max(total, ping ?? 0) || 1
  // Each phase starts where the previous measured ones ended.
  const rows = TIMING_PHASES.map((phase, index) => ({
    phase,
    value: timing[phase],
    start: TIMING_PHASES.slice(0, index).reduce((sum, p) => sum + (timing[p] ?? 0), 0),
  }))

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="timing-waterfall">
      <ul className="flex flex-col gap-1.5" aria-label={t('waterfallLabel')}>
        {rows.map(({ phase, value, start }) => {
          return (
            <li
              key={phase}
              className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-3 text-xs"
              data-phase={phase}
            >
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: TIMING_PHASE_COLORS[phase] }}
                />
                {t(`phases.${phase}`)}
              </span>
              <span className="relative h-2.5 rounded-full bg-muted/60" aria-hidden>
                {value !== null && (
                  <span
                    className="absolute inset-y-0 min-w-0.5 rounded-full"
                    style={{
                      left: `${(start / scale) * 100}%`,
                      width: `${(value / scale) * 100}%`,
                      background: TIMING_PHASE_COLORS[phase],
                    }}
                  />
                )}
              </span>
              <span
                className={cn('text-right tabular-nums', value === null && 'text-muted-foreground')}
              >
                {formatPhase(value)}
              </span>
            </li>
          )
        })}
      </ul>
      {typeof ping === 'number' && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('total', { total: formatPhase(total), ping: formatPhase(ping) })}
        </p>
      )}
    </div>
  )
}
