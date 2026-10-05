import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { AuthCard } from '@/components/auth/auth-card'
import { LoginForm } from '@/components/auth/login-form'
import { env } from '@/env'
import { getCurrentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/utils'

export const metadata: Metadata = { title: 'Sign in' }
export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const user = await getCurrentUser()
  if (user) redirect(safeNextPath(next))

  return (
    <AuthCard
      title="Sign in to Marmot"
      description="Welcome back. Enter your credentials to continue."
      footer={
        env.DISABLE_SIGNUP ? undefined : (
          <>
            No account yet?{' '}
            <Link
              href="/signup"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Create one
            </Link>
          </>
        )
      }
    >
      <LoginForm next={next} />
    </AuthCard>
  )
}
