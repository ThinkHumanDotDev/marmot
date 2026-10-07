import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { canWithOverrides } from '@/access/permissions'
import { toNotificationRow } from '@/components/notifications/types'
import { DefaultChannelsCard } from '@/components/settings/default-channels-card'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import type { Notification } from '@/payload-types'
import { toClientNotification } from '@/server/notifications/api'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('notifications') }
}
export const dynamic = 'force-dynamic'

export default async function NotificationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/notifications`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  if (!canWithOverrides(user, org, 'notification:read')) {
    const t = await getTranslations('settings.defaultChannels')
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('readOnly')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const payload = await getPayload({ config })
  const requestUser = { ...user, collection: 'users' as const }
  const { docs } = await payload.find({
    collection: 'notifications',
    where: { organization: { equals: org.id } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: requestUser,
    overrideAccess: false,
  })

  return (
    <DefaultChannelsCard
      orgId={String(org.id)}
      orgSlug={orgSlug}
      channels={(docs as Notification[]).map((doc) =>
        toNotificationRow(toClientNotification(doc, requestUser, org.id)),
      )}
      canManage={canWithOverrides(user, org, 'notification:update')}
    />
  )
}
