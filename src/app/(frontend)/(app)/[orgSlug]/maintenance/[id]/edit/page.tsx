import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { MaintenanceForm } from '@/components/maintenance/maintenance-form'
import { OccurrencesPanel } from '@/components/maintenance/occurrences-panel'
import { PageHeader } from '@/components/page-header'
import { maintenanceToFormValues } from '@/lib/validation/maintenance'
import {
  getOrgMaintenance,
  getOrgMonitorOptions,
  getOrgStatusPageOptions,
} from '@/server/maintenance/page-data'
import { listMaintenanceOccurrences } from '@/server/maintenance/occurrences'
import { resolveTimezone } from '@/server/maintenance/status'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { getOrgTemplates } from '@/server/templates/page-data'

export const dynamic = 'force-dynamic'

interface EditMaintenancePageProps {
  params: Promise<{ orgSlug: string; id: string }>
}

export async function generateMetadata({ params }: EditMaintenancePageProps): Promise<Metadata> {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance/${id}/edit`)
  const doc = await getOrgMaintenance(ctx, id)
  const t = await getTranslations('maintenance.editPage')
  return { title: t('pageTitle', { title: doc.title }) }
}

export default async function EditMaintenancePage({ params }: EditMaintenancePageProps) {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance/${id}/edit`)
  const doc = await getOrgMaintenance(ctx, id)
  if (!ctx.allowed('maintenance:update')) redirect(`/${orgSlug}/maintenance`)

  const t = await getTranslations('maintenance.editPage')
  const [monitors, statusPages, orgTimezone, occurrences, templates] = await Promise.all([
    getOrgMonitorOptions(ctx),
    getOrgStatusPageOptions(ctx),
    getOrganizationTimezone(ctx.payload, ctx.org.id),
    listMaintenanceOccurrences(ctx.payload, doc.id, { user: ctx.requestUser }),
    getOrgTemplates(ctx, ['maintenance-update']),
  ])

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/maintenance`} className="hover:text-foreground">
            {t('back')}
          </Link>
        }
        title={t('title')}
        description={t('description')}
      />
      <section className="flex flex-col gap-6 p-4 sm:p-6 md:p-8">
        <OccurrencesPanel
          orgId={ctx.org.id}
          maintenanceId={String(doc.id)}
          initial={occurrences}
          timeZone={resolveTimezone(doc.timezone, orgTimezone)}
          canEdit
          templateContext={{ templates, organization: ctx.org.name, maintenance: doc.title }}
        />
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
