'use client'

import { Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { accountApi } from '@/lib/org-api'

interface DeleteAccountCardProps {
  email: string
  /** Names of organizations the user is the only owner of; deletion is blocked while non-empty. */
  soleOwnerOf: string[]
}

export function DeleteAccountCard({ email, soleOwnerOf }: DeleteAccountCardProps) {
  const t = useTranslations('settings.account.delete')
  const format = useFormatter()
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const blocked = soleOwnerOf.length > 0

  async function remove() {
    try {
      await accountApi.remove(email)
      toast.success(t('deleted'))
      router.replace('/login')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">{t('title')}</CardTitle>
        <CardDescription>
          {blocked
            ? t('blocked', {
                organizations: format.list(soleOwnerOf, { type: 'unit', style: 'short' }),
                count: soleOwnerOf.length,
              })
            : t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)} disabled={blocked}>
          <Trash2 /> {t('button')}
        </Button>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('confirmTitle')}
        description={t('confirmDescription')}
        confirmText={email}
        confirmLabel={t('confirm')}
        destructive
        onConfirm={remove}
      />
    </Card>
  )
}
