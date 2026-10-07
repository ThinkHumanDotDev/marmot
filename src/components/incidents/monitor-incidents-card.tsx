'use client'

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { incidentDurationSeconds, type MonitorIncidentSummary } from '@/lib/monitor-incidents'

import { IncidentStatusBadge } from './incident-status-badge'
import { useResponseText } from './incident-list'
import { useDurationText, useIncidentEvents, useNow } from './use-incidents'

const LIMIT = 5

/** Last incidents of one monitor on its detail page; new and changed incidents arrive live. */
export function MonitorIncidentsCard({
  orgId,
  orgSlug,
  monitorId,
  initial,
  now: serverNow,
}: {
  orgId: string | number
  orgSlug: string
  monitorId: string
  initial: MonitorIncidentSummary[]
  now: number
}) {
  const t = useTranslations('incidents.monitorCard')
  const tl = useTranslations('incidents.list')
  const format = useFormatter()
  const duration = useDurationText()
  const response = useResponseText()
  const [items, setItems] = React.useState(initial)

  useIncidentEvents(orgId, (incident) => {
    if (incident.monitor?.id !== monitorId) return
    setItems((current) => {
      const rest = current.filter((item) => item.id !== incident.id)
      return [incident, ...rest]
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, LIMIT)
    })
  })
  const now = useNow(
    serverNow,
    items.some((item) => item.status !== 'resolved'),
  )

  return (
    <Card className="gap-3" data-testid="monitor-incidents">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardAction>
          <Link
            href={`/${orgSlug}/incidents?monitor=${encodeURIComponent(monitorId)}&range=all&status=all`}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('viewAll')}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {items.map((incident) => {
              const seconds = incidentDurationSeconds(incident, now)
              return (
                <li key={incident.id}>
                  <Link
                    href={`/${orgSlug}/incidents/${incident.id}`}
                    className="flex flex-col gap-1 py-2 hover:text-foreground"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <IncidentStatusBadge status={incident.status} />
                      <span className="text-xs text-muted-foreground">
                        {format.dateTime(new Date(incident.startedAt), 'short')}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums">
                      {incident.status === 'resolved'
                        ? duration(seconds)
                        : tl('ongoing', { duration: duration(seconds) })}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {response(incident)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
