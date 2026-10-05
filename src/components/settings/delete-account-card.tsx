'use client'

import { Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const blocked = soleOwnerOf.length > 0

  async function remove() {
    try {
      await accountApi.remove(email)
      toast.success('Your account has been deleted')
      router.replace('/login')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete your account.')
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Delete account</CardTitle>
        <CardDescription>
          {blocked
            ? `You are the only owner of ${soleOwnerOf.join(', ')}. Transfer ownership or delete ${
                soleOwnerOf.length === 1 ? 'it' : 'them'
              } first.`
            : 'Permanently removes your account and all of your memberships. There is no undo.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)} disabled={blocked}>
          <Trash2 /> Delete my account
        </Button>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description="You will be signed out immediately and your data cannot be recovered."
        confirmText={email}
        confirmLabel="Delete account"
        destructive
        onConfirm={remove}
      />
    </Card>
  )
}
