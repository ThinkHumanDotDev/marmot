import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { canWithOverrides } from '@/access/permissions'
import { OrganizationDangerZone } from '@/components/settings/organization-danger-zone'
import { OrganizationForm } from '@/components/settings/organization-form'
import { requireUser } from '@/lib/auth'
import { effectiveRole, getOrgBySlug, summarizeOrg } from '@/lib/org'
import { listOrgMembers } from '@/server/members'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('organization') }
}
export const dynamic = 'force-dynamic'

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/organization`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  const payload = await getPayload({ config })
  const members = await listOrgMembers(payload, org.id, { user, overrideAccess: false })
  const role = effectiveRole(user, org.id)

  return (
    <>
      <OrganizationForm
        org={summarizeOrg(org)}
        canEdit={canWithOverrides(user, org, 'organization:update')}
      />
      <OrganizationDangerZone
        org={summarizeOrg(org)}
        role={role}
        currentUserId={user.id}
        members={members}
      />
    </>
  )
}
