import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { MaintenanceForm } from '@/components/maintenance/maintenance-form'
import { PageHeader } from '@/components/page-header'
import { defaultMaintenanceValues } from '@/lib/validation/maintenance'
import { getOrgMonitorOptions, getOrgStatusPageOptions } from '@/server/maintenance/page-data'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'
import { getOrgPageContext } from '@/server/monitors/page-data'

export const metadata: Metadata = { title: 'Schedule maintenance' }
export const dynamic = 'force-dynamic'

interface NewMaintenancePageProps {
  params: Promise<{ orgSlug: string }>
}

export default async function NewMaintenancePage({ params }: NewMaintenancePageProps) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance/new`)
  if (!ctx.allowed('maintenance:create')) redirect(`/${orgSlug}/maintenance`)

  const [monitors, statusPages, orgTimezone] = await Promise.all([
    getOrgMonitorOptions(ctx),
    getOrgStatusPageOptions(ctx),
    getOrganizationTimezone(ctx.payload, ctx.org.id),
  ])

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/maintenance`} className="hover:text-foreground">
            ← Maintenance
          </Link>
        }
        title="Schedule maintenance"
        description="Affected monitors stop alerting while the window runs."
      />
      <section className="p-4 sm:p-6 md:p-8">
        <MaintenanceForm
          mode="create"
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          initialValues={defaultMaintenanceValues()}
          monitors={monitors}
          statusPages={statusPages}
          orgTimezone={orgTimezone}
        />
      </section>
    </>
  )
}
