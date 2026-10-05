import type { Metadata } from 'next'

import { PageHeader } from '@/components/page-header'
import { CreateStatusPageDialog } from '@/components/status-pages/create-status-page-dialog'
import { StatusPageList } from '@/components/status-pages/status-page-list'

import { resolveOrg } from './resolve-org'

export const metadata: Metadata = { title: 'Status pages' }
export const dynamic = 'force-dynamic'

export default async function StatusPagesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const { payload, user, org, can } = await resolveOrg(orgSlug)

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
        title="Status pages"
        description="Public pages that show your customers what is up."
        actions={
          <CreateStatusPageDialog
            orgId={org.id}
            orgSlug={org.slug}
            canCreate={can('status-page:create')}
          />
        }
      />
      <section className="p-6 md:p-8">
        <StatusPageList pages={pages} orgSlug={org.slug} />
      </section>
    </>
  )
}
