import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { MaintenanceForm } from '@/components/maintenance/maintenance-form'
import { PageHeader } from '@/components/page-header'
import { maintenanceToFormValues } from '@/lib/validation/maintenance'
import {
  getOrgMaintenance,
  getOrgMonitorOptions,
  getOrgStatusPageOptions,
} from '@/server/maintenance/page-data'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'
import { getOrgPageContext } from '@/server/monitors/page-data'

export const dynamic = 'force-dynamic'

interface EditMaintenancePageProps {
  params: Promise<{ orgSlug: string; id: string }>
}

export async function generateMetadata({ params }: EditMaintenancePageProps): Promise<Metadata> {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance/${id}/edit`)
  const doc = await getOrgMaintenance(ctx, id)
  return { title: `Edit ${doc.title}` }
}

export default async function EditMaintenancePage({ params }: EditMaintenancePageProps) {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance/${id}/edit`)
  const doc = await getOrgMaintenance(ctx, id)
  if (!ctx.allowed('maintenance:update')) redirect(`/${orgSlug}/maintenance`)

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
        title="Edit maintenance"
        description="Changes apply immediately; the next check of each affected monitor honours them."
      />
      <section className="p-4 sm:p-6 md:p-8">
        <MaintenanceForm
          mode="edit"
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          maintenanceId={String(doc.id)}
          initialValues={maintenanceToFormValues(doc)}
          monitors={monitors}
          statusPages={statusPages}
          orgTimezone={orgTimezone}
        />
      </section>
    </>
  )
}
