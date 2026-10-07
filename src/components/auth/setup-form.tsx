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
import { Separator } from '@/components/ui/separator'
import { api, ApiError } from '@/lib/api'
import { SLUG_ERROR_KEYS, validateOrganizationSlug, type SlugMessage } from '@/lib/reserved-slugs'

/** "Acme Corp." → "acme-corp"; mirrors the server-side slug rules. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
}

type Values = {
  name: string
  email: string
  password: string
  organizationName: string
  organizationSlug: string
}

type Validation = ReturnType<typeof useTranslations<'auth.validation'>>

const buildSchema = (tv: Validation, slugMessage: SlugMessage) =>
  z.object({
    name: z.string().trim().min(1, tv('nameRequired')).max(120),
    email: z.email(tv('email')),
    password: z.string().min(8, tv('passwordMin')),
    organizationName: z.string().trim().min(1, tv('organizationNameRequired')).max(120),
    organizationSlug: z
      .string()
      .trim()
      .toLowerCase()
      .refine((slug) => validateOrganizationSlug(slug) === true, {
        error: (issue) => {
          // The slug rules are shared with the API in src/lib/reserved-slugs.
          const result = validateOrganizationSlug(issue.input, slugMessage)
          return typeof result === 'string' ? result : tv('slugInvalid')
        },
      }),
  })

interface SetupResponse {
  redirectTo: string
  organization: { slug: string }
}

export function SetupForm() {
  const t = useTranslations('auth.setup')
  const tf = useTranslations('auth.fields')
  const tv = useTranslations('auth.validation')
  const te = useTranslations('errors')
  const schema = React.useMemo(
    () => buildSchema(tv, (problem, slug) => te(SLUG_ERROR_KEYS[problem], { slug })),
    [tv, te],
  )
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [slugEdited, setSlugEdited] = React.useState(false)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      password: '',
      organizationName: '',
      organizationSlug: '',
    },
  })

  async function onSubmit(values: Values) {
    setPending(true)
    try {
      const result = await api.post<SetupResponse>('/api/setup', values)
      toast.success(t('ready'))
      router.replace(result.redirectTo || `/${result.organization.slug}/monitors`)
      router.refresh()
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 409
          ? t('alreadyDone')
          : error instanceof Error
            ? error.message
            : t('failed')
      form.setError('root', { message })
      setPending(false)
    }
  }

  const rootError = form.formState.errors.root?.message

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-5">
          <h2 className="text-sm font-medium text-muted-foreground">{t('adminSection')}</h2>
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
        </div>

        <Separator />

        <div className="flex flex-col gap-5">
          <h2 className="text-sm font-medium text-muted-foreground">{t('organizationSection')}</h2>
          <FormField
            control={form.control}
            name="organizationName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('organizationName')}</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="organization"
                    placeholder={t('organizationNamePlaceholder')}
                    {...field}
                    onChange={(event) => {
                      field.onChange(event)
                      if (!slugEdited) {
                        form.setValue('organizationSlug', slugify(event.target.value), {
                          shouldValidate: form.formState.touchedFields.organizationSlug === true,
                        })
                      }
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="organizationSlug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('slug')}</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('slugPlaceholder')}
                    {...field}
                    onChange={(event) => {
                      setSlugEdited(event.target.value.length > 0)
                      field.onChange(event)
                    }}
                  />
                </FormControl>
                <FormDescription>
                  {t('slugHint', { slug: field.value || t('slugExample') })}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

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
