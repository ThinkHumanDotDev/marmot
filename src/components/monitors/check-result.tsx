'use client'

import { ShieldAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import type { OnDemandCheckResult } from '@/lib/on-demand-check'
import { parseRequestTiming } from '@/lib/request-timing'
import { cn } from '@/lib/utils'

import { AssertionResultsCard, parseAssertionResults } from './assertion-results-card'
import { useMonitorFormat } from './format'
import { MonitorStatusBadge } from './status-badge'
import { TimingWaterfall } from './timing-waterfall'

const show = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/** One on-demand check result ("Check now" or the form's "Test"). */
export function CheckResultView({
  result,
  className,
}: {
  result: OnDemandCheckResult
  className?: string
}) {
  const t = useTranslations('monitors.check')
  const format = useFormatter()
  const { ping } = useMonitorFormat()
  const assertions = parseAssertionResults(result.assertions)
  const timing = parseRequestTiming(result.timing)
  const extra = Object.entries(result.details ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  )

  return (
    <div className={cn('flex flex-col gap-4', className)} data-testid="check-result">
      <div className="flex flex-wrap items-center gap-2">
        <MonitorStatusBadge status={result.status} />
        {result.statusCode !== null && (
          <span className="font-mono text-xs text-muted-foreground">
            {t('httpStatus', { code: result.statusCode })}
          </span>
        )}
      </div>

      {result.blocked && (
        <p className="flex items-start gap-2 rounded-md border border-status-down/40 bg-status-down/10 px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('blocked')}
        </p>
      )}
      {result.maintenance && <p className="text-sm text-muted-foreground">{t('maintenance')}</p>}

      <dl className="flex flex-col gap-2">
        <Row label={t('message')}>
          <span data-testid="check-result-message">{result.msg || t('noMessage')}</span>
        </Row>
        <Row label={t('responseTime')}>{ping(result.ping)}</Row>
        <Row label={t('took')}>{t('milliseconds', { ms: result.elapsedMs })}</Row>
        <Row label={t('checkedAt')}>{format.dateTime(new Date(result.startedAt), 'precise')}</Row>
        {result.tls && (
          <Row label={t('certificate')}>
            {result.tls.valid
              ? t('certificateValid', { days: result.tls.daysRemaining ?? 0 })
              : t('certificateInvalid')}
            {result.tls.subject && (
              <span className="block font-mono text-xs text-muted-foreground">
                {result.tls.subject}
              </span>
            )}
          </Row>
        )}
        {extra.map(([key, value]) => (
          <Row key={key} label={key}>
            <code className="text-xs">{show(value)}</code>
          </Row>
        ))}
      </dl>

      {timing && (
        <section className="flex flex-col gap-2" aria-labelledby="check-result-timing">
          <h3 id="check-result-timing" className="text-sm font-medium">
            {t('timing')}
          </h3>
          <TimingWaterfall timing={timing} ping={result.ping} />
        </section>
      )}

      {assertions.length > 0 && <AssertionResultsCard results={assertions} />}

      <p className="text-xs text-muted-foreground">
        {result.recorded ? t('recorded') : t('notRecorded')}
      </p>
    </div>
  )
}
