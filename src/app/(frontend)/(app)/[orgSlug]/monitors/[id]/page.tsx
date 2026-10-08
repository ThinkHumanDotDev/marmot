import { ExternalLink, FolderTree } from 'lucide-react'
import type { Metadata } from 'next'
import type { Where } from 'payload'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'

import { MonitorIncidentsCard } from '@/components/incidents/monitor-incidents-card'
import { MonitorLocationBadge } from '@/components/locations/location-badge'
import {
  AssertionResultsCard,
  parseAssertionResults,
} from '@/components/monitors/assertion-results-card'
import { CertificatePanel } from '@/components/monitors/certificate-panel'
import { monitorTarget, useMonitorFormat } from '@/components/monitors/format'
import { HeartbeatBar, type BeatLike } from '@/components/monitors/heartbeat-bar'
import { LocationLatencyChart } from '@/components/monitors/location-latency-chart'
import { LocationFilter, LocationStatusTable } from '@/components/monitors/location-status-table'
import { LiveHeartbeatBar } from '@/components/monitors/live-heartbeat-bar'
import { ImportantEventsTable } from '@/components/monitors/important-events-table'
import { MonitorActions } from '@/components/monitors/monitor-actions'
import { MonitorChannelsCard } from '@/components/monitors/monitor-channels-card'
import { MonitorStatsPanel } from '@/components/monitors/monitor-stats-panel'
import { PushEventsTable, PushPanel } from '@/components/monitors/push-panel'
import { MonitorStatusBadge } from '@/components/monitors/status-badge'
import { TagList } from '@/components/monitors/tag-chip'
import { TimingWaterfall } from '@/components/monitors/timing-waterfall'
import { UptimeCards } from '@/components/monitors/uptime-cards'
import { PageHeader } from '@/components/page-header'
import { AuditLogView } from '@/components/settings/audit-log-view'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { env } from '@/env'
import { timeZoneOrDefault } from '@/i18n/formats'
import { parseRequestTiming } from '@/lib/request-timing'
import { isHttpMonitorType } from '@/lib/validation/monitor'
import {
  DEFAULT_QUORUM,
  isMultiLocation,
  isQuorumMode,
  monitorLocationKeys,
  quorumNeeded,
  type LocationStatus,
} from '@/lib/probe-locations'
import type { Heartbeat, Location, Monitor, PushEvent } from '@/payload-types'
import { recentMonitorIncidents, renderTime } from '@/server/incidents/store'
import { toRealtimeTags } from '@/server/realtime/serialize'
import { listAuditEvents } from '@/server/audit/query'
import { heartbeatLocationWhere, loadMonitorLocationView } from '@/server/monitors/location-view'
import { getMonitorChannels, getOrgMonitor, getOrgPageContext } from '@/server/monitors/page-data'
import { getRangeStats } from '@/server/stats/range-stats'
import { getUptime } from '@/server/stats/uptime-calculator'

export const dynamic = 'force-dynamic'

const EVENTS_PER_PAGE = 20

interface MonitorDetailPageProps {
  params: Promise<{ orgSlug: string; id: string }>
  searchParams: Promise<{ page?: string; location?: string }>
}

export async function generateMetadata({ params }: MonitorDetailPageProps): Promise<Metadata> {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/monitors/${id}`)
  const monitor = await getOrgMonitor(ctx, id, 0)
  return { title: monitor.name }
}

const toBeat = (doc: Heartbeat): BeatLike => ({
  id: doc.id,
  status: doc.status,
  time: doc.time,
  ping: doc.ping,
  msg: doc.msg,
})

function MonitorTypeBadge({ type }: { type: string }) {
  const { typeLabel } = useMonitorFormat()
  return <Badge variant="secondary">{typeLabel(type)}</Badge>
}

function LastCheck({ at, msg }: { at: string | null | undefined; msg: string | null | undefined }) {
  const t = useTranslations('monitors.detail')
  const { relative } = useMonitorFormat()
  return (
    <span className="text-xs">
      {t('checked', { when: relative(at) })}
      {msg ? ` · ${msg}` : ''}
    </span>
  )
}

export default async function MonitorDetailPage({ params, searchParams }: MonitorDetailPageProps) {
  const { orgSlug, id } = await params
  const { page: rawPage, location: rawLocation } = await searchParams
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/monitors/${id}`)
  const monitor = await getOrgMonitor(ctx, id, 1)
  const page = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1)
  const t = await getTranslations('monitors.detail')
  const tTiming = await getTranslations('monitors.timing')
  const timeZone = timeZoneOrDefault(ctx.org.settings?.timezone)

  const { payload } = ctx
  // Access was verified on the monitor; its history is read with the Local API directly.
  const now = new Date()
  const isPush = monitor.type === 'push'
  const canReadIncidents = ctx.allowed('monitor-incident:read')
  // Multi-location monitors (#92): per-location table, latency chart and the location filter.
  const multi = isMultiLocation(monitor)
  const locationKeys = monitorLocationKeys(monitor)
  const locationFilter =
    multi && rawLocation && locationKeys.includes(rawLocation) ? rawLocation : null
  const beatWhere = (where: Where): Where =>
    locationFilter ? { and: [where, heartbeatLocationWhere(locationFilter)] } : where
  const [
    stats24h,
    uptime30d,
    uptime1y,
    latest,
    events,
    channels,
    pushEvents,
    incidents,
    locationView,
  ] = await Promise.all([
    // The detail chart's default period; also the 24h figures of the uptime cards.
    getRangeStats(payload, monitor.id, '1d'),
    getUptime(payload, monitor.id, '30d'),
    getUptime(payload, monitor.id, '1y'),
    payload.find({
      collection: 'heartbeats',
      where: beatWhere({ monitor: { equals: monitor.id } }),
      sort: '-time',
      limit: 100,
      depth: 0,
      pagination: false,
    }),
    payload.find({
      collection: 'heartbeats',
      where: beatWhere({
        and: [{ monitor: { equals: monitor.id } }, { important: { equals: true } }],
      }),
      sort: '-time',
      limit: EVENTS_PER_PAGE,
      page,
      depth: 0,
    }),
    getMonitorChannels(ctx, monitor),
    isPush
      ? payload.find({
          collection: 'push-events',
          where: { monitor: { equals: monitor.id } },
          sort: '-time',
          limit: 20,
          depth: 0,
          pagination: false,
        })
      : null,
    canReadIncidents
      ? recentMonitorIncidents(payload, monitor.id, { user: ctx.requestUser })
      : Promise.resolve(null),
    multi ? loadMonitorLocationView(payload, monitor, now) : Promise.resolve(null),
  ])
  // Activity tab: this monitor's audit events, for holders of `audit-log:read`.
  const activity = ctx.allowed('audit-log:read')
    ? await listAuditEvents(payload, ctx.requestUser, ctx.org.id, {
        entityType: 'monitor',
        entityId: String(monitor.id),
      })
    : null

  const hasHistory = latest.docs.length > 0 || stats24h.buckets.length > 0
  // Per-assertion results of the last check (HTTP and DNS monitors). A lone accepted-status-code
  // row (a plain HTTP monitor) adds nothing the status line does not already say.
  const assertionResults = parseAssertionResults(latest.docs[0]?.assertions)
  const showAssertions =
    assertionResults.length > 1 || assertionResults.some((result) => !result.legacy)
  // Request timing phases (#94): HTTP types and TCP port measure them.
  const measuresTiming = isHttpMonitorType(monitor.type) || monitor.type === 'port'
  const latestTiming = parseRequestTiming(latest.docs[0]?.timing)
  const parent =
    monitor.parent && typeof monitor.parent === 'object' ? (monitor.parent as Monitor) : null
  const target = monitorTarget(monitor)
  // Probe location (#91), populated at depth 1 (readers without `location:read` see an id).
  const location = multi
    ? undefined
    : (monitor.locations ?? []).find(
        (value): value is Location => typeof value === 'object' && value !== null,
      )
  const detailPath = `/${orgSlug}/monitors/${monitor.id}`
  const quorum = isQuorumMode(monitor.quorum) ? monitor.quorum : DEFAULT_QUORUM
  const active = monitor.active !== false
  const pushUrl =
    monitor.type === 'push' && monitor.pushToken
      ? `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/api/push/${monitor.pushToken}`
      : null

  const eventsTable = (
    <ImportantEventsTable
      events={{
        docs: events.docs.map(toBeat),
        page: events.page ?? page,
        totalPages: events.totalPages,
        totalDocs: events.totalDocs,
      }}
      basePath={
        locationFilter ? `${detailPath}?location=${encodeURIComponent(locationFilter)}` : detailPath
      }
      timeZone={timeZone}
    />
  )

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <Link href={`/${orgSlug}/monitors`} className="hover:text-foreground">
              {t('breadcrumb')}
            </Link>
            {parent && (
              <>
                <span aria-hidden>/</span>
                <Link
                  href={`/${orgSlug}/monitors/${parent.id}`}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <FolderTree className="size-3" aria-hidden /> {parent.name}
                </Link>
              </>
            )}
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span data-testid="monitor-name">{monitor.name}</span>
            <MonitorStatusBadge status={monitor.status?.lastStatus} active={active} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <MonitorTypeBadge type={monitor.type} />
            {multi && (
              <Badge variant="outline" data-testid="monitor-location-count">
                {t('locationCount', { count: locationKeys.length })}
              </Badge>
            )}
            {location && (
              <MonitorLocationBadge
                name={location.name}
                status={(location.status ?? 'unknown') as LocationStatus}
              />
            )}
            {target &&
              (isHttpMonitorType(monitor.type) ? (
                <a
                  href={target}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 truncate font-mono text-xs hover:text-foreground"
                  data-testid="monitor-target"
                >
                  {target} <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : (
                <span className="font-mono text-xs" data-testid="monitor-target">
                  {target}
                </span>
              ))}
            <TagList tags={toRealtimeTags(monitor.tags)} />
            <LastCheck at={monitor.status?.lastCheckAt} msg={monitor.status?.lastMsg} />
          </span>
        }
        actions={
          <MonitorActions
            orgId={ctx.org.id}
            orgSlug={orgSlug}
            monitor={{ id: monitor.id, name: monitor.name, active, type: monitor.type }}
            canEdit={ctx.allowed('monitor:update')}
            canDelete={ctx.allowed('monitor:delete')}
          />
        }
      />

      <section className="flex flex-col gap-6 p-4 sm:p-6 md:p-8">
        {!active && (
          <p className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            {t('paused')}
          </p>
        )}

        {locationView && (
          <LocationStatusTable
            rows={locationView.rows}
            quorum={quorum}
            needed={quorumNeeded(quorum, locationKeys.length)}
          />
        )}

        {locationView && (
          <LocationFilter
            rows={locationView.rows}
            selected={locationFilter}
            basePath={detailPath}
          />
        )}

        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('latestHeartbeats')}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            {locationFilter ? (
              // The live store mixes every location's beats; a filtered bar stays server-rendered.
              <HeartbeatBar beats={latest.docs.map(toBeat)} timeZone={timeZone} />
            ) : (
              <LiveHeartbeatBar
                monitorId={String(monitor.id)}
                beats={latest.docs.map(toBeat)}
                timeZone={timeZone}
              />
            )}
          </CardContent>
        </Card>

        <UptimeCards
          summary={{
            uptime24h: hasHistory ? stats24h.uptime : null,
            uptime30d: hasHistory ? uptime30d : null,
            uptime1y: hasHistory ? uptime1y : null,
            avgPing24h: stats24h.avgPing,
            lastPing: monitor.status?.lastPing ?? null,
            degraded24h: stats24h.degraded,
          }}
        />

        {pushUrl && <PushPanel monitor={monitor} pushUrl={pushUrl} timeZone={timeZone} now={now} />}

        {showAssertions && <AssertionResultsCard results={assertionResults} />}

        <MonitorStatsPanel
          monitorId={String(monitor.id)}
          initial={{
            range: stats24h.range,
            uptime: stats24h.uptime,
            avgPing: stats24h.avgPing,
            percentiles: stats24h.percentiles,
            checks: stats24h.checks,
            step: stats24h.step,
            series: stats24h.series,
          }}
          lastCheckAt={monitor.status?.lastCheckAt}
          showTiming={measuresTiming}
        />

        {locationView && (
          <LocationLatencyChart
            series={locationView.series
              .map((series, colorIndex) => ({ ...series, colorIndex }))
              .filter((series) => !locationFilter || series.key === locationFilter)}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="flex min-w-0 flex-col gap-6">
            {activity ? (
              <Tabs defaultValue="events" className="min-w-0">
                <TabsList>
                  <TabsTrigger value="events">{t('tabs.events')}</TabsTrigger>
                  <TabsTrigger value="activity" data-testid="monitor-activity-tab">
                    {t('tabs.activity')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="events">{eventsTable}</TabsContent>
                <TabsContent value="activity" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">{t('activityDescription')}</p>
                  <AuditLogView
                    orgId={String(ctx.org.id)}
                    initial={activity}
                    entity={{ type: 'monitor', id: String(monitor.id) }}
                    timeZone={timeZone}
                  />
                </TabsContent>
              </Tabs>
            ) : (
              eventsTable
            )}
            {pushEvents && (
              <PushEventsTable events={pushEvents.docs as PushEvent[]} timeZone={timeZone} />
            )}
          </div>
          <div className="flex flex-col gap-6">
            {incidents && (
              <MonitorIncidentsCard
                orgId={ctx.org.id}
                orgSlug={orgSlug}
                monitorId={String(monitor.id)}
                initial={incidents}
                now={renderTime()}
              />
            )}
            {latestTiming && (
              <Card className="gap-3" data-testid="latest-timing">
                <CardHeader>
                  <CardTitle className="text-base">{tTiming('title')}</CardTitle>
                  <CardDescription>{tTiming('latestDescription')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <TimingWaterfall timing={latestTiming} ping={latest.docs[0]?.ping} />
                </CardContent>
              </Card>
            )}
            {(isHttpMonitorType(monitor.type) ||
              monitor.certInfo ||
              monitor.domainExpiry ||
              monitor.domainExpiryNotification) && (
              <CertificatePanel monitor={monitor} timeZone={timeZone} />
            )}
            <MonitorChannelsCard
              orgId={ctx.org.id}
              orgSlug={orgSlug}
              channels={channels}
              canTest={ctx.allowed('notification:update')}
              canEdit={ctx.allowed('monitor:update')}
            />
            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-base">{t('description')}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap text-muted-foreground">
                {monitor.description || t('noDescription')}
              </CardContent>
            </Card>
          </div>
        </div>
      </section>
    </>
  )
}
