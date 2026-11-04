import { useTranslations } from 'next-intl'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { hostGraceMs } from '@/lib/host-metrics'
import { humanDuration } from '@/lib/validation/monitor'
import type { Monitor } from '@/payload-types'

import { useMonitorFormat } from './format'
import { HostAgentSnippets } from './host-agent-snippets'

/** What the panel shows of the newest sample. */
export interface HostAgentSeen {
  /** Unix ms of the newest sample. */
  at: number
  hostname: string | null
  os: string | null
  agentVersion: string | null
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/**
 * Host monitor card on the detail page (#136): when the agent last reported, from which machine,
 * the grace period, and copy-ready commands that start the agent with this monitor's token.
 * Renders in server components (non-async).
 */
export function HostAgentPanel({
  monitor,
  serverUrl,
  seen,
  timeZone,
}: {
  monitor: Monitor
  serverUrl: string
  seen: HostAgentSeen | null
  timeZone: string
}) {
  const t = useTranslations('monitors.host.panel')
  const tDuration = useTranslations('common.duration')
  const format = useMonitorFormat(timeZone)
  const duration = (seconds: number) =>
    humanDuration(seconds, (unit, count) => tDuration(unit, { count }))
  const grace = Math.round(hostGraceMs(monitor) / 1000)

  return (
    <Card className="gap-4" data-testid="host-agent-panel">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Row label={t('lastSample')}>
            <span data-testid="host-agent-last-sample">
              {seen ? format.dateTime(new Date(seen.at).toISOString()) : t('never')}
            </span>
          </Row>
          <Row label={t('host')}>
            <span data-testid="host-agent-hostname">
              {seen?.hostname ?? '–'}
              {seen?.os ? <span className="text-muted-foreground"> · {seen.os}</span> : null}
            </span>
          </Row>
          <Row label={t('agentVersion')}>{seen?.agentVersion ?? '–'}</Row>
          <Row label={t('downAfter')}>
            {t('downAfterValue', { interval: duration(monitor.interval), grace: duration(grace) })}
          </Row>
        </dl>
        {monitor.pushToken && <HostAgentSnippets serverUrl={serverUrl} token={monitor.pushToken} />}
      </CardContent>
    </Card>
  )
}
