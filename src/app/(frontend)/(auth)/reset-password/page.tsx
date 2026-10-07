import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { AuthCard } from '@/components/auth/auth-card'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { Button } from '@/components/ui/button'

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
