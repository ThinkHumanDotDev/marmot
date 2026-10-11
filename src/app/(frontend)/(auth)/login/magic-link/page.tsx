import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { AuthCard } from '@/components/auth/auth-card'
import { MagicLinkConfirm } from '@/components/auth/magic-link-confirm'
import { getCurrentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/utils'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.magicLink')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

/**
 * `/login/magic-link?token=…[&next=…]`: target of the email sign-in link (#164). The token is only
 * redeemed when the person clicks **Continue** (`POST /api/auth/magic-link/verify`), so mail
 * scanners that prefetch links cannot use it up. Accounts with two-factor authentication continue
 * with the code step.
 */
export default async function MagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>
}) {
  const { token, next } = await searchParams
  const user = await getCurrentUser()
  if (user) redirect(safeNextPath(next))
  if (!token) redirect('/login')
  const t = await getTranslations('auth.magicLink')

  return (
    <AuthCard title={t('title')} description={t('description')}>
      <MagicLinkConfirm token={token} next={next ? safeNextPath(next) : undefined} />
    </AuthCard>
  )
}
