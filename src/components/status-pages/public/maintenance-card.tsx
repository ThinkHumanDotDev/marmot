'use client'

import { Wrench } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import type { PublicMaintenance } from '@/server/maintenance/status-page'

import { useVisitorTimeZone } from './visitor-time-zone'

const prose =
  'prose-sm max-w-none text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5'

/**
 * A maintenance window on the public page (Uptime Kuma shows running ones above the groups): its
 * state, planned window, description and update timeline (#154). Running windows are highlighted,
 * upcoming ones dashed, finished ones muted until they leave the page.
 */
export function MaintenanceCard({
  item,
  href,
}: {
  item: PublicMaintenance
  /** Permalink; the title links to it. */
  href?: string
}) {
  const legacy = useTranslations('statusPages.maintenance')
  const t = useTranslations('statusPages.public.maintenance')
  const format = useFormatter()
  const visitorZone = useVisitorTimeZone()
  const running = item.status === 'under-maintenance'
  const finished = item.status === 'completed' || item.status === 'cancelled'
  // Upcoming windows are shown in the visitor's time zone (with its name) once the page is
  // hydrated; the server renders the organization's zone.
  const zone = item.status === 'scheduled' ? visitorZone : null
  const when = (date: string) =>
    zone
      ? format.dateTime(new Date(date), 'zoned', { timeZone: zone })
      : format.dateTime(new Date(date), 'short')
  // `dateTimeRange` collapses the date when both ends fall on the same day.
  const period = !item.start
    ? ''
    : item.end
      ? zone
        ? format.dateTimeRange(new Date(item.start), new Date(item.end), 'zoned', {
            timeZone: zone,
          })
        : format.dateTimeRange(new Date(item.start), new Date(item.end), 'short')
      : legacy('from', { start: when(item.start) })
  const finishedAt = item.completedAt ?? item.cancelledAt
  return (
    <article
      data-maintenance-status={item.status}
      data-maintenance-state={item.state}
      className={cn(
        'rounded-xl border px-5 py-4',
        running
          ? 'border-status-maintenance/40 bg-status-maintenance/10'
          : finished
            ? 'border-border bg-muted/30'
            : 'border-dashed border-status-maintenance/40 bg-card',
      )}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="inline-flex items-center gap-2 text-base font-semibold">
          <Wrench
            className={cn('size-4', finished ? 'text-muted-foreground' : 'text-status-maintenance')}
            aria-hidden
          />
          {href ? (
            <a href={href} className="underline-offset-4 hover:underline" data-permalink>
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </h3>
        <span className="text-xs font-medium text-muted-foreground">
          {t(`state.${item.state}`)}
        </span>
      </header>
      {item.start && (
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          <time dateTime={item.start} data-visitor-time-zone={zone ?? undefined}>
            {period}
          </time>
          {item.timezone && !zone && <span className="ml-1">({item.timezone})</span>}
          {finishedAt && (
            <span className="ml-2">
              ·{' '}
              {t(item.state === 'cancelled' ? 'cancelledAt' : 'completedAt', {
                time: format.dateTime(new Date(finishedAt), 'short'),
              })}
            </span>
          )}
        </p>
      )}
      {item.description && (
        <div
          className={cn('mt-2', prose)}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.description) }}
        />
      )}
      {item.updates.length > 0 && (
        <section aria-label={t('updates')} className="mt-3">
          <MaintenanceUpdates updates={item.updates} />
        </section>
      )}
    </article>
  )
}

/** The update timeline of a maintenance window, newest first. */
export function MaintenanceUpdates({ updates }: { updates: PublicMaintenance['updates'] }) {
  const t = useTranslations('statusPages.public.maintenance')
  const format = useFormatter()
  return (
    <ol className="flex flex-col gap-2 border-l border-status-maintenance/30 pl-3">
      {updates.map((update) => (
        <li key={update.id} data-update-status={update.status}>
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-medium">{t(`state.${update.status}`)}</span>
            <time dateTime={update.postedAt} className="text-muted-foreground tabular-nums">
              {format.dateTime(new Date(update.postedAt), 'short')}
            </time>
          </p>
          {update.message ? (
            <div
              className={prose}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(update.message) }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t(`defaultMessage.${update.status}`)}</p>
          )}
        </li>
      ))}
    </ol>
  )
}
