import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { AuthCard } from '@/components/auth/auth-card'
import { VerifyEmailConfirm, VerifyEmailPending } from '@/components/auth/verify-email'
import { getCurrentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/utils'
import { needsEmailVerification } from '@/server/auth/email-verification'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.verifyEmail')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

/**
 * Email verification (#177). With `?token=` it is the target of the link in the email (a confirm
 * button that redeems it); without, the "check your inbox" screen that `requireUser` sends pending
 * accounts to. Verified accounts (or instances that do not require verification) move on.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>
}) {
  const { token, next } = await searchParams
  const t = await getTranslations('auth.verifyEmail')
  const user = await getCurrentUser()

  if (token) {
    return (
      <AuthCard title={t('confirmTitle')} description={t('confirmDescription')}>
        <VerifyEmailConfirm token={token} signedIn={Boolean(user)} next={next} />
      </AuthCard>
    )
  }

  const search = next ? `?next=${encodeURIComponent(next)}` : ''
  if (!user) redirect(`/login?next=${encodeURIComponent(`/verify-email${search}`)}`)
  if (!(await needsEmailVerification(await getPayload({ config }), user))) {
    redirect(safeNextPath(next))
  }

  return (
    <AuthCard title={t('title')}>
      <VerifyEmailPending userId={user.id} email={user.email} next={next} />
    </AuthCard>
  )
}
