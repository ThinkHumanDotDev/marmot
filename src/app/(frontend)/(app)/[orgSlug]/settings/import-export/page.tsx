import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { can } from '@/access/permissions'
import { ImportExportView } from '@/components/import-export/import-export-view'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'

export const metadata: Metadata = { title: 'Import / Export' }
export const dynamic = 'force-dynamic'

export default async function ImportExportSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/import-export`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  return (
    <ImportExportView
      orgId={org.id}
      orgSlug={org.slug}
      canImport={can(user, org.id, 'monitor:create')}
      canImportNotifications={can(user, org.id, 'notification:create')}
      canImportStatusPages={can(user, org.id, 'status-page:create')}
      canExport={can(user, org.id, 'organization:update')}
    />
  )
}
