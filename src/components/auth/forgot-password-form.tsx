'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { MailCheck } from 'lucide-react'
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

const schema = z.object({ email: z.email('Enter a valid email address') })
type Values = z.infer<typeof schema>

export function ForgotPasswordForm() {
  const [pending, setPending] = React.useState(false)
  const [sentTo, setSentTo] = React.useState<string | null>(null)
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '' } })

  async function onSubmit(values: Values) {
    setPending(true)
    try {
      await authApi.forgotPassword(values)
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
          If an account exists for <span className="font-medium">{sentTo}</span>, a reset link is on
          its way. It expires in one hour.
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
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </Form>
  )
}
