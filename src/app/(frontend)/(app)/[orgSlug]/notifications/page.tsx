import { Bell } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { can, isSuperadmin, type OrgId } from '@/access/permissions'
import { EmptyState } from '@/components/empty-state'
import { NotificationsView } from '@/components/notifications/notifications-view'
import { toNotificationRow } from '@/components/notifications/types'
import { PageHeader } from '@/components/page-header'
import { getUserOrganizations, requireUser } from '@/lib/auth'
import type { Notification } from '@/payload-types'
import { getProviderDescriptors } from '@/server/notifications/api'

export const metadata: Metadata = { title: 'Notifications' }
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

  const canRead = isSuperadmin(user) || can(user, orgId, 'notification:read')
  const canManage = isSuperadmin(user) || can(user, orgId, 'notification:update')

  if (!canRead) {
    return (
      <>
        <PageHeader
          title="Notifications"
          description="Where Marmot tells you when something changes."
        />
        <section className="p-6 md:p-8">
          <EmptyState
            icon={Bell}
            title="Members only"
            description="Notification channels are visible to members and managed by admins of this organization."
          />
        </section>
      </>
    )
  }

  const { docs } = await payload.find({
    collection: 'notifications',
    where: { organization: { equals: orgId } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: { ...user, collection: 'users' },
    overrideAccess: false,
  })

  return (
    <NotificationsView
      orgId={String(orgId)}
      initial={(docs as Notification[]).map(toNotificationRow)}
      providers={getProviderDescriptors()}
      canManage={canManage}
    />
  )
}
