import { LockKeyhole } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { canWithOverrides } from '@/access/permissions'
import { SSO_CONNECTIONS_SLUG } from '@/collections/SsoConnections'
import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import { EmptyState } from '@/components/empty-state'
import { SsoSettingsView } from '@/components/settings/sso-settings-view'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import type { SsoConnection, SsoDomain } from '@/payload-types'
import { toConnectionRow } from '@/server/sso/connections'
import { toDomainRow } from '@/server/sso/domain-rows'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('security') }
}
export const dynamic = 'force-dynamic'

export default async function SecuritySettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/security`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  if (!canWithOverrides(user, org, 'sso:read')) {
    const t = await getTranslations('settings.sso')
    return (
      <EmptyState
        icon={LockKeyhole}
        title={t('adminsOnlyTitle')}
        description={t('adminsOnlyDescription')}
      />
    )
  }

  const payload = await getPayload({ config })
  const requestUser = { ...user, collection: 'users' as const }
  const [connections, domains] = await Promise.all([
    // `sso:read` was checked above; the read bypasses field access so rows can say whether a client
    // secret is stored (it is never returned).
    payload.find({
      collection: SSO_CONNECTIONS_SLUG,
      where: { organization: { equals: org.id } },
      sort: 'name',
      depth: 0,
      limit: 100,
      overrideAccess: true,
    }),
    payload.find({
      collection: SSO_DOMAINS_SLUG,
      where: { organization: { equals: org.id } },
      sort: 'domain',
      depth: 0,
      limit: 100,
      user: requestUser,
      overrideAccess: false,
    }),
  ])

  return (
    <SsoSettingsView
      orgId={String(org.id)}
      orgSlug={org.slug}
      connections={(connections.docs as SsoConnection[]).map(toConnectionRow)}
      domains={(domains.docs as SsoDomain[]).map(toDomainRow)}
      enforceSso={org.enforceSso === true}
      canManage={canWithOverrides(user, org, 'sso:manage')}
    />
  )
}
