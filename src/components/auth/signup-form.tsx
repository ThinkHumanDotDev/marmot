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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { authApi } from '@/lib/api'
import { safeNextPath } from '@/lib/utils'

type Values = { name: string; email: string; password: string }

export function SignupForm({ next }: { next?: string }) {
  const t = useTranslations('auth.signup')
  const tf = useTranslations('auth.fields')
  const tv = useTranslations('auth.validation')
  const schema = React.useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, tv('nameRequired')).max(120),
        email: z.email(tv('email')),
        password: z.string().min(8, tv('passwordMin')),
      }),
    [tv],
  )
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '' },
  })

  async function onSubmit(values: Values) {
    setPending(true)
    try {
      await authApi.signup(values)
      await authApi.login({ email: values.email, password: values.password })
      toast.success(t('welcome'))
      router.replace(safeNextPath(next))
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
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tf('name')}</FormLabel>
              <FormControl>
                <Input
                  autoComplete="name"
                  placeholder={tf('namePlaceholder')}
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
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tf('email')}</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder={tf('emailPlaceholder')}
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
              <FormLabel>{tf('password')}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormDescription>{tf('passwordHint')}</FormDescription>
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
