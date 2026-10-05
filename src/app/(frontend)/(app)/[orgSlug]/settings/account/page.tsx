import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { getTwoFactorStatus } from '@/auth/two-factor/service'
import { AccountForm } from '@/components/settings/account-form'
import { AppearanceCard } from '@/components/settings/appearance-card'
import { ChangePasswordForm } from '@/components/settings/change-password-form'
import { DeleteAccountCard } from '@/components/settings/delete-account-card'
import { TwoFactorCard } from '@/components/settings/two-factor-card'
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
  const [blocking, twoFactor] = await Promise.all([
    soleOwnerships(payload, user),
    getTwoFactorStatus(payload, user.id),
  ])
  const avatarUrl =
    user.avatar && typeof user.avatar === 'object' ? ((user.avatar as Media).url ?? null) : null
  const hasPassword = user.authProvider !== 'oidc'

  return (
    <>
      <AccountForm user={{ id: user.id, email: user.email, name: user.name ?? '', avatarUrl }} />
      <AppearanceCard userId={user.id} theme={user.theme ?? 'system'} />
      <TwoFactorCard status={twoFactor} hasPassword={hasPassword} />
      {hasPassword && <ChangePasswordForm />}
      <DeleteAccountCard email={user.email} soleOwnerOf={blocking.map((o) => o.name)} />
    </>
  )
}
