import { RadioTower } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { can, isSuperadmin } from '@/access/permissions'
import { EmptyState } from '@/components/empty-state'
import { LocationsView } from '@/components/settings/locations-view'
import { env } from '@/env'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import { listLocationRows } from '@/server/probes'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('locations') }
}
export const dynamic = 'force-dynamic'

/** Settings → Locations: self-hosted probe locations (#91). */
export default async function LocationsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/locations`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  if (!(isSuperadmin(user) || can(user, org.id, 'location:read'))) {
    const t = await getTranslations('settings.locations')
    return <EmptyState icon={RadioTower} title={t('forbiddenTitle')} description={t('forbidden')} />
  }

  const payload = await getPayload({ config })
  const rows = await listLocationRows(payload, org.id, {
    user: { ...user, collection: 'users' as const },
    overrideAccess: false,
  })

  return (
    <LocationsView
      orgId={String(org.id)}
      initial={rows}
      canManage={isSuperadmin(user) || can(user, org.id, 'location:create')}
      serverUrl={env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}
      offlineAfterSeconds={env.PROBE_OFFLINE_AFTER}
    />
  )
}
