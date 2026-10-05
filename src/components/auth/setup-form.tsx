'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
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
import { validateOrganizationSlug } from '@/lib/reserved-slugs'

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

const schema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(120),
  email: z.email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters'),
  organizationName: z.string().trim().min(1, 'Enter an organization name').max(120),
  organizationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .refine((slug) => validateOrganizationSlug(slug) === true, {
      error: (issue) => {
        const result = validateOrganizationSlug(issue.input)
        return typeof result === 'string' ? result : 'Invalid slug.'
      },
    }),
})

type Values = z.infer<typeof schema>

interface SetupResponse {
  redirectTo: string
  organization: { slug: string }
}

export function SetupForm() {
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
      toast.success('Marmot is ready')
      router.replace(result.redirectTo || `/${result.organization.slug}/monitors`)
      router.refresh()
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 409
          ? 'Setup has already been completed. Please sign in.'
          : error instanceof Error
            ? error.message
            : 'Could not complete setup.'
      form.setError('root', { message })
      setPending(false)
    }
  }

  const rootError = form.formState.errors.root?.message

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        <div className="flex flex-col gap-5">
          <h2 className="text-sm font-medium text-muted-foreground">Administrator account</h2>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" placeholder="Ada Lovelace" autoFocus {...field} />
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
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
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
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormDescription>At least 8 characters.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Separator />

        <div className="flex flex-col gap-5">
          <h2 className="text-sm font-medium text-muted-foreground">Organization</h2>
          <FormField
            control={form.control}
            name="organizationName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization name</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="organization"
                    placeholder="Acme Inc."
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
                <FormLabel>URL slug</FormLabel>
                <FormControl>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="acme"
                    {...field}
                    onChange={(event) => {
                      setSlugEdited(event.target.value.length > 0)
                      field.onChange(event)
                    }}
                  />
                </FormControl>
                <FormDescription>
                  Lowercase letters, numbers and hyphens. Your dashboard lives at /
                  {field.value || 'your-org'}.
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
          {pending ? 'Setting up…' : 'Create admin account'}
        </Button>
      </form>
    </Form>
  )
}
