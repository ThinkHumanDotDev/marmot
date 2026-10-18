'use client'

import { CheckCircle2, Download, XCircle } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import type { BrowserCheckDetails, BrowserWebVitals } from '@/lib/browser-script'

const VITALS: (keyof BrowserWebVitals)[] = ['ttfb', 'fcp', 'lcp', 'cls', 'domContentLoaded', 'load']

function Section({
  title,
  children,
  testId,
}: {
  title: string
  children: React.ReactNode
  testId?: string
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

/**
 * What a Browser Script check saw (#139): its steps with timing, console errors, failed requests,
 * the script's own output, Web Vitals, and the screenshot and trace (stored with recorded checks,
 * the screenshot inline for "Run now").
 */
export function BrowserCheckDetailsView({ details }: { details: BrowserCheckDetails }) {
  const t = useTranslations('monitors.browser')
  const format = useFormatter()
  const ms = (value: number | null) =>
    value === null ? '—' : `${format.number(value, 'integer')} ms`
  const screenshot =
    details.artifacts?.find((artifact) => artifact.kind === 'screenshot')?.url ??
    details.screenshotDataUrl ??
    null
  const trace = details.artifacts?.find((artifact) => artifact.kind === 'trace') ?? null
  const vitals = details.webVitals
  const shownVitals = vitals ? VITALS.filter((key) => vitals[key] !== null) : []

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="browser-check-details">
      <Section title={t('steps')} testId="browser-steps">
        {details.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noSteps')}</p>
        ) : (
          <ol className="flex flex-col gap-1 text-sm">
            {details.steps.map((step, index) => (
              <li
                key={index}
                className="flex min-w-0 items-start gap-2"
                style={{ paddingLeft: `${step.depth * 1.25}rem` }}
                data-testid="browser-step"
              >
                {step.error ? (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                ) : (
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-status-up-text"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1 break-words">
                  {step.name}
                  {step.error && (
                    <span className="block font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                      {t('stepFailed', { error: step.error })}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  {ms(step.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {screenshot && (
        <Section title={t('screenshot')} testId="browser-screenshot">
          <a href={screenshot} target="_blank" rel="noreferrer noopener" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element -- access-controlled upload or data URL */}
            <img
              src={screenshot}
              alt={t('screenshotAlt')}
              className="max-h-96 w-auto rounded-md border object-contain object-left-top"
            />
          </a>
        </Section>
      )}

      {trace ? (
        <Section title={t('trace')} testId="browser-trace">
          <a
            href={trace.url}
            download={trace.filename}
            className="inline-flex w-fit items-center gap-2 text-sm underline underline-offset-2"
          >
            <Download className="size-4" aria-hidden />
            {t('downloadTrace', {
              size:
                trace.filesize === null
                  ? '—'
                  : `${format.number(trace.filesize / 1024, 'integer')} KB`,
            })}
          </a>
          <p className="text-xs text-muted-foreground">{t('traceHint')}</p>
        </Section>
      ) : (
        details.screenshotDataUrl && (
          <p className="text-xs text-muted-foreground">{t('inlineHint')}</p>
        )
      )}

      {details.consoleErrors.length > 0 && (
        <Section title={t('consoleErrors')} testId="browser-console-errors">
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {details.consoleErrors.map((line, index) => (
              <li key={index} className="break-words whitespace-pre-wrap">
                {line}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {details.failedRequests.length > 0 && (
        <Section title={t('failedRequests')} testId="browser-failed-requests">
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {details.failedRequests.map((request, index) => (
              <li key={index} className="break-all">
                <span className="text-muted-foreground">{request.method}</span> {request.url}{' '}
                <span className="text-destructive">
                  {request.status !== null
                    ? t('requestStatus', { status: request.status })
                    : request.error}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {details.logs.length > 0 && (
        <Section title={t('logs')} testId="browser-logs">
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
            {details.logs.map((line) => line.text).join('\n')}
          </pre>
        </Section>
      )}

      {vitals && shownVitals.length > 0 && (
        <Section title={t('webVitals')} testId="browser-web-vitals">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {shownVitals.map((key) => (
              <div key={key} className="flex flex-col">
                <dt className="text-xs text-muted-foreground">{t(`vitals.${key}`)}</dt>
                <dd className="font-mono tabular-nums">
                  {key === 'cls' ? format.number(vitals[key] ?? 0, 'ratio') : ms(vitals[key])}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {details.finalUrl && (
        <p className="text-xs break-all text-muted-foreground">
          {t('finalUrl')}: <code>{details.finalUrl}</code>
        </p>
      )}
    </div>
  )
}
