'use client'

import { ArrowLeft, Wrench } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type * as React from 'react'

import { renderMarkdown } from '@/lib/markdown'
import { EVENTS_PATH } from '@/lib/status-page-events'
import { cn } from '@/lib/utils'
import type { PublicMaintenance } from '@/server/maintenance/status-page'
import type { PublicEventSummary } from '@/server/status-pages/event-summary'
import type { PublicConfig, PublicIncident } from '@/server/status-pages/public'

import { CopyLinkButton } from './copy-link-button'
import { useEventDuration, useEventStatusLabel } from './event-list'
import { MaintenanceUpdates } from './maintenance-card'
import { StatusPageShell } from './page-shell'
import { ImpactBadge, IncidentUpdateEntry, MARKDOWN_CLASS } from './parts'
import { useVisitorTimeZone } from './visitor-time-zone'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  )
}

/** Title, status, times, duration, impact and affected components of an event. */
function EventHeader({
  summary,
  icon,
  timeZone,
  now,
}: {
  summary: PublicEventSummary
  /** ISO time the page was rendered (the end of an ongoing event's duration). */
  now: string
  icon?: React.ReactNode
  /** Format times in this zone (upcoming maintenance: the visitor's). */
  timeZone?: string | null
}) {
  const t = useTranslations('statusPages.events')
  const format = useFormatter()
  const duration = useEventDuration()
  const statusLabel = useEventStatusLabel()
  const when = (iso: string) =>
    timeZone
      ? format.dateTime(new Date(iso), 'zoned', { timeZone })
      : format.dateTime(new Date(iso), 'zoned')
  const cancelled = summary.status === 'cancelled'
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t(`kind.${summary.kind}`)}
          </p>
          <h1 className="mt-1 inline-flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {icon}
            {summary.title}
          </h1>
        </div>
        <CopyLinkButton />
      </div>
      <dl className="grid grid-cols-2 gap-4 rounded-xl border bg-card px-5 py-4 shadow-sm sm:grid-cols-4">
        <Fact label={t('status')}>
          <span data-event-status={summary.status}>{statusLabel(summary)}</span>
        </Fact>
        <Fact label={t('started')}>
          <time dateTime={summary.start} data-visitor-time-zone={timeZone ?? undefined}>
            {when(summary.start)}
          </time>
        </Fact>
        <Fact
          label={
            cancelled ? t('cancelled') : summary.kind === 'incident' ? t('resolved') : t('ended')
          }
        >
          {summary.end ? (
            <time dateTime={summary.end}>{when(summary.end)}</time>
          ) : (
            <span className="text-muted-foreground">{t('ongoing')}</span>
          )}
        </Fact>
        <Fact label={t('duration')}>
          {cancelled ? (
            <span className="text-muted-foreground">{t('notApplicable')}</span>
          ) : (
            <span data-event-duration>{duration(summary.start, summary.end ?? now)}</span>
          )}
        </Fact>
      </dl>
      {(summary.impact || summary.components.length > 0) && (
        <div className="flex flex-col gap-2">
          {summary.impact && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('impact')}</span>
              <ImpactBadge impact={summary.impact} />
            </p>
          )}
          <p className="flex flex-wrap items-center gap-2 text-sm" data-affected-components>
            <span className="text-muted-foreground">{t('affectedComponents')}</span>
            {summary.components.length > 0 ? (
              summary.components.map((c) => (
                <span
                  key={c.id}
                  className="rounded-full border px-2 py-0.5 text-xs font-medium"
                  data-component-id={c.id}
                >
                  {c.name}
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">{t('noComponents')}</span>
            )}
          </p>
        </div>
      )}
    </header>
  )
}

function BackToHistory({ basePath }: { basePath: string }) {
  const t = useTranslations('statusPages.events')
  return (
    <a
      href={`${basePath}${EVENTS_PATH}`}
      className="-mb-4 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t('historyHeading')}
    </a>
  )
}

/** Permalink page of an incident: its facts and the whole update timeline, newest first. */
export function IncidentEventView({
  config,
  basePath,
  incident,
  summary,
  now,
}: {
  config: PublicConfig
  basePath: string
  incident: PublicIncident
  summary: PublicEventSummary
  now: string
}) {
  const t = useTranslations('statusPages.events')
  return (
    <StatusPageShell config={config} basePath={basePath}>
      <BackToHistory basePath={basePath} />
      <article data-incident-permalink={incident.publicId} className="flex flex-col gap-6">
        <EventHeader summary={summary} now={now} />
        <section aria-labelledby="incident-updates" className="flex flex-col gap-3">
          <h2 id="incident-updates" className="text-sm font-semibold tracking-tight">
            {t('updates')}
          </h2>
          <ol className="flex flex-col gap-4 border-l pl-4">
            {incident.updates.map((update) => (
              <li key={update.id}>
                <IncidentUpdateEntry update={update} />
              </li>
            ))}
          </ol>
        </section>
      </article>
    </StatusPageShell>
  )
}

/** Permalink page of a maintenance window: its facts, description and update timeline. */
export function MaintenanceEventView({
  config,
  basePath,
  maintenance,
  summary,
  now,
}: {
  config: PublicConfig
  basePath: string
  maintenance: PublicMaintenance
  summary: PublicEventSummary
  now: string
}) {
  const t = useTranslations('statusPages.events')
  const format = useFormatter()
  const visitorZone = useVisitorTimeZone()
  const upcoming = maintenance.status === 'scheduled'
  const zone = upcoming ? visitorZone : null
  return (
    <StatusPageShell config={config} basePath={basePath}>
      <BackToHistory basePath={basePath} />
      <article data-maintenance-permalink={maintenance.publicId} className="flex flex-col gap-6">
        <EventHeader
          summary={summary}
          now={now}
          timeZone={zone}
          icon={
            <Wrench
              className={cn(
                'size-5',
                summary.ongoing || upcoming ? 'text-status-maintenance' : 'text-muted-foreground',
              )}
              aria-hidden
            />
          }
        />
        {maintenance.start && (
          <p className="text-sm text-muted-foreground tabular-nums" data-planned-window>
            {t('planned', {
              window: maintenance.end
                ? zone
                  ? format.dateTimeRange(
                      new Date(maintenance.start),
                      new Date(maintenance.end),
                      'zoned',
                      {
                        timeZone: zone,
                      },
                    )
                  : format.dateTimeRange(
                      new Date(maintenance.start),
                      new Date(maintenance.end),
                      'zoned',
                    )
                : zone
                  ? format.dateTime(new Date(maintenance.start), 'zoned', { timeZone: zone })
                  : format.dateTime(new Date(maintenance.start), 'zoned'),
            })}
          </p>
        )}
        {maintenance.description && (
          <div
            className={MARKDOWN_CLASS}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(maintenance.description) }}
          />
        )}
        {maintenance.updates.length > 0 && (
          <section aria-labelledby="maintenance-updates" className="flex flex-col gap-3">
            <h2 id="maintenance-updates" className="text-sm font-semibold tracking-tight">
              {t('updates')}
            </h2>
            <MaintenanceUpdates updates={maintenance.updates} />
          </section>
        )}
      </article>
    </StatusPageShell>
  )
}
