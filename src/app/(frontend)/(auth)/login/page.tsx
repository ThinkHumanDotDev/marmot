import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import { getAuthProviders, isSsoErrorCode } from '@/auth/sso'
import { AuthCard } from '@/components/auth/auth-card'
import { LoginForm } from '@/components/auth/login-form'
import { SsoButtons } from '@/components/auth/sso-button'
import config from '@payload-config'
import { getCurrentUser } from '@/lib/auth'
import { DEMO_ACCOUNT, isDemoMode } from '@/server/demo/config'
import { safeNextPath } from '@/lib/utils'
import { isSignupAllowed } from '@/server/settings'
import { hasAnyEnabledConnection } from '@/server/sso/connections'
import { isBreakGlassEnabled, isLocalLoginDisabled } from '@/server/sso/local-login'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.login')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; two_factor?: string; local?: string }>
}) {
  const { next, error, two_factor, local } = await searchParams
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
  const tSsoErrors = await getTranslations('auth.ssoErrors')
  const ssoError = isSsoErrorCode(error) ? tSsoErrors(error) : undefined
  // SSO-only mode hides the password form; `?local=1` shows it to break-glass superadmins. The
  // code step after a single sign-on with two-factor authentication always renders.
  const localDisabled = isLocalLoginDisabled()
  const breakGlass = localDisabled && isBreakGlassEnabled() && local === '1'
  const showPasswordForm = !localDisabled || breakGlass || two_factor === '1'
  // Demo mode (#159): everyone signs in with the shared demo account, pre-filled.
  const demo = isDemoMode()
    ? { email: DEMO_ACCOUNT.email, password: DEMO_ACCOUNT.password }
    : undefined
  const tDemo = await getTranslations('shell.demo')

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
        {breakGlass && (
          <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
            {t('breakGlass')}
          </p>
        )}
        {demo && (
          <p
            data-testid="demo-credentials"
            className="rounded-md border border-status-pending/40 bg-status-pending/10 px-3 py-2 text-sm"
          >
            {tDemo.rich('credentials', {
              email: demo.email,
              password: demo.password,
              code: (chunks) => <code className="font-mono font-medium">{chunks}</code>,
            })}
          </p>
        )}
        {showPasswordForm ? (
          <LoginForm
            next={next}
            twoFactor={two_factor === '1'}
            local={breakGlass}
            defaultCredentials={demo}
          />
        ) : (
          <p className="text-center text-sm text-muted-foreground">{t('localDisabled')}</p>
        )}
        {orgSso && (
          <p className="text-center text-sm text-muted-foreground">
            <Link
              href={next ? `/login/sso?next=${encodeURIComponent(next)}` : '/login/sso'}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t('organizationSso')}
            </Link>
          </p>
        )}
      </div>
    </AuthCard>
  )
}
