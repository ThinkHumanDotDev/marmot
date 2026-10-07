'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { MailCheck } from 'lucide-react'
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
import { authApi } from '@/lib/api'

type Values = { email: string }

/** `local`: the break-glass reset of the SSO-only mode (`/forgot-password?local=1`). */
export function ForgotPasswordForm({ local = false }: { local?: boolean }) {
  const t = useTranslations('auth.forgotPassword')
  const tf = useTranslations('auth.fields')
  const tv = useTranslations('auth.validation')
  const schema = React.useMemo(() => z.object({ email: z.email(tv('email')) }), [tv])
  const [pending, setPending] = React.useState(false)
  const [sentTo, setSentTo] = React.useState<string | null>(null)
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '' } })

  async function onSubmit(values: Values) {
    setPending(true)
    try {
      await authApi.forgotPassword(values, { local })
    } catch {
      // Payload answers 200 for unknown addresses; a transport error still shouldn't leak
      // whether the account exists, so we show the same confirmation.
    }
    setSentTo(values.email)
    setPending(false)
  }

  if (sentTo) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <MailCheck className="size-5" aria-hidden />
        </span>
        <p className="text-sm">
          {t.rich('sent', { email: () => <span className="font-medium">{sentTo}</span> })}
        </p>
      </div>
    )
  }

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
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </form>
    </Form>
  )
}
