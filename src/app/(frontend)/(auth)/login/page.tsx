import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { getAuthProviders, ssoErrorMessage } from '@/auth/sso'
import { AuthCard } from '@/components/auth/auth-card'
import { LoginForm } from '@/components/auth/login-form'
import { SsoButtons } from '@/components/auth/sso-button'
import config from '@payload-config'
import { getCurrentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/utils'
import { isSignupAllowed } from '@/server/settings'

export const metadata: Metadata = { title: 'Sign in' }
export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; two_factor?: string }>
}) {
  const { next, error, two_factor } = await searchParams
  const user = await getCurrentUser()
  if (user) redirect(safeNextPath(next))
  const signupEnabled = await isSignupAllowed(await getPayload({ config }))

  // Same data `GET /api/auth/providers` returns, read in-process to avoid a self-request.
  const providers = getAuthProviders()
  const ssoError = ssoErrorMessage(error)

  return (
    <AuthCard
      title="Sign in to Marmot"
      description="Welcome back. Enter your credentials to continue."
      footer={
        !signupEnabled ? undefined : (
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
      <div className="flex flex-col gap-5">
        {ssoError && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {ssoError}
          </p>
        )}
        <SsoButtons providers={providers.providers} next={next} />
        <LoginForm next={next} twoFactor={two_factor === '1'} />
      </div>
    </AuthCard>
  )
}
