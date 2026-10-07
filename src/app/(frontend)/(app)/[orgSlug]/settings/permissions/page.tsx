import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import {
  effectivePermissions,
  getUserRole,
  isSuperadmin,
  LOCKED_PERMISSIONS,
  normalizePermissionOverrides,
  PERMISSIONS,
} from '@/access/permissions'
import { PermissionsTable } from '@/components/settings/permissions-table'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('permissions') }
}
export const dynamic = 'force-dynamic'

export default async function PermissionsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/permissions`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  const overrides = normalizePermissionOverrides(org.permissionOverrides)
  return (
    <PermissionsTable
      orgId={org.id}
      initial={{
        defaults: PERMISSIONS,
        overrides,
        effective: effectivePermissions(overrides),
        locked: [...LOCKED_PERMISSIONS],
        canEdit: isSuperadmin(user) || getUserRole(user, org.id) === 'owner',
      }}
    />
  )
}
