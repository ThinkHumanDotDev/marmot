'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
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

type Values = { password: string; confirm: string }

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations('auth.resetPassword')
  const tf = useTranslations('auth.fields')
  const tv = useTranslations('auth.validation')
  const schema = React.useMemo(
    () =>
      z
        .object({
          password: z.string().min(8, tv('passwordMin')),
          confirm: z.string(),
        })
        .refine((v) => v.password === v.confirm, {
          message: tv('passwordsMismatch'),
          path: ['confirm'],
        }),
    [tv],
  )
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  })

  async function onSubmit(values: Values) {
    setPending(true)
    try {
      // Payload signs the user in as part of a successful reset.
      await authApi.resetPassword({ token, password: values.password })
      toast.success(t('updated'))
      router.replace('/')
      router.refresh()
    } catch (error) {
      form.setError('root', {
        message: error instanceof Error ? error.message : t('failed'),
      })
      setPending(false)
    }
  }

  const rootError = form.formState.errors.root?.message

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tf('newPassword')}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirm"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tf('confirmPassword')}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
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
      </form>
    </Form>
  )
}
