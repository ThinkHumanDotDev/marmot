import { Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { MaintenanceList } from '@/components/maintenance/maintenance-list'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { listOrgMaintenance } from '@/server/maintenance/serialize'
import { getOrgPageContext } from '@/server/monitors/page-data'

export const metadata: Metadata = { title: 'Maintenance' }
export const dynamic = 'force-dynamic'

interface MaintenancePageProps {
  params: Promise<{ orgSlug: string }>
}

/** Maintenance windows of the organization, server-loaded and kept live by the socket. */
export default async function MaintenancePage({ params }: MaintenancePageProps) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance`)
  const canEdit = ctx.allowed('maintenance:update')
  const items = await listOrgMaintenance(ctx.payload, ctx.org.id, {
    user: ctx.requestUser,
    overrideAccess: false,
  })

  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Planned windows during which monitors are paused and status pages say so."
        actions={
          canEdit ? (
            <Button asChild>
              <Link href={`/${orgSlug}/maintenance/new`}>
                <Plus /> Schedule maintenance
              </Link>
            </Button>
          ) : undefined
        }
      />
      <section className="p-6 md:p-8">
        <MaintenanceList
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          initial={items}
          canEdit={canEdit}
          canDelete={ctx.allowed('maintenance:delete')}
        />
      </section>
    </>
  )
}
