import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { can } from '@/access/permissions'
import { ImportExportView } from '@/components/import-export/import-export-view'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('importExport') }
}
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
      canImportTemplates={can(user, org.id, 'template:create')}
      canExport={can(user, org.id, 'organization:update')}
    />
  )
}
