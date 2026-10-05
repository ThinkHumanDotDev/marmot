import { ExternalLink, FolderTree } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { CertificatePanel } from '@/components/monitors/certificate-panel'
import { formatRelative, humanTypeLabel, monitorTarget } from '@/components/monitors/format'
import { HeartbeatBar, type BeatLike } from '@/components/monitors/heartbeat-bar'
import { ImportantEventsTable } from '@/components/monitors/important-events-table'
import { MonitorActions } from '@/components/monitors/monitor-actions'
import { ResponseTimeChart } from '@/components/monitors/response-time-chart'
import { MonitorStatusBadge } from '@/components/monitors/status-badge'
import { TagList } from '@/components/monitors/tag-chip'
import { UptimeCards } from '@/components/monitors/uptime-cards'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { env } from '@/env'
import { isHttpMonitorType } from '@/lib/validation/monitor'
import type { Heartbeat, Monitor } from '@/payload-types'
import { toRealtimeTags } from '@/server/realtime/serialize'
import { getOrgMonitor, getOrgPageContext } from '@/server/monitors/page-data'
import { getStats, getUptime } from '@/server/stats/uptime-calculator'

export const dynamic = 'force-dynamic'

const EVENTS_PER_PAGE = 20

interface MonitorDetailPageProps {
  params: Promise<{ orgSlug: string; id: string }>
  searchParams: Promise<{ page?: string }>
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

export default async function MonitorDetailPage({ params, searchParams }: MonitorDetailPageProps) {
  const { orgSlug, id } = await params
  const { page: rawPage } = await searchParams
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/monitors/${id}`)
  const monitor = await getOrgMonitor(ctx, id, 1)
  const page = Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1)

  const { payload } = ctx
  // Access was verified on the monitor; its history is read with the Local API directly.
  const [stats24h, uptime30d, uptime1y, latest, events] = await Promise.all([
    getStats(payload, monitor.id, '24h'),
    getUptime(payload, monitor.id, '30d'),
    getUptime(payload, monitor.id, '1y'),
    payload.find({
      collection: 'heartbeats',
      where: { monitor: { equals: monitor.id } },
      sort: '-time',
      limit: 100,
      depth: 0,
      pagination: false,
    }),
    payload.find({
      collection: 'heartbeats',
      where: { and: [{ monitor: { equals: monitor.id } }, { important: { equals: true } }] },
      sort: '-time',
      limit: EVENTS_PER_PAGE,
      page,
      depth: 0,
    }),
  ])

  const hasHistory = latest.docs.length > 0 || stats24h.buckets.length > 0
  const parent =
    monitor.parent && typeof monitor.parent === 'object' ? (monitor.parent as Monitor) : null
  const target = monitorTarget(monitor)
  const active = monitor.active !== false
  const pushUrl =
    monitor.type === 'push' && monitor.pushToken
      ? `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/api/push/${monitor.pushToken}?status=up&msg=OK&ping=`
      : null

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <Link href={`/${orgSlug}/monitors`} className="hover:text-foreground">
              Monitors
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
            <Badge variant="secondary">{humanTypeLabel(monitor.type)}</Badge>
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
            <span className="text-xs">
              Checked {formatRelative(monitor.status?.lastCheckAt)}
              {monitor.status?.lastMsg ? ` · ${monitor.status.lastMsg}` : ''}
            </span>
          </span>
        }
        actions={
          <MonitorActions
            orgId={ctx.org.id}
            orgSlug={orgSlug}
            monitor={{ id: monitor.id, name: monitor.name, active }}
            canEdit={ctx.allowed('monitor:update')}
            canDelete={ctx.allowed('monitor:delete')}
          />
        }
      />

      <section className="flex flex-col gap-6 p-4 sm:p-6 md:p-8">
        {!active && (
          <p className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            This monitor is paused. Resume it to start checking again; history is kept.
          </p>
        )}

        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Latest heartbeats
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <HeartbeatBar beats={latest.docs.map(toBeat)} />
          </CardContent>
        </Card>

        <UptimeCards
          summary={{
            uptime24h: hasHistory ? stats24h.uptime : null,
            uptime30d: hasHistory ? uptime30d : null,
            uptime1y: hasHistory ? uptime1y : null,
            avgPing24h: stats24h.avgPing,
            lastPing: monitor.status?.lastPing ?? null,
          }}
        />

        {pushUrl && (
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-base">Push URL</CardTitle>
            </CardHeader>
            <CardContent>
              <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
                {pushUrl}
              </code>
              <p className="mt-2 text-xs text-muted-foreground">
                Call this URL at least every {monitor.interval} seconds. Optional query parameters:
                <code> status</code> (up|down), <code>msg</code>, <code>ping</code>.
              </p>
            </CardContent>
          </Card>
        )}

        <ResponseTimeChart buckets={stats24h.buckets} />

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <ImportantEventsTable
            events={{
              docs: events.docs.map(toBeat),
              page: events.page ?? page,
              totalPages: events.totalPages,
              totalDocs: events.totalDocs,
            }}
            basePath={`/${orgSlug}/monitors/${monitor.id}`}
          />
          <div className="flex flex-col gap-6">
            {isHttpMonitorType(monitor.type) && (
              <CertificatePanel expiryNotification={monitor.expiryNotification} />
            )}
            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-base">Description</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap text-muted-foreground">
                {monitor.description || 'No description yet. Add one from Edit.'}
              </CardContent>
            </Card>
          </div>
        </div>
      </section>
    </>
  )
}
