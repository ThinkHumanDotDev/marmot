import { Bell } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { canInOrg } from '@/access/overrides'
import { isSuperadmin, type OrgId } from '@/access/permissions'
import { EmptyState } from '@/components/empty-state'
import { NotificationsView } from '@/components/notifications/notifications-view'
import { toNotificationRow } from '@/components/notifications/types'
import { PageHeader } from '@/components/page-header'
import { getUserOrganizations, requireUser } from '@/lib/auth'
import type { Notification } from '@/payload-types'
import { getProviderDescriptors, toClientNotification } from '@/server/notifications/api'
import { serverSmtpRestriction } from '@/server/notifications/server-smtp'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('notifications.page')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ orgSlug: string }>
}

export default async function NotificationsPage({ params }: PageProps) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/notifications`)
  const payload = await getPayload({ config })

  // Members resolve the organization from their memberships; superadmins may open any slug.
  const memberships = await getUserOrganizations(user, payload)
  let orgId: OrgId | undefined = memberships.find((org) => org.slug === orgSlug)?.id
  if (orgId === undefined && isSuperadmin(user)) {
    const { docs } = await payload.find({
      collection: 'organizations',
      where: { slug: { equals: orgSlug } },
      depth: 0,
      limit: 1,
      overrideAccess: true,
    })
    orgId = docs[0]?.id
  }
  if (orgId === undefined) notFound()

  const canRead = await canInOrg(payload, user, orgId, 'notification:read')
  const canManage = await canInOrg(payload, user, orgId, 'notification:update')

  if (!canRead) {
    const t = await getTranslations('notifications.page')
    return (
      <>
        <PageHeader title={t('title')} description={t('description')} />
        <section className="p-4 sm:p-6 md:p-8">
          <EmptyState
            icon={Bell}
            title={t('membersOnlyTitle')}
            description={t('membersOnlyDescription')}
          />
        </section>
      </>
    )
  }

  const requestUser = { ...user, collection: 'users' as const }
  const { docs } = await payload.find({
    collection: 'notifications',
    where: { organization: { equals: orgId } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: requestUser,
    overrideAccess: false,
  })

  return (
    <NotificationsView
      orgId={String(orgId)}
      initial={(docs as Notification[]).map((doc) =>
        toNotificationRow(toClientNotification(doc, requestUser, orgId)),
      )}
      providers={getProviderDescriptors()}
      canManage={canManage}
      serverSmtpRestriction={serverSmtpRestriction(user)}
    />
  )
}
