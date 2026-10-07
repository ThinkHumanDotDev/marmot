'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

import { ROLES, type Role } from '@/access/permissions'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { orgApi } from '@/lib/org-api'

import { assignableRoles } from './role-badge'
import { RoleSelect } from './role-select'

type Values = { email: string; role: Role }

interface InviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string | number
  orgName: string
  viewerRole: Role | null
}

export function InviteDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  viewerRole,
}: InviteDialogProps) {
  const t = useTranslations('members.invite')
  const tv = useTranslations('auth.validation')
  const schema = React.useMemo(
    () => z.object({ email: z.email(tv('email')), role: z.enum(ROLES) }),
    [tv],
  )
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const options = assignableRoles(viewerRole)
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', role: 'member' },
  })

  React.useEffect(() => {
    if (!open) form.reset()
  }, [open, form])

  async function onSubmit(values: Values) {
    setPending(true)
    try {
      await orgApi.invite(orgId, values)
      toast.success(t('sent', { email: values.email }))
      onOpenChange(false)
      router.refresh()
    } catch (error) {
      form.setError('root', {
        message: error instanceof Error ? error.message : t('failed'),
      })
    } finally {
      setPending(false)
    }
  }

  const rootError = form.formState.errors.root?.message

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { organization: orgName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-5"
            noValidate
            data-testid="invite-form"
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('email')}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="off"
                      placeholder={t('emailPlaceholder')}
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
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('role')}</FormLabel>
                  <FormControl>
                    <RoleSelect
                      value={field.value}
                      onChange={field.onChange}
                      options={options}
                      className="w-full"
                      withDescriptions
                      aria-label={t('roleLabel')}
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
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t('sending') : t('send')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
