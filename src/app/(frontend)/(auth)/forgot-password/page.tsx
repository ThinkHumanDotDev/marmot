import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { AuthCard } from '@/components/auth/auth-card'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'
import { isBreakGlassEnabled, isLocalLoginDisabled } from '@/server/sso/local-login'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.forgotPassword')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ local?: string }>
}) {
  const { local } = await searchParams
  const t = await getTranslations('auth.forgotPassword')
  // SSO-only mode: only the break-glass path (`?local=1`) can request a reset link.
  const breakGlass = isLocalLoginDisabled() && isBreakGlassEnabled() && local === '1'
  const disabled = isLocalLoginDisabled() && !breakGlass
  return (
    <AuthCard
      title={disabled ? t('disabledTitle') : t('title')}
      description={disabled ? t('disabledDescription') : t('description')}
      footer={
        <Link
          href={breakGlass ? '/login?local=1' : '/login'}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t('backToSignIn')}
        </Link>
      }
    >
      {!disabled && <ForgotPasswordForm local={breakGlass} />}
    </AuthCard>
  )
}
