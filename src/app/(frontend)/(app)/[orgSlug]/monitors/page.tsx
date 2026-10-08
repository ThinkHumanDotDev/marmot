import { Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { MonitorList, RealtimeIndicator } from '@/components/monitors/monitor-list'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { parseMonitorFilters } from '@/lib/monitor-filters'
import { getMonitorListResources, getOrgPageContext } from '@/server/monitors/page-data'
import { loadOrgState } from '@/server/realtime/state'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('monitors.list')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

interface MonitorsPageProps {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Monitors dashboard. Loads the organization, its monitors, the last 50 beats and the 24h uptime
 * through the Local API with the signed-in user's access, plus the tags, channels and locations the
 * filters offer, hands them to the client list (which hydrates the monitor store) and lets the
 * socket keep everything live from there. Search and filters come from the query string
 * (`?q=api&status=down&tag=12`), so filtered views are shareable.
 */
export default async function MonitorsPage({ params, searchParams }: MonitorsPageProps) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/monitors`)
  const { payload, org: organization, requestUser } = ctx

  const canCreate = ctx.allowed('monitor:create')
  const bulk = { update: ctx.allowed('monitor:update'), delete: ctx.allowed('monitor:delete') }

  const t = await getTranslations('monitors.list')
  const [initial, resources, query] = await Promise.all([
    loadOrgState(payload, organization.id, {
      user: requestUser,
      overrideAccess: false,
      heartbeatLimit: 50,
      importantLimit: 0,
      ranges: ['24h'],
    }),
    getMonitorListResources(ctx),
    searchParams,
  ])

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <RealtimeIndicator />
            {canCreate && (
              <Button asChild>
                <Link href={`/${orgSlug}/monitors/new`}>
                  <Plus /> {t('newMonitor')}
                </Link>
              </Button>
            )}
          </>
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
        <MonitorList
          orgSlug={orgSlug}
          canCreate={canCreate}
          initialFilters={parseMonitorFilters(query)}
          resources={resources}
          bulk={bulk}
          initial={{
            organizationId: initial.organizationId,
            monitors: initial.monitors,
            heartbeats: initial.heartbeats,
            uptime: initial.uptime,
          }}
        />
      </section>
    </>
  )
}
