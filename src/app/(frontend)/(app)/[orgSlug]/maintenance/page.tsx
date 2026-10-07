import { Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'

import { MaintenanceList } from '@/components/maintenance/maintenance-list'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { listOrgMaintenance } from '@/server/maintenance/serialize'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('maintenance.list')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

interface MaintenancePageProps {
  params: Promise<{ orgSlug: string }>
}

/** Maintenance windows of the organization, server-loaded and kept live by the socket. */
export default async function MaintenancePage({ params }: MaintenancePageProps) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/maintenance`)
  const t = await getTranslations('maintenance.list')
  const canEdit = ctx.allowed('maintenance:update')
  const items = await listOrgMaintenance(ctx.payload, ctx.org.id, {
    user: ctx.requestUser,
    overrideAccess: false,
    locale: await getLocale(),
  })

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canEdit ? (
            <Button asChild>
              <Link href={`/${orgSlug}/maintenance/new`}>
                <Plus /> {t('schedule')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
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
