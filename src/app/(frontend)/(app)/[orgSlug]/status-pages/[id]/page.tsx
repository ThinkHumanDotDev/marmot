import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { StatusPageEditor } from '@/components/status-pages/editor/status-page-editor'
import type { MonitorOption } from '@/components/status-pages/api'

import { resolveOrg } from '../resolve-org'

export const metadata: Metadata = { title: 'Edit status page' }
export const dynamic = 'force-dynamic'

export default async function StatusPageEditorPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>
}) {
  const { orgSlug, id } = await params
  const { payload, user, org, can } = await resolveOrg(orgSlug)
  const pageId = payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

  const [{ docs: pages }, { docs: monitors }] = await Promise.all([
    payload.find({
      collection: 'status-pages',
      where: { and: [{ id: { equals: pageId } }, { organization: { equals: org.id } }] },
      limit: 1,
      depth: 1,
      user,
      overrideAccess: false,
    }),
    payload.find({
      collection: 'monitors',
      where: { organization: { equals: org.id } },
      sort: 'name',
      limit: 500,
      pagination: false,
      depth: 0,
      user,
      overrideAccess: false,
    }),
  ])

  const page = pages[0]
  if (!page) notFound()

  const { docs: incidents } = await payload.find({
    collection: 'incidents',
    where: { statusPage: { equals: page.id } },
    sort: '-createdAt',
    limit: 200,
    depth: 0,
    user,
    overrideAccess: false,
  })

  const monitorOptions: MonitorOption[] = monitors.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    active: m.active,
    url: m.url,
    hostname: m.hostname,
    lastStatus: m.status?.lastStatus ?? undefined,
  }))

  return (
    <StatusPageEditor
      orgId={org.id}
      orgSlug={org.slug}
      initialPage={page}
      initialIncidents={incidents}
      monitors={monitorOptions}
      canEdit={can('status-page:update')}
      canDelete={can('status-page:delete')}
    />
  )
}
