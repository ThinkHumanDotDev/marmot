import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { AuthCard } from '@/components/auth/auth-card'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.forgotPassword')
  return { title: t('pageTitle') }
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth.forgotPassword')
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
      <ForgotPasswordForm />
    </AuthCard>
  )
}
