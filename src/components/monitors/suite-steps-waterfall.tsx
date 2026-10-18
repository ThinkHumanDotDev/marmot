'use client'

import { CheckCircle2, ChevronRight, MinusCircle, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/components/ui/badge'
import { parseRequestTiming } from '@/lib/request-timing'
import { cn } from '@/lib/utils'
import type { SuiteStepResult } from '@/lib/validation/http-suite'

import { AssertionResultsCard } from './assertion-results-card'
import { TimingWaterfall, useFormatPhase } from './timing-waterfall'

const BAR_CLASS: Record<SuiteStepResult['outcome'], string> = {
  passed: 'bg-status-up',
  failed: 'bg-destructive',
  skipped: 'bg-muted-foreground/40',
}

/**
 * Waterfall of a multi-step API check (#138): one row per step, its bar placed where the step
 * started within the suite and as long as it took. A row opens to show the step's message, timing
 * phases and assertion results. Everything shown was redacted by the worker before it was stored.
 */
export function SuiteStepsWaterfall({
  steps,
  className,
}: {
  steps: SuiteStepResult[]
  className?: string
}) {
  const t = useTranslations('monitors.logs.steps')
  const formatMs = useFormatPhase()
  const scale = Math.max(1, ...steps.map((step) => step.start + step.duration))

  return (
    <ol className={cn('flex flex-col gap-1', className)} data-testid="suite-waterfall">
      {steps.map((step, index) => {
        const timing = parseRequestTiming(step.timing)
        const assertions = step.assertions.filter((result) => !result.legacy || !result.passed)
        return (
          <li key={`${step.key}-${index}`} data-outcome={step.outcome} data-testid="suite-step-row">
            <details className="group rounded-md border">
              <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_minmax(4rem,30%)_4.5rem] items-center gap-2 px-2 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-1">
                  <ChevronRight className="size-3 text-muted-foreground transition-transform group-open:rotate-90" />
                  {step.outcome === 'passed' ? (
                    <CheckCircle2 className="size-4 text-status-up-text" aria-label={t('passed')} />
                  ) : step.outcome === 'failed' ? (
                    <XCircle className="size-4 text-destructive" aria-label={t('failed')} />
                  ) : (
                    <MinusCircle
                      className="size-4 text-muted-foreground"
                      aria-label={t('skipped')}
                    />
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}.</span>
                  <span className="truncate font-medium">{step.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {step.method}
                  </span>
                  {step.statusCode !== null && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {step.statusCode}
                    </Badge>
                  )}
                  {step.alwaysRun && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {t('cleanup')}
                    </Badge>
                  )}
                </span>
                <span className="relative h-2.5 rounded-full bg-muted/60" aria-hidden>
                  {step.outcome !== 'skipped' && (
                    <span
                      className={cn(
                        'absolute inset-y-0 min-w-0.5 rounded-full',
                        BAR_CLASS[step.outcome],
                      )}
                      style={{
                        left: `${(step.start / scale) * 100}%`,
                        width: `${(step.duration / scale) * 100}%`,
                      }}
                    />
                  )}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {step.outcome === 'skipped' ? t('skipped') : formatMs(step.duration)}
                </span>
              </summary>
              <div className="flex flex-col gap-3 border-t px-3 py-2 text-xs">
                <p className="font-mono break-all text-muted-foreground">
                  {step.method} {step.url}
                </p>
                {step.msg && <p className="break-words">{step.msg}</p>}
                {step.stored.length > 0 && (
                  <p className="text-muted-foreground">
                    {t('stored', { names: step.stored.join(', ') })}
                  </p>
                )}
                {timing && <TimingWaterfall timing={timing} ping={step.duration} />}
                {assertions.length > 0 && <AssertionResultsCard results={assertions} />}
              </div>
            </details>
          </li>
        )
      })}
    </ol>
  )
}
