'use client'

import { MailCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { accountApi } from '@/lib/org-api'
import { authApi } from '@/lib/api'
import { safeNextPath } from '@/lib/utils'

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/**
 * "Check your inbox" screen of an account that has not confirmed its address yet (#177): resend
 * the link (rate limited), fix a mistyped address, continue once confirmed, or sign out.
 */
export function VerifyEmailPending({
  userId,
  email,
  next,
}: {
  userId: string | number
  email: string
  next?: string
}) {
  const t = useTranslations('auth.verifyEmail')
  const router = useRouter()
  const [address, setAddress] = React.useState(email)
  const [busy, setBusy] = React.useState<'resend' | 'change' | 'signOut' | null>(null)
  const [newEmail, setNewEmail] = React.useState('')
  const inputId = React.useId()

  async function resend() {
    setBusy('resend')
    try {
      await authApi.resendVerification()
      toast.success(t('resent'))
    } catch (error) {
      toast.error(message(error, t('resendFailed')))
    } finally {
      setBusy(null)
    }
  }

  async function changeEmail(event: React.FormEvent) {
    event.preventDefault()
    const value = newEmail.trim()
    if (!value) return
    setBusy('change')
    try {
      const { doc } = await accountApi.update(userId, { email: value })
      setAddress(doc.email)
      setNewEmail('')
      toast.success(t('emailChanged', { email: doc.email }))
    } catch (error) {
      toast.error(message(error, t('changeFailed')))
    } finally {
      setBusy(null)
    }
  }

  async function signOut() {
    setBusy('signOut')
    try {
      await authApi.logout()
    } finally {
      router.replace('/login')
      router.refresh()
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <MailCheck className="size-5" aria-hidden />
        </span>
        <p className="text-sm" data-testid="verify-email-address">
          {t.rich('description', {
            email: address,
            strong: (chunks) => <span className="font-medium">{chunks}</span>,
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t('blocked')}</p>
      </div>
      <Button
        type="button"
        className="w-full"
        onClick={() => {
          router.replace(safeNextPath(next))
          router.refresh()
        }}
        disabled={busy !== null}
      >
        {t('continue')}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={resend}
        disabled={busy !== null}
      >
        {busy === 'resend' ? t('resending') : t('resend')}
      </Button>
      <form onSubmit={changeEmail} className="grid gap-2 border-t pt-5">
        <Label htmlFor={inputId}>{t('wrongAddress')}</Label>
        <Input
          id={inputId}
          type="email"
          autoComplete="email"
          placeholder={t('newEmail')}
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy !== null || !newEmail.trim()}>
          {busy === 'change' ? t('changingEmail') : t('changeEmail')}
        </Button>
      </form>
      <Button type="button" variant="ghost" onClick={signOut} disabled={busy !== null}>
        {t('signOut')}
      </Button>
    </div>
  )
}

/**
 * Target of the link in the verification email. The token is only redeemed when the person
 * clicks, so mail scanners that prefetch links cannot use it up.
 */
export function VerifyEmailConfirm({
  token,
  signedIn,
  next,
}: {
  token: string
  signedIn: boolean
  next?: string
}) {
  const t = useTranslations('auth.verifyEmail')
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [confirmed, setConfirmed] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      const result = await authApi.verifyEmail(token)
      setConfirmed(result.email)
    } catch (err) {
      setError(message(err, t('confirmFailed')))
    } finally {
      setPending(false)
    }
  }

  if (confirmed) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-center text-sm" data-testid="verify-email-confirmed">
          {t('confirmedDescription', { email: confirmed })}
        </p>
        <Button
          type="button"
          className="w-full"
          onClick={() => {
            router.replace(signedIn ? safeNextPath(next) : '/login')
            router.refresh()
          }}
        >
          {signedIn ? t('toDashboard') : t('toSignIn')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="button" className="w-full" onClick={confirm} disabled={pending}>
        {pending ? t('confirming') : t('confirm')}
      </Button>
    </div>
  )
}
