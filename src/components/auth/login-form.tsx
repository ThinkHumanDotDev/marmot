'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import { safeNextPath } from '@/lib/utils'

const schema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
})

type Values = z.infer<typeof schema>

const codeSchema = z.object({
  code: z.string().trim().min(6, 'Enter the 6-digit code or a backup code'),
})

type CodeValues = z.infer<typeof codeSchema>

interface LoginFormProps {
  next?: string
  /** Start on the code step: single sign-on already succeeded and the account has 2FA. */
  twoFactor?: boolean
}

/**
 * Password login with an optional second step. `POST /api/auth/login` answers
 * `requiresTwoFactor` for protected accounts; the code (authenticator or backup) then goes to
 * `POST /api/auth/2fa`, which sets the session cookie.
 */
export function LoginForm({ next, twoFactor = false }: LoginFormProps) {
  const router = useRouter()
  const [step, setStep] = React.useState<'password' | 'code'>(twoFactor ? 'code' : 'password')
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
      const result = await authApi.login(values)
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
          ? 'Incorrect email or password.'
          : error instanceof Error
            ? error.message
            : 'Could not sign in.'
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
          message: error instanceof Error ? error.message : 'Enter your password again.',
        })
      } else {
        codeForm.setError('root', {
          message: error instanceof Error ? error.message : 'That code is not valid.',
        })
      }
      setPending(false)
    }
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
            {useBackup
              ? 'Enter one of the backup codes you saved when you set up two-factor authentication.'
              : 'Enter the 6-digit code from your authenticator app to finish signing in.'}
          </p>
          <FormField
            control={codeForm.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{useBackup ? 'Backup code' : 'Authentication code'}</FormLabel>
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
            {pending ? 'Verifying…' : 'Verify'}
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
              {useBackup ? 'Use your authenticator app' : 'Use a backup code'}
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
                Back
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
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
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
                <FormLabel>Password</FormLabel>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Forgot password?
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
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Form>
  )
}

/** 401 with the challenge gone (expired / exhausted) sends the user back to the password step. */
function challengeAlive(error: ApiError): boolean {
  if (error.status !== 401) return true
  return !/expired|password again/i.test(error.message)
}
