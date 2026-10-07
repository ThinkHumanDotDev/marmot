'use client'

import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import type { OnDemandCheckResult } from '@/lib/on-demand-check'
import { cn } from '@/lib/utils'

import { useMonitorFormat } from './format'
import { MonitorStatusBadge } from './status-badge'

type Assertion = Record<string, unknown>

const firstString = (item: Assertion, keys: string[]): string | null => {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

const firstBoolean = (item: Assertion, keys: string[]): boolean | null => {
  for (const key of keys) {
    if (typeof item[key] === 'boolean') return item[key] as boolean
  }
  return null
}

const show = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

/**
 * Assertion results reported by the check (`details.assertions`). The shape is deliberately read
 * loosely (`label`/`name`/`path`, `passed`/`ok`, `message`) so richer per-assertion results can
 * land without touching this view.
 */
function AssertionList({ items }: { items: unknown[] }) {
  const t = useTranslations('monitors.check')
  return (
    <ul className="flex flex-col gap-1.5" data-testid="check-result-assertions">
      {items.map((raw, index) => {
        const item: Assertion = raw && typeof raw === 'object' ? (raw as Assertion) : { value: raw }
        const passed = firstBoolean(item, ['passed', 'ok', 'success', 'pass'])
        const label =
          firstString(item, ['label', 'name', 'path', 'type', 'source']) ??
          t('assertionNumber', { number: index + 1 })
        const message =
          firstString(item, ['message', 'msg', 'error', 'reason']) ??
          ('actual' in item || 'expected' in item
            ? t('assertionValues', { actual: show(item.actual), expected: show(item.expected) })
            : null)
        return (
          <li key={index} className="flex items-start gap-2 text-sm">
            {passed === false ? (
              <XCircle className="mt-0.5 size-4 shrink-0 text-status-down" aria-hidden />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-up" aria-hidden />
            )}
            <span className="min-w-0">
              <span className="font-medium">{label}</span>
              {passed !== null && (
                <span className="sr-only">
                  {passed ? t('assertionPassed') : t('assertionFailed')}
                </span>
              )}
              {message && <span className="block text-muted-foreground">{message}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

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
  const { assertions, ...otherDetails } = result.details ?? {}
  const extra = Object.entries(otherDetails).filter(
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

      {Array.isArray(assertions) && assertions.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('assertions')}</p>
          <AssertionList items={assertions} />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {result.recorded ? t('recorded') : t('notRecorded')}
      </p>
    </div>
  )
}
