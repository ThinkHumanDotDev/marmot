'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { LoginForm } from '@/components/auth/login-form'
import { Button } from '@/components/ui/button'
import { ApiError, authApi } from '@/lib/api'
import { safeNextPath } from '@/lib/utils'

/**
 * Redeems an email sign-in link on click (#164). Afterwards the browser is signed in, or (two-factor
 * authentication) the code step of the login form takes over with the challenge cookie the
 * response set.
 */
export function MagicLinkConfirm({ token, next }: { token: string; next?: string }) {
  const t = useTranslations('auth.magicLink')
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [twoFactor, setTwoFactor] = React.useState(false)

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      const result = await authApi.verifyMagicLink(token)
      if (result.requiresTwoFactor) {
        setTwoFactor(true)
        return
      }
      router.replace(safeNextPath(next))
      router.refresh()
    } catch (err) {
      setError(
        err instanceof ApiError && err.status !== 400 && err.message ? err.message : t('invalid'),
      )
      setPending(false)
    }
  }

  if (twoFactor) {
    return (
      <div className="flex flex-col gap-4" data-testid="magic-link-two-factor">
        <p className="text-sm font-medium">{t('twoFactorTitle')}</p>
        <LoginForm next={next} twoFactor />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Link
            href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('requestNew')}
          </Link>
        </div>
      )}
      {!error && (
        <Button type="button" className="w-full" onClick={confirm} disabled={pending}>
          {pending ? t('confirming') : t('confirm')}
        </Button>
      )}
    </div>
  )
}
