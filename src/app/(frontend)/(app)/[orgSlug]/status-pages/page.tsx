import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { PageHeader } from '@/components/page-header'
import { CreateStatusPageDialog } from '@/components/status-pages/create-status-page-dialog'
import { StatusPageList } from '@/components/status-pages/status-page-list'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'

import { resolveOrg } from './resolve-org'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('statusPages.list')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

export default async function StatusPagesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const { payload, user, org, can } = await resolveOrg(orgSlug)

  const t = await getTranslations('statusPages.list')
  const timeZone = await getOrganizationTimezone(payload, org.id)

  const { docs: pages } = await payload.find({
    collection: 'status-pages',
    where: { organization: { equals: org.id } },
    sort: 'title',
    limit: 200,
    depth: 0,
    user,
    overrideAccess: false,
  })

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <CreateStatusPageDialog
            orgId={org.id}
            orgSlug={org.slug}
            canCreate={can('status-page:create')}
          />
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
        <StatusPageList
          pages={pages}
          orgSlug={org.slug}
          timeZone={timeZone}
          emptyAction={
            can('status-page:create') ? (
              <CreateStatusPageDialog orgId={org.id} orgSlug={org.slug} />
            ) : undefined
          }
        />
      </section>
    </>
  )
}
