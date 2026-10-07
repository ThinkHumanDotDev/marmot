import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { MaintenanceForm } from '@/components/maintenance/maintenance-form'
import { PageHeader } from '@/components/page-header'
import { defaultMaintenanceValues } from '@/lib/validation/maintenance'
import { getOrgMonitorOptions, getOrgStatusPageOptions } from '@/server/maintenance/page-data'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { getOrgTemplates } from '@/server/templates/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('maintenance.newPage')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

interface NewMaintenancePageProps {
  params: Promise<{ orgSlug: string }>
}

export default async function NewMaintenancePage({ params }: NewMaintenancePageProps) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance/new`)
  if (!ctx.allowed('maintenance:create')) redirect(`/${orgSlug}/maintenance`)

  const t = await getTranslations('maintenance.newPage')
  const [monitors, statusPages, orgTimezone, templates] = await Promise.all([
    getOrgMonitorOptions(ctx),
    getOrgStatusPageOptions(ctx),
    getOrganizationTimezone(ctx.payload, ctx.org.id),
    getOrgTemplates(ctx, ['maintenance']),
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
      <section className="p-4 sm:p-6 md:p-8">
        <MaintenanceForm
          mode="create"
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          initialValues={defaultMaintenanceValues()}
          monitors={monitors}
          statusPages={statusPages}
          orgTimezone={orgTimezone}
          templates={templates}
          orgName={ctx.org.name}
        />
      </section>
    </>
  )
}
