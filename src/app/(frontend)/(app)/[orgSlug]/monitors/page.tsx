import { Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { can, isSuperadmin } from '@/access/permissions'
import { MonitorList, RealtimeIndicator } from '@/components/monitors/monitor-list'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { requireUser } from '@/lib/auth'
import { loadOrgState } from '@/server/realtime/state'

export const metadata: Metadata = { title: 'Monitors' }
export const dynamic = 'force-dynamic'

interface MonitorsPageProps {
  params: Promise<{ orgSlug: string }>
}

/**
 * Monitors dashboard. Loads the organization, its monitors, the last 50 beats and the 24h uptime
 * through the Local API with the signed-in user's access, hands them to the client list (which
 * hydrates the monitor store) and lets the socket keep everything live from there.
 */
export default async function MonitorsPage({ params }: MonitorsPageProps) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/monitors`)
  const payload = await getPayload({ config })

  const { docs } = await payload.find({
    collection: 'organizations',
    where: { slug: { equals: orgSlug } },
    limit: 1,
    depth: 0,
    user,
    overrideAccess: false,
  })
  const organization = docs[0]
  if (!organization) notFound()

  const canCreate = isSuperadmin(user) || can(user, organization.id, 'monitor:create')

  const initial = await loadOrgState(payload, organization.id, {
    user,
    overrideAccess: false,
    heartbeatLimit: 50,
    importantLimit: 0,
    ranges: ['24h'],
  })

  return (
    <>
      <PageHeader
        title="Monitors"
        description="Everything Marmot is watching for this organization."
        actions={
          <>
            <RealtimeIndicator />
            {canCreate && (
              <Button asChild>
                <Link href={`/${orgSlug}/monitors/new`}>
                  <Plus /> New monitor
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
