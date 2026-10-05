import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { AccountForm } from '@/components/settings/account-form'
import { ChangePasswordForm } from '@/components/settings/change-password-form'
import { DeleteAccountCard } from '@/components/settings/delete-account-card'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import type { Media } from '@/payload-types'
import { soleOwnerships } from '@/server/members'

export const metadata: Metadata = { title: 'Account settings' }
export const dynamic = 'force-dynamic'

export default async function AccountSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/account`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  const payload = await getPayload({ config })
  const blocking = await soleOwnerships(payload, user)
  const avatarUrl =
    user.avatar && typeof user.avatar === 'object' ? ((user.avatar as Media).url ?? null) : null

  return (
    <>
      <AccountForm user={{ id: user.id, email: user.email, name: user.name ?? '', avatarUrl }} />
      <ChangePasswordForm />
      <DeleteAccountCard email={user.email} soleOwnerOf={blocking.map((o) => o.name)} />
    </>
  )
}
