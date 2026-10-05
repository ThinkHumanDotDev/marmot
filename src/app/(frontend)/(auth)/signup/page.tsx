import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { AuthCard } from '@/components/auth/auth-card'
import { SignupForm } from '@/components/auth/signup-form'
import { env } from '@/env'
import { getCurrentUser } from '@/lib/auth'

export const metadata: Metadata = { title: 'Create account' }
export const dynamic = 'force-dynamic'

export default async function SignupPage() {
  if (env.DISABLE_SIGNUP) notFound()
  const user = await getCurrentUser()
  if (user) redirect('/')

  return (
    <AuthCard
      title="Create your account"
      description="Set up Marmot for your team in a minute."
      footer={
        <>
          Already have an account?{' '}
          <Link
            href="/login"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm />
    </AuthCard>
  )
}
