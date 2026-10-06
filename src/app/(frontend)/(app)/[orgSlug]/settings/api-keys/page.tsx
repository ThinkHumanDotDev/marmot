import { KeyRound } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { can, isSuperadmin } from '@/access/permissions'
import { EmptyState } from '@/components/empty-state'
import { ApiKeysView } from '@/components/settings/api-keys-view'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import type { ApiKey } from '@/payload-types'
import { toApiKeyRow } from '@/server/api-keys'

export const metadata: Metadata = { title: 'API keys' }
export const dynamic = 'force-dynamic'

export default async function ApiKeysSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/api-keys`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  const canRead = isSuperadmin(user) || can(user, org.id, 'api-key:read')
  if (!canRead) {
    return (
      <EmptyState
        icon={KeyRound}
        title="Admins only"
        description="API keys are managed by admins and owners of this organization."
      />
    )
  }

  const payload = await getPayload({ config })
  const { docs } = await payload.find({
    collection: 'api-keys',
    where: { organization: { equals: org.id } },
    sort: '-createdAt',
    depth: 0,
    limit: 200,
    user: { ...user, collection: 'users' as const },
    overrideAccess: false,
  })

  return (
    <ApiKeysView
      orgId={String(org.id)}
      initial={(docs as ApiKey[]).map((doc) => toApiKeyRow(doc))}
      canManage={isSuperadmin(user) || can(user, org.id, 'api-key:create')}
    />
  )
}
