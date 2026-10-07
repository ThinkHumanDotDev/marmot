'use client'

import { AlertTriangle, History, Wrench } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import { markdownToText } from '@/lib/markdown'
import { eventPath } from '@/lib/status-page-events'
import { cn } from '@/lib/utils'
import { humanDuration } from '@/lib/validation/monitor'
import type { PublicEventSummary, PublicIncidentDay } from '@/server/status-pages/event-summary'

import { ImpactBadge } from './parts'

/** "2 hours 5 minutes" between two ISO times (minutes once it is a minute or longer). */
export function useEventDuration() {
  const t = useTranslations('common.duration')
  return (start: string, end: string): string => {
    const seconds = Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000)
    const rounded = seconds >= 60 ? Math.round(seconds / 60) * 60 : Math.round(seconds)
    return humanDuration(rounded, (unit, count) => t(unit, { count }))
  }
}

/** Translated status of an event (incident status or maintenance state). */
export function useEventStatusLabel() {
  const t = useTranslations('statusPages.public')
  return (event: Pick<PublicEventSummary, 'kind' | 'status'>): string =>
    event.kind === 'incident'
      ? t(`incidents.status.${event.status as 'investigating'}`)
      : t(`maintenance.state.${event.status as 'scheduled'}`)
}

/** One incident or maintenance window in a list, linking to its permalink. */
export function EventRow({
  event,
  basePath,
  level = 3,
}: {
  event: PublicEventSummary
  basePath: string
  /** Heading level of the title (4 below the main page's day headings). */
  level?: 3 | 4
}) {
  const Heading = level === 4 ? 'h4' : 'h3'
  const t = useTranslations('statusPages.events')
  const format = useFormatter()
  const duration = useEventDuration()
  const statusLabel = useEventStatusLabel()
  const Icon = event.kind === 'incident' ? AlertTriangle : Wrench
  const excerpt = event.latest?.message ? markdownToText(event.latest.message) : ''
  return (
    <article
      data-event-kind={event.kind}
      data-event-id={event.publicId}
      data-event-status={event.status}
      className="flex flex-col gap-1 py-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Heading className="inline-flex min-w-0 items-baseline gap-2 text-sm font-semibold">
          <Icon
            className={cn(
              'size-3.5 shrink-0 translate-y-0.5',
              event.kind === 'incident' ? 'text-status-pending' : 'text-status-maintenance',
            )}
            aria-hidden
          />
          <span className="sr-only">{t(`kind.${event.kind}`)}: </span>
          <a
            href={`${basePath}${eventPath(event.kind, event.publicId)}`}
            className="min-w-0 underline-offset-4 hover:underline"
            data-permalink
          >
            {event.title}
          </a>
        </Heading>
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          {event.impact && event.impact !== 'operational' && <ImpactBadge impact={event.impact} />}
          <span className={cn('font-medium', event.ongoing ? '' : 'text-muted-foreground')}>
            {statusLabel(event)}
          </span>
        </span>
      </header>
      <p className="text-xs text-muted-foreground tabular-nums">
        <time dateTime={event.start}>{format.dateTime(new Date(event.start), 'short')}</time>
        {event.end ? (
          <>
            {' – '}
            <time dateTime={event.end}>{format.dateTime(new Date(event.end), 'short')}</time>
            {event.status !== 'cancelled' && (
              <span className="ml-2">
                · {t('lasted', { duration: duration(event.start, event.end) })}
              </span>
            )}
          </>
        ) : (
          event.ongoing && <span className="ml-2">· {t('ongoing')}</span>
        )}
      </p>
      {event.components.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('affects', { components: event.components.map((c) => c.name).join(', ') })}
        </p>
      )}
      {excerpt && <p className="line-clamp-2 text-sm text-muted-foreground">{excerpt}</p>}
    </article>
  )
}

/**
 * The main page's past incidents: the last `pastIncidentsDays` days, newest first, with "No
 * incidents reported" on quiet days, and the link to the full history.
 */
export function PastIncidents({
  days,
  historyHref,
  basePath,
}: {
  days: PublicIncidentDay[]
  historyHref: string
  basePath: string
}) {
  const t = useTranslations('statusPages.events')
  const format = useFormatter()
  return (
    <section aria-labelledby="past-incidents" className="flex flex-col gap-3" data-past-incidents>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="past-incidents" className="text-sm font-semibold tracking-tight">
          {days.length > 0 ? t('pastIncidents') : t('historyHeading')}
        </h2>
        <a
          href={historyHref}
          data-history-link
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <History className="size-4" aria-hidden />
          {t('viewHistory')}
        </a>
      </div>
      {days.length > 0 && (
        <ol className="flex flex-col divide-y rounded-xl border bg-card px-5 shadow-sm">
          {days.map((day) => (
            <li key={day.date} data-day={day.date} className="py-3">
              <h3 className="text-xs font-semibold text-muted-foreground">
                <time dateTime={day.date}>{format.dateTime(new Date(day.start), 'date')}</time>
              </h3>
              {day.incidents.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">{t('noIncidentsReported')}</p>
              ) : (
                <div className="divide-y">
                  {day.incidents.map((event) => (
                    <EventRow key={event.publicId} event={event} basePath={basePath} level={4} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
