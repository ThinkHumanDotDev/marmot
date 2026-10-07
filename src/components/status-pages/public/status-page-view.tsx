'use client'

import { ExternalLink, Rss, Wrench } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { BeatBar } from '@/components/status-pages/beat-bar'
import { StatusDot } from '@/components/status-dot'
import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import type { PublicMaintenance } from '@/server/maintenance/status-page'
import type {
  OverallStatus,
  PublicIncident,
  PublicMonitor,
  PublicStatusPageData,
} from '@/server/status-pages/public'

const overallStyles: Record<OverallStatus, { dot: string; banner: string }> = {
  up: { dot: 'bg-status-up', banner: 'border-status-up/40 bg-status-up/10' },
  partial: { dot: 'bg-status-pending', banner: 'border-status-pending/50 bg-status-pending/10' },
  down: { dot: 'bg-status-down', banner: 'border-status-down/40 bg-status-down/10' },
  maintenance: {
    dot: 'bg-status-maintenance',
    banner: 'border-status-maintenance/40 bg-status-maintenance/10',
  },
  unknown: { dot: 'bg-muted-foreground/50', banner: 'border-border bg-muted/40' },
}

export const incidentStyles: Record<PublicIncident['style'], string> = {
  info: 'border-status-maintenance/40 bg-status-maintenance/10',
  warning: 'border-status-pending/50 bg-status-pending/10',
  danger: 'border-status-down/40 bg-status-down/10',
  primary: 'border-primary/40 bg-primary/10',
}

type Formatter = ReturnType<typeof useFormatter>

/** `99.98%`, or `100%` once the value rounds to it (Uptime Kuma shows 100 without decimals). */
export const formatUptime = (format: Formatter, value: number): string => {
  const fraction = Math.max(0, Math.min(1, value))
  return fraction >= 0.99995 ? format.number(1, 'wholePercent') : format.number(fraction, 'percent')
}

function OverallBanner({ status }: { status: OverallStatus }) {
  const t = useTranslations('statusPages.overall')
  const style = overallStyles[status]
  return (
    <div
      data-overall={status}
      className={cn(
        'flex items-center gap-3 rounded-xl border px-5 py-4 text-base font-medium',
        style.banner,
      )}
      role="status"
    >
      <span className={cn('size-3 shrink-0 rounded-full', style.dot)} aria-hidden />
      {t(status)}
    </div>
  )
}

export function IncidentCard({ incident }: { incident: PublicIncident }) {
  const format = useFormatter()
  return (
    <article
      data-incident-style={incident.style}
      className={cn('rounded-xl border px-5 py-4', incidentStyles[incident.style])}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold">{incident.title}</h3>
        <time dateTime={incident.updatedAt} className="text-xs text-muted-foreground">
          {format.dateTime(new Date(incident.updatedAt), 'short')}
        </time>
      </header>
      {incident.content && (
        <div
          className="prose-sm mt-2 max-w-none text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(incident.content) }}
        />
      )}
    </article>
  )
}

/** Banner for a running or upcoming maintenance window (Uptime Kuma shows these above the groups). */
export function MaintenanceCard({ item }: { item: PublicMaintenance }) {
  const t = useTranslations('statusPages.maintenance')
  const format = useFormatter()
  const running = item.status === 'under-maintenance'
  // `dateTimeRange` collapses the date when both ends fall on the same day.
  const period = !item.start
    ? ''
    : item.end
      ? format.dateTimeRange(new Date(item.start), new Date(item.end), 'short')
      : t('from', { start: format.dateTime(new Date(item.start), 'short') })
  return (
    <article
      data-maintenance-status={item.status}
      className={cn(
        'rounded-xl border px-5 py-4',
        running
          ? 'border-status-maintenance/40 bg-status-maintenance/10'
          : 'border-dashed border-status-maintenance/40 bg-card',
      )}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="inline-flex items-center gap-2 text-base font-semibold">
          <Wrench className="size-4 text-status-maintenance" aria-hidden />
          {item.title}
        </h3>
        <span className="text-xs font-medium text-muted-foreground">
          {running ? t('inProgress') : t('scheduled')}
        </span>
      </header>
      {item.start && (
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          <time dateTime={item.start}>{period}</time>
          {item.timezone && <span className="ml-1">({item.timezone})</span>}
        </p>
      )}
      {item.description && (
        <div
          className="prose-sm mt-2 max-w-none text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.description) }}
        />
      )}
    </article>
  )
}

function MonitorRow({ monitor }: { monitor: PublicMonitor }) {
  const t = useTranslations('statusPages.monitors')
  const format = useFormatter()
  const name = monitor.url ? (
    <a
      href={monitor.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
    >
      {monitor.name}
      <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
    </a>
  ) : (
    <span className="font-medium">{monitor.name}</span>
  )

  return (
    <li
      data-monitor-id={monitor.id}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[auto_minmax(0,14rem)_minmax(0,1fr)_auto]"
    >
      <StatusDot status={monitor.status} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        {monitor.tags && monitor.tags.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {monitor.tags.map((tag, i) => (
              <span
                key={`${tag.name}-${i}`}
                className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                style={tag.color ? { borderColor: tag.color, color: tag.color } : undefined}
              >
                {tag.name}
                {tag.value ? `: ${tag.value}` : ''}
              </span>
            ))}
          </span>
        )}
      </div>
      <BeatBar beats={monitor.beats} className="col-span-2 sm:col-span-1" />
      <dl className="col-span-2 flex gap-4 text-xs text-muted-foreground tabular-nums sm:col-span-1 sm:flex-col sm:gap-0 sm:text-right">
        <div>
          <dt className="sr-only">{t('uptime24h')}</dt>
          <dd>
            <span className="font-medium text-foreground">
              {formatUptime(format, monitor.uptime24h)}
            </span>{' '}
            {t('window24h')}
          </dd>
        </div>
        <div>
          <dt className="sr-only">{t('uptime30d')}</dt>
          <dd>
            <span className="font-medium text-foreground">
              {formatUptime(format, monitor.uptime30d)}
            </span>{' '}
            {t('window30d')}
          </dd>
        </div>
      </dl>
    </li>
  )
}

interface StatusPageViewProps {
  slug: string
  initial: PublicStatusPageData
}

/**
 * The whole public status page. Server-rendered with `initial`, then — when the page's
 * `autoRefreshInterval` is non-zero — re-fetched from the public API on that interval.
 */
export function StatusPageView({ slug, initial }: StatusPageViewProps) {
  const t = useTranslations('statusPages')
  const format = useFormatter()
  const [data, setData] = React.useState(initial)
  const [refreshing, setRefreshing] = React.useState(false)
  const interval = data.config.autoRefreshInterval

  React.useEffect(() => {
    if (!interval || interval <= 0) return
    let cancelled = false
    const tick = async () => {
      if (document.visibilityState === 'hidden') return
      setRefreshing(true)
      try {
        const res = await fetch(`/api/status-pages/${encodeURIComponent(slug)}/public`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
        // Access ended (password changed, viewer revoked, cookie expired, network left): the
        // server sends the sign-in or restricted screen.
        if (res.status === 401 || res.status === 403) return window.location.reload()
        if (res.ok && !cancelled) setData((await res.json()) as PublicStatusPageData)
      } catch {
        // keep showing the last good payload
      } finally {
        if (!cancelled) setRefreshing(false)
      }
    }
    const id = window.setInterval(tick, Math.max(5, interval) * 1000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [slug, interval])

  const { config, groups, incidents, overall, maintenance } = data
  const pinned = incidents.filter((i) => i.pinned)
  const others = incidents.filter((i) => !i.pinned)
  const feedHref = `/status/${encodeURIComponent(slug)}/rss`

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex items-start gap-4">
        {config.logo && (
          // eslint-disable-next-line @next/next/no-img-element -- user upload, arbitrary size
          <img
            src={config.logo}
            alt=""
            className="size-14 shrink-0 rounded-lg object-contain"
            width={56}
            height={56}
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{config.title}</h1>
          {config.description && (
            <p className="mt-1 text-sm text-muted-foreground sm:text-base">{config.description}</p>
          )}
        </div>
      </header>

      <OverallBanner status={overall} />

      {maintenance.length > 0 && (
        <section aria-label={t('sections.maintenance')} className="flex flex-col gap-3">
          {maintenance.map((item) => (
            <MaintenanceCard key={item.id} item={item} />
          ))}
        </section>
      )}

      {pinned.length > 0 && (
        <section aria-label={t('sections.incidents')} className="flex flex-col gap-3">
          {pinned.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </section>
      )}

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
          {t('monitors.empty')}
        </p>
      ) : (
        <section aria-label={t('sections.services')} className="flex flex-col gap-4">
          {groups.map((group, i) => (
            <div
              key={`${group.name}-${i}`}
              data-group={group.name}
              className="rounded-xl border bg-card px-5 py-4 shadow-sm"
            >
              <h2 className="text-sm font-semibold tracking-tight">{group.name}</h2>
              {group.monitors.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">{t('monitors.emptyGroup')}</p>
              ) : (
                <ul className="divide-y">
                  {group.monitors.map((monitor) => (
                    <MonitorRow key={monitor.id} monitor={monitor} />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}

      {others.length > 0 && (
        <section aria-label={t('sections.otherIncidents')} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">
            {t('sections.ongoingIncidents')}
          </h2>
          {others.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </section>
      )}

      <footer className="flex flex-col gap-3 border-t pt-6 text-xs text-muted-foreground">
        {config.footerText && (
          <div
            className="[&_a]:underline"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(config.footerText) }}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {refreshing
              ? t('footer.refreshing')
              : t('footer.updated', {
                  time: format.dateTime(new Date(data.generatedAt), 'zoned'),
                })}
            {interval > 0 && ` · ${t('footer.refreshEvery', { seconds: interval })}`}
          </span>
          <span className="flex items-center gap-3">
            <a href={feedHref} className="inline-flex items-center gap-1 hover:text-foreground">
              <Rss className="size-3.5" aria-hidden /> {t('footer.rss')}
            </a>
            {config.showPoweredBy && (
              <a
                href="https://github.com/ThinkHumanDotDev/marmot"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
              >
                {t('footer.poweredBy')}
              </a>
            )}
          </span>
        </div>
      </footer>
    </div>
  )
}
