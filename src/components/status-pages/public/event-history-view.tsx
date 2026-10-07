'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { EVENTS_PATH, eventFiltersQuery } from '@/lib/status-page-events'
import type { EventHistory } from '@/server/status-pages/events'
import type { PublicConfig } from '@/server/status-pages/public'

import { EventRow } from './event-list'
import { StatusPageShell } from './page-shell'

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

/** The month (`YYYY-MM`) as text, e.g. "October 2026". Mid-month UTC, so no zone shifts it. */
function useMonthLabel() {
  const format = useFormatter()
  return (month: string) =>
    format.dateTime(new Date(`${month}-15T12:00:00Z`), {
      year: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    })
}

/**
 * `/status/:slug/events`: every incident and maintenance window, newest first and grouped by
 * month, with filters (a plain GET form, so it works without JavaScript; selects submit on change
 * when it runs) and pagination links.
 */
export function EventHistoryView({
  config,
  basePath,
  history,
  monthOf,
}: {
  config: PublicConfig
  basePath: string
  history: EventHistory
  /** `YYYY-MM` of each listed event's start in the organization's zone, by public id. */
  monthOf: Record<string, string>
}) {
  const t = useTranslations('statusPages.events')
  const monthLabel = useMonthLabel()
  const action = `${basePath}${EVENTS_PATH}`
  const { filters } = history
  const filtered = Boolean(filters.type || filters.component || filters.month)
  const pageHref = (page: number) => {
    const query = eventFiltersQuery({ ...filters, page })
    return query ? `${action}?${query}` : action
  }

  const groups: { month: string; events: EventHistory['events'] }[] = []
  for (const event of history.events) {
    const month = monthOf[`${event.kind}:${event.publicId}`] ?? event.start.slice(0, 7)
    const last = groups.at(-1)
    if (last?.month === month) last.events.push(event)
    else groups.push({ month, events: [event] })
  }

  const submitOnChange = (event: React.ChangeEvent<HTMLSelectElement>) =>
    event.currentTarget.form?.requestSubmit()

  return (
    <StatusPageShell config={config} basePath={basePath}>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('historyHeading')}</h1>
        <p className="text-sm text-muted-foreground">{t('historyDescription')}</p>
      </div>

      <form
        method="get"
        action={action}
        role="search"
        aria-label={t('filters.label')}
        className="grid gap-3 rounded-xl border bg-card px-5 py-4 shadow-sm sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
      >
        <label className="grid gap-1.5 text-xs font-medium">
          {t('filters.type')}
          <select
            name="type"
            defaultValue={filters.type ?? ''}
            onChange={submitOnChange}
            className={selectClass}
          >
            <option value="">{t('filters.allTypes')}</option>
            <option value="incident">{t('filters.incidents')}</option>
            <option value="maintenance">{t('filters.maintenance')}</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium">
          {t('filters.component')}
          <select
            name="component"
            defaultValue={filters.component ?? ''}
            onChange={submitOnChange}
            className={selectClass}
          >
            <option value="">{t('filters.allComponents')}</option>
            {history.components.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium">
          {t('filters.month')}
          <select
            name="month"
            defaultValue={filters.month ?? ''}
            onChange={submitOnChange}
            className={selectClass}
          >
            <option value="">{t('filters.allMonths')}</option>
            {history.months.map((month) => (
              <option key={month} value={month}>
                {monthLabel(month)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" className="h-9">
            {t('filters.apply')}
          </Button>
          {filtered && (
            <Button asChild size="sm" variant="ghost" className="h-9">
              <a href={action}>{t('filters.reset')}</a>
            </Button>
          )}
        </div>
      </form>

      <p className="-mt-4 text-xs text-muted-foreground" aria-live="polite" data-event-count>
        {t('eventCount', { count: history.totalEvents })}
      </p>

      {groups.length === 0 ? (
        <p
          className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground"
          data-history-empty
        >
          {filtered ? t('emptyFiltered') : t('empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section
              key={group.month}
              aria-labelledby={`month-${group.month}`}
              data-month={group.month}
            >
              <h2 id={`month-${group.month}`} className="text-sm font-semibold tracking-tight">
                {monthLabel(group.month)}
              </h2>
              <div className="mt-2 divide-y rounded-xl border bg-card px-5 shadow-sm">
                {group.events.map((event) => (
                  <EventRow
                    key={`${event.kind}-${event.publicId}`}
                    event={event}
                    basePath={basePath}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {history.totalPages > 1 && (
        <nav aria-label={t('pagination.label')} className="flex items-center justify-between gap-2">
          {history.page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <a href={pageHref(history.page - 1)} rel="prev">
                <ChevronLeft className="size-4" aria-hidden />
                {t('pagination.newer')}
              </a>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground">
            {t('pagination.page', { page: history.page, total: history.totalPages })}
          </span>
          {history.page < history.totalPages ? (
            <Button asChild variant="outline" size="sm">
              <a href={pageHref(history.page + 1)} rel="next">
                {t('pagination.older')}
                <ChevronRight className="size-4" aria-hidden />
              </a>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      )}
    </StatusPageShell>
  )
}
