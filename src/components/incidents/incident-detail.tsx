'use client'

import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  incidentDurationSeconds,
  type MonitorIncidentSummary,
  type MonitorIncidentTimelineEntry,
} from '@/lib/monitor-incidents'
import { cn } from '@/lib/utils'

import { IncidentActions, type StatusPageChoice } from './incident-actions'
import { IncidentStatusBadge } from './incident-status-badge'
import { useResponseText } from './incident-list'
import { useDurationText, useIncidentEvents, useNow } from './use-incidents'

interface IncidentDetailProps {
  orgId: string | number
  orgSlug: string
  initial: MonitorIncidentSummary
  canAcknowledge: boolean
  canResolve: boolean
  canPublish: boolean
  statusPages: StatusPageChoice[]
  now: number
}

function useTimelineText() {
  const t = useTranslations('incidents.timeline')
  return (entry: MonitorIncidentTimelineEntry): string => {
    const via = entry.via ? ` ${t(`via.${entry.via}`)}` : ''
    switch (entry.type) {
      case 'opened':
        return t('opened')
      case 'maintenance':
        return t('maintenance')
      case 'acknowledged':
        return (
          (entry.by ? t('acknowledged', { name: entry.by.name }) : t('acknowledgedAnonymous')) +
          (entry.via && entry.via !== 'link' ? via : '')
        )
      case 'resolved':
        if (!entry.by && !entry.via) return t('resolvedAuto')
        return (entry.by ? t('resolved', { name: entry.by.name }) : t('resolvedAnonymous')) + via
      case 'published':
        return entry.by
          ? t('publishedBy', { name: entry.by.name, title: entry.message ?? '' })
          : t('published', { title: entry.message ?? '' })
    }
  }
}

const dotTone: Record<MonitorIncidentTimelineEntry['type'], string> = {
  opened: 'bg-status-down',
  maintenance: 'bg-status-maintenance',
  acknowledged: 'bg-status-pending',
  resolved: 'bg-status-up',
  published: 'bg-primary',
}

/** One incident: facts, actions and timeline; kept live by `monitorIncident` events. */
export function IncidentDetail({
  orgId,
  orgSlug,
  initial,
  canAcknowledge,
  canResolve,
  canPublish,
  statusPages,
  now: serverNow,
}: IncidentDetailProps) {
  const t = useTranslations('incidents.detail')
  const format = useFormatter()
  const duration = useDurationText()
  const response = useResponseText()
  const timelineText = useTimelineText()
  const [incident, setIncident] = React.useState(initial)
  const [seed, setSeed] = React.useState(initial)
  if (seed !== initial) {
    setSeed(initial)
    setIncident(initial)
  }
  useIncidentEvents(orgId, (next) => {
    if (next.id === incident.id) setIncident(next)
  })
  const now = useNow(serverNow, incident.status !== 'resolved')
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), 'precise') : t('notYet')

  const facts: { key: string; label: string; value: React.ReactNode }[] = [
    { key: 'started', label: t('started'), value: when(incident.startedAt) },
    {
      key: 'duration',
      label: t('duration'),
      value: duration(incidentDurationSeconds(incident, now)),
    },
    {
      key: 'acknowledged',
      label: t('acknowledged'),
      value: incident.acknowledgedAt
        ? `${when(incident.acknowledgedAt)} · ${
            incident.acknowledgedBy?.name ?? response({ ...incident, status: 'acknowledged' })
          }`
        : t('notYet'),
    },
    {
      key: 'resolved',
      label: t('resolved'),
      value: incident.resolvedAt
        ? `${when(incident.resolvedAt)} · ${response(incident)}`
        : t('notYet'),
    },
    {
      key: 'reminders',
      label: t('reminders'),
      value: format.number(incident.remindersSent, 'integer'),
    },
  ]

  return (
    <div className="flex flex-col gap-6" data-testid="incident-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <IncidentStatusBadge status={incident.status} />
        <IncidentActions
          orgId={orgId}
          incident={incident}
          canAcknowledge={canAcknowledge}
          canResolve={canResolve}
          canPublish={canPublish}
          statusPages={statusPages}
          onChange={setIncident}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-base">{t('cause')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <p className="break-words text-muted-foreground" data-testid="incident-cause">
              {incident.cause || t('noCause')}
            </p>
            <dl className="grid gap-3">
              {facts.map((fact) => (
                <div key={fact.key} className="grid gap-0.5">
                  <dt className="text-xs font-medium text-muted-foreground">{fact.label}</dt>
                  <dd data-testid={`incident-${fact.key}`}>{fact.value}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-2">
              {incident.monitor && (
                <Link
                  href={`/${orgSlug}/monitors/${incident.monitor.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {t('viewMonitor')}
                </Link>
              )}
              {incident.statusPageIncident?.statusPage && (
                <Link
                  href={`/${orgSlug}/status-pages/${incident.statusPageIncident.statusPage}`}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t('openStatusPage')} <ExternalLink className="size-3" aria-hidden />
                </Link>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-base">{t('timeline')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol
              className="relative flex flex-col gap-5 border-l pl-5"
              data-testid="incident-timeline"
            >
              {incident.timeline.map((entry) => (
                <li key={entry.id} className="relative" data-type={entry.type}>
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full ring-4 ring-card',
                      dotTone[entry.type],
                    )}
                  />
                  <p className="text-sm font-medium">{timelineText(entry)}</p>
                  <p className="text-xs text-muted-foreground">
                    {format.dateTime(new Date(entry.at), 'precise')}
                  </p>
                  {entry.message && entry.type !== 'published' && (
                    <p className="mt-1 text-sm break-words whitespace-pre-wrap text-muted-foreground">
                      {entry.message}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
