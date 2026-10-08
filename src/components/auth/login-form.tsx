'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { ApiError, authApi } from '@/lib/api'
import { MAGIC_LINK_TTL_MINUTES } from '@/lib/magic-link'
import { safeNextPath } from '@/lib/utils'

type Values = { email: string; password: string }

type CodeValues = { code: string }

interface LoginFormProps {
  next?: string
  /** Start on the code step: single sign-on already succeeded and the account has 2FA. */
  twoFactor?: boolean
  /** Break-glass login of the SSO-only mode: posts with `?local=1`. */
  local?: boolean
  /** Offer "Email me a sign-in link" (#164, `magicLinkEnabled`). */
  magicLink?: boolean
}

/**
 * Password login with an optional second step. `POST /api/auth/login` answers
 * `requiresTwoFactor` for protected accounts; the code (authenticator or backup) then goes to
 * `POST /api/auth/2fa`, which sets the session cookie.
 */
export function LoginForm({
  next,
  twoFactor = false,
  local = false,
  magicLink = false,
}: LoginFormProps) {
  const t = useTranslations('auth.login')
  const tf = useTranslations('auth.fields')
  const tv = useTranslations('auth.validation')
  const schema = React.useMemo(
    () =>
      z.object({
        email: z.email(tv('email')),
        password: z.string().min(1, tv('passwordRequired')),
      }),
    [tv],
  )
  const codeSchema = React.useMemo(
    () => z.object({ code: z.string().trim().min(6, tv('code')) }),
    [tv],
  )
  const router = useRouter()
  const [step, setStep] = React.useState<'password' | 'code' | 'magic-link'>(
    twoFactor ? 'code' : 'password',
  )
  const [challenge, setChallenge] = React.useState<string | undefined>()
  const [pending, setPending] = React.useState(false)
  const [useBackup, setUseBackup] = React.useState(false)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  })
  const codeForm = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: '' },
  })

  function finish() {
    router.replace(safeNextPath(next))
    router.refresh()
  }

  async function onSubmit(values: Values) {
    setPending(true)
    try {
      const result = await authApi.login(values, { local })
      if (result.requiresTwoFactor) {
        setChallenge(result.challenge)
        setStep('code')
        setPending(false)
        return
      }
      finish()
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 401
          ? t('invalidCredentials')
          : error instanceof Error
            ? error.message
            : t('failed')
      form.setError('root', { message })
      setPending(false)
    }
  }

  async function onSubmitCode(values: CodeValues) {
    setPending(true)
    try {
      await authApi.twoFactor({ code: values.code, challenge })
      finish()
    } catch (error) {
      const expired = error instanceof ApiError && (error.status === 429 || !challengeAlive(error))
      if (expired) {
        setStep('password')
        setChallenge(undefined)
        codeForm.reset()
        form.setError('root', {
          message: error instanceof Error ? error.message : t('twoFactor.passwordAgain'),
        })
      } else {
        codeForm.setError('root', {
          message: error instanceof Error ? error.message : t('twoFactor.invalidCode'),
        })
      }
      setPending(false)
    }
  }

  if (step === 'magic-link') {
    return (
      <MagicLinkRequestForm
        next={next}
        initialEmail={form.getValues('email')}
        onUsePassword={() => setStep('password')}
      />
    )
  }

  if (step === 'code') {
    const rootError = codeForm.formState.errors.root?.message
    return (
      <Form {...codeForm}>
        <form
          onSubmit={codeForm.handleSubmit(onSubmitCode)}
          className="flex flex-col gap-5"
          noValidate
        >
          <p className="text-sm text-muted-foreground">
            {useBackup ? t('twoFactor.backupHint') : t('twoFactor.authenticatorHint')}
          </p>
          <FormField
            control={codeForm.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {useBackup ? t('twoFactor.backupCodeLabel') : t('twoFactor.codeLabel')}
                </FormLabel>
                <FormControl>
                  <Input
                    inputMode={useBackup ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    placeholder={useBackup ? 'xxxxx-xxxxx' : '123456'}
                    autoFocus
                    spellCheck={false}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {rootError && (
            <p role="alert" className="text-sm text-destructive">
              {rootError}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t('twoFactor.verifying') : t('twoFactor.verify')}
          </Button>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <button
              type="button"
              className="underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => {
                setUseBackup((v) => !v)
                codeForm.reset()
              }}
            >
              {useBackup ? t('twoFactor.useAuthenticator') : t('twoFactor.useBackupCode')}
            </button>
            {!twoFactor && (
              <button
                type="button"
                className="underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => {
                  setStep('password')
                  setChallenge(undefined)
                  codeForm.reset()
                }}
              >
                {t('twoFactor.back')}
              </button>
            )}
          </div>
        </form>
      </Form>
    )
  }

  const rootError = form.formState.errors.root?.message

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tf('email')}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder={tf('emailPlaceholder')}
                  autoFocus
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>{tf('password')}</FormLabel>
                <Link
                  href={local ? '/forgot-password?local=1' : '/forgot-password'}
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {tf('forgotPassword')}
                </Link>
              </div>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {rootError && (
          <p role="alert" className="text-sm text-destructive">
            {rootError}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
        {magicLink && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => setStep('magic-link')}
            data-testid="use-magic-link"
          >
            {t('magicLink.use')}
          </Button>
        )}
      </form>
    </Form>
  )
}

/**
 * "Email me a sign-in link" (#164). The answer never says whether the address has an account, so
 * the confirmation reads the same for everyone.
 */
function MagicLinkRequestForm({
  next,
  initialEmail,
  onUsePassword,
}: {
  next?: string
  initialEmail: string
  onUsePassword: () => void
}) {
  const t = useTranslations('auth.login.magicLink')
  const tf = useTranslations('auth.fields')
  const tv = useTranslations('auth.validation')
  const schema = React.useMemo(() => z.object({ email: z.email(tv('email')) }), [tv])
  const form = useForm<{ email: string }>({
    resolver: zodResolver(schema),
    defaultValues: { email: initialEmail },
  })
  const [sentTo, setSentTo] = React.useState<string | null>(null)

  async function onSubmit(values: { email: string }) {
    try {
      await authApi.requestMagicLink({ email: values.email, next })
      setSentTo(values.email)
    } catch (error) {
      form.setError('root', { message: error instanceof Error ? error.message : t('failed') })
    }
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-4" data-testid="magic-link-sent">
        <p className="text-sm font-medium">{t('sentTitle')}</p>
        <p className="text-sm text-muted-foreground">
          {t.rich('sent', {
            minutes: MAGIC_LINK_TTL_MINUTES,
            email: () => <span className="font-medium text-foreground">{sentTo}</span>,
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSentTo(null)
            form.reset({ email: '' })
          }}
        >
          {t('again')}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={onUsePassword}
        >
          {t('usePassword')}
        </button>
      </div>
    )
  }

  const rootError = form.formState.errors.root?.message
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tf('email')}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder={tf('emailPlaceholder')}
                  autoFocus
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {rootError && (
          <p role="alert" className="text-sm text-destructive">
            {rootError}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('submitting') : t('submit')}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={onUsePassword}
        >
          {t('usePassword')}
        </button>
      </form>
    </Form>
  )
}

/** 401 with the challenge gone (expired / exhausted) sends the user back to the password step. */
function challengeAlive(error: ApiError): boolean {
  if (error.status !== 401) return true
  return !/expired|password again/i.test(error.message)
}
