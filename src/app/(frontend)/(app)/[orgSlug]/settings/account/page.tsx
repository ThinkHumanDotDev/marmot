import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { getTwoFactorStatus } from '@/auth/two-factor/service'
import { ssoErrorMessage } from '@/auth/sso/errors'
import { AccountForm } from '@/components/settings/account-form'
import { AppearanceCard } from '@/components/settings/appearance-card'
import { ChangePasswordForm } from '@/components/settings/change-password-form'
import { ConnectedAccountsCard } from '@/components/settings/connected-accounts-card'
import { DeleteAccountCard } from '@/components/settings/delete-account-card'
import { LanguageCard } from '@/components/settings/language-card'
import { TwoFactorCard } from '@/components/settings/two-factor-card'
import { toLocale } from '@/i18n/translator'
import { hasPassword } from '@/collections/Users'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import type { Media } from '@/payload-types'
import { listConnectedAccounts } from '@/server/accounts'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'
import { soleOwnerships } from '@/server/members'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('account') }
}
export const dynamic = 'force-dynamic'

export default async function AccountSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { orgSlug } = await params
  const { error } = await searchParams
  const user = await requireUser(`/${orgSlug}/settings/account`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  const payload = await getPayload({ config })
  const [blocking, twoFactor, connected, timeZone] = await Promise.all([
    soleOwnerships(payload, user),
    getTwoFactorStatus(payload, user.id),
    listConnectedAccounts(payload, user),
    getOrganizationTimezone(payload, org.id),
  ])
  const avatarUrl =
    user.avatar && typeof user.avatar === 'object' ? ((user.avatar as Media).url ?? null) : null
  const passwordAccount = hasPassword(user)

  return (
    <>
      <AccountForm user={{ id: user.id, email: user.email, name: user.name ?? '', avatarUrl }} />
      <AppearanceCard userId={user.id} theme={user.theme ?? 'system'} />
      <LanguageCard userId={user.id} language={toLocale(user.language)} />
      <ConnectedAccountsCard
        initial={connected}
        returnPath={`/${orgSlug}/settings/account`}
        error={ssoErrorMessage(error)}
        timeZone={timeZone}
      />
      <TwoFactorCard status={twoFactor} hasPassword={passwordAccount} timeZone={timeZone} />
      {passwordAccount && <ChangePasswordForm />}
      <DeleteAccountCard email={user.email} soleOwnerOf={blocking.map((o) => o.name)} />
    </>
  )
}
