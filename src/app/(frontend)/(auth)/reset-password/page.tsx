import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { AuthCard } from '@/components/auth/auth-card'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { Button } from '@/components/ui/button'
import { isBreakGlassEnabled, isLocalLoginDisabled } from '@/server/sso/local-login'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.resetPassword')
  return { title: t('pageTitle') }
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  const t = await getTranslations('auth.resetPassword')

  // SSO-only mode without break-glass: nobody has a password to reset.
  if (isLocalLoginDisabled() && !isBreakGlassEnabled()) {
    return (
      <AuthCard title={t('disabledTitle')} description={t('disabledDescription')}>
        <Button asChild className="w-full">
          <Link href="/login">{t('backToSignIn')}</Link>
        </Button>
      </AuthCard>
    )
  }

  if (!token) {
    return (
      <AuthCard title={t('missingTitle')} description={t('missingDescription')}>
        <Button asChild className="w-full">
          <Link href="/forgot-password">{t('requestNew')}</Link>
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t('backToSignIn')}
        </Link>
      }
    >
      <ResetPasswordForm token={token} />
    </AuthCard>
  )
}
