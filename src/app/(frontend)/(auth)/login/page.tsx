import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import { getAuthProviders, ssoErrorMessage } from '@/auth/sso'
import { AuthCard } from '@/components/auth/auth-card'
import { LoginForm } from '@/components/auth/login-form'
import { SsoButtons } from '@/components/auth/sso-button'
import config from '@payload-config'
import { getCurrentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/utils'
import { isSignupAllowed } from '@/server/settings'
import { hasAnyEnabledConnection } from '@/server/sso/connections'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.login')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; two_factor?: string }>
}) {
  const { next, error, two_factor } = await searchParams
  const user = await getCurrentUser()
  if (user) redirect(safeNextPath(next))
  const payload = await getPayload({ config })
  const [signupEnabled, orgSso] = await Promise.all([
    isSignupAllowed(payload),
    hasAnyEnabledConnection(payload),
  ])
  const t = await getTranslations('auth.login')

  // Same data `GET /api/auth/providers` returns, read in-process to avoid a self-request.
  const providers = getAuthProviders()
  const ssoError = ssoErrorMessage(error)

  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        !signupEnabled
          ? undefined
          : t.rich('noAccount', {
              link: (chunks) => (
                <Link
                  href="/signup"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })
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
        {orgSso && (
          <p className="text-center text-sm text-muted-foreground">
            <Link
              href={next ? `/login/sso?next=${encodeURIComponent(next)}` : '/login/sso'}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Sign in with your organization&apos;s SSO
            </Link>
          </p>
        )}
      </div>
    </AuthCard>
  )
}
