'use client'

import { ChevronRight, ExternalLink, Info, Mail, Rss } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { BeatBar } from '@/components/status-pages/beat-bar'
import { MaintenanceCard } from '@/components/status-pages/public/maintenance-card'
import { StatusDot } from '@/components/status-dot'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ComponentImpact } from '@/lib/status-page-components'
import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'

import { ThemeToggle } from './theme-toggle'
import type {
  OverallStatus,
  PublicConfig,
  PublicGroup,
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

/**
 * Overall state banner. A custom `text` (the page's banner override) replaces the automatic
 * headline; the colour still follows the monitors and screen readers still hear the real state.
 */
export function OverallBanner({ status, text }: { status: OverallStatus; text?: string | null }) {
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
      {text ? (
        <span data-banner-override>
          {text}
          <span className="sr-only"> ({t(status)})</span>
        </span>
      ) : (
        t(status)
      )}
    </div>
  )
}

/**
 * Light and dark logos, swapped by the `dark` class (CSS only, so it follows the visitor toggle
 * without re-rendering). With a single logo it is shown in both modes.
 */
export function StatusPageLogo({
  config,
  alt = '',
  className,
}: {
  config: Pick<PublicConfig, 'logo' | 'logoDark'>
  alt?: string
  className?: string
}) {
  const { logo, logoDark } = config
  if (!logo && !logoDark) return null
  const img = (src: string, extra?: string, mode?: 'light' | 'dark') => (
    // eslint-disable-next-line @next/next/no-img-element -- user upload, arbitrary size
    <img
      src={src}
      alt={alt}
      data-logo={mode}
      className={cn('size-14 shrink-0 rounded-lg object-contain', className, extra)}
      width={56}
      height={56}
    />
  )
  if (logo && logoDark) {
    return (
      <>
        {img(logo, 'dark:hidden', 'light')}
        {img(logoDark, 'hidden dark:block', 'dark')}
      </>
    )
  }
  return img((logo ?? logoDark)!)
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

const impactStyles: Record<ComponentImpact, string> = {
  operational: 'border-status-up/40 text-status-up',
  degraded_performance: 'border-status-pending/50 text-status-pending',
  partial_outage: 'border-status-pending/50 text-status-pending',
  major_outage: 'border-status-down/40 text-status-down',
}

/** Public component description, revealed on hover or focus of the info icon. */
function DescriptionTooltip({ name, description }: { name: string; description: string }) {
  const t = useTranslations('statusPages.public')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={t('aboutComponent', { name })}
          data-component-description
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-pre-line">{description}</TooltipContent>
    </Tooltip>
  )
}

function MonitorRow({ monitor }: { monitor: PublicMonitor }) {
  const t = useTranslations('statusPages.monitors')
  const tPublic = useTranslations('statusPages.public')
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
  const isStatic = monitor.type === 'static'
  const impact = monitor.impact && monitor.impact !== 'operational' ? monitor.impact : null
  const showValues =
    monitor.showValues && monitor.uptime24h !== undefined && monitor.uptime30d !== undefined

  return (
    <li
      data-monitor-id={monitor.id}
      data-component-id={monitor.componentId ?? undefined}
      data-component-type={monitor.type}
      data-component-status={monitor.status}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[auto_minmax(0,14rem)_minmax(0,1fr)_auto]"
    >
      <StatusDot status={monitor.status} />
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{name}</span>
          {monitor.description && (
            <DescriptionTooltip name={monitor.name} description={monitor.description} />
          )}
        </span>
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
      {isStatic ? (
        <span
          className={cn(
            'col-span-2 text-sm sm:col-span-2 sm:text-right',
            impact ? 'font-medium' : 'text-muted-foreground',
          )}
          data-impact={impact ?? undefined}
        >
          {impact
            ? tPublic(`impact.${impact}`)
            : monitor.status === 'maintenance'
              ? tPublic('componentMaintenance')
              : tPublic('impact.operational')}
        </span>
      ) : (
        <>
          <div className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
            {impact && (
              <span
                data-impact={impact}
                className={cn(
                  'w-fit rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  impactStyles[impact],
                )}
              >
                {tPublic(`impact.${impact}`)}
              </span>
            )}
            <BeatBar beats={monitor.beats} />
          </div>
          {showValues ? (
            <dl className="col-span-2 flex gap-4 text-xs text-muted-foreground tabular-nums sm:col-span-1 sm:flex-col sm:gap-0 sm:text-right">
              <div>
                <dt className="sr-only">{t('uptime24h')}</dt>
                <dd>
                  <span className="font-medium text-foreground">
                    {formatUptime(format, monitor.uptime24h ?? 0)}
                  </span>{' '}
                  {t('window24h')}
                </dd>
              </div>
              <div>
                <dt className="sr-only">{t('uptime30d')}</dt>
                <dd>
                  <span className="font-medium text-foreground">
                    {formatUptime(format, monitor.uptime30d ?? 0)}
                  </span>{' '}
                  {t('window30d')}
                </dd>
              </div>
            </dl>
          ) : (
            <span aria-hidden className="hidden sm:block" />
          )}
        </>
      )}
    </li>
  )
}

/**
 * A group as a collapsible section (WAI-ARIA disclosure: a button inside the heading). The header
 * carries the worst status of the group's components, so a collapsed group still shows problems.
 */
function GroupSection({ group }: { group: PublicGroup }) {
  const t = useTranslations('statusPages')
  const [open, setOpen] = React.useState(group.defaultOpen)
  const contentId = React.useId()
  return (
    <div
      data-group={group.name}
      data-group-status={group.status}
      data-open={open ? 'true' : 'false'}
      className="rounded-xl border bg-card px-5 py-4 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold tracking-tight">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen((value) => !value)}
            className="flex w-full min-w-0 items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronRight
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )}
              aria-hidden
            />
            <span className="truncate">{group.name}</span>
          </button>
        </h2>
        <StatusDot status={group.status} pulse={false} />
      </div>
      <div id={contentId} hidden={!open}>
        {group.monitors.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">{t('monitors.emptyGroup')}</p>
        ) : (
          <ul className="mt-1 divide-y">
            {group.monitors.map((monitor) => (
              <MonitorRow key={`${monitor.type}-${monitor.id}`} monitor={monitor} />
            ))}
          </ul>
        )}
      </div>
    </div>
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
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
        <header className="flex items-start gap-4">
          {(config.logo || config.logoDark) &&
            (config.homepageUrl ? (
              <a href={config.homepageUrl} className="shrink-0" data-homepage-link>
                <StatusPageLogo
                  config={config}
                  alt={t('public.homepage', { title: config.title })}
                />
              </a>
            ) : (
              <StatusPageLogo config={config} />
            ))}
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {config.homepageUrl && !config.logo && !config.logoDark ? (
                <a
                  href={config.homepageUrl}
                  className="underline-offset-4 hover:underline"
                  data-homepage-link
                >
                  {config.title}
                </a>
              ) : (
                config.title
              )}
            </h1>
            {config.description && (
              <p className="mt-1 text-sm text-muted-foreground sm:text-base">
                {config.description}
              </p>
            )}
          </div>
          {config.contactUrl && (
            <a
              href={config.contactUrl}
              data-contact-link
              {...(config.contactUrl.toLowerCase().startsWith('mailto:')
                ? {}
                : { target: '_blank', rel: 'noopener noreferrer' })}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
            >
              <Mail className="size-4" aria-hidden />
              {t('public.contact')}
            </a>
          )}
          {config.theme === 'auto' && <ThemeToggle className="shrink-0" />}
        </header>

        <OverallBanner status={overall} text={config.bannerText} />

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
              <GroupSection key={`${group.name}-${i}`} group={group} />
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
    </TooltipProvider>
  )
}
