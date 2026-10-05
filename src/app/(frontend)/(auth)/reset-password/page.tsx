import type { Metadata } from 'next'
import Link from 'next/link'

import { AuthCard } from '@/components/auth/auth-card'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Choose a new password' }

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return (
      <AuthCard
        title="Reset link missing"
        description="This page needs the token from your reset email. Open the link in the email, or request a new one."
      >
        <Button asChild className="w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="You will be signed in once the password is updated."
      footer={
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      }
    >
      <ResetPasswordForm token={token} />
    </AuthCard>
  )
}
