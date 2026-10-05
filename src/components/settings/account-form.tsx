'use client'

import { useRouter } from 'next/navigation'
import * as React from 'react'
import { toast } from 'sonner'

import { ImageUpload } from '@/components/image-upload'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { accountApi } from '@/lib/org-api'

interface AccountFormProps {
  user: { id: string | number; email: string; name: string; avatarUrl: string | null }
}

/** Profile: avatar, name and email. Writes to `PATCH /api/users/:id` (self only). */
export function AccountForm({ user }: AccountFormProps) {
  const router = useRouter()
  const [name, setName] = React.useState(user.name)
  const [email, setEmail] = React.useState(user.email)
  const [pending, setPending] = React.useState(false)
  const ids = { name: React.useId(), email: React.useId() }

  const dirty = name.trim() !== user.name || email.trim().toLowerCase() !== user.email
  const canSave = dirty && email.includes('@') && !pending

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setPending(true)
    try {
      await accountApi.update(user.id, { name: name.trim(), email: email.trim().toLowerCase() })
      toast.success('Profile updated')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update your profile.')
    } finally {
      setPending(false)
    }
  }

  async function setAvatar(media: { id: string | number } | null) {
    try {
      await accountApi.update(user.id, { avatar: media ? media.id : null })
      toast.success(media ? 'Avatar updated' : 'Avatar removed')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update your avatar.')
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>How teammates see you across organizations.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 pt-6">
          <div className="grid gap-2">
            <Label>Avatar</Label>
            <ImageUpload
              value={user.avatarUrl}
              label={user.name || user.email}
              onChange={setAvatar}
              shape="circle"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              id={ids.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={120}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.email}>Email</Label>
            <Input
              id={ids.email}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <p className="text-xs text-muted-foreground">
              Used to sign in and for notifications and invitations.
            </p>
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t pt-6">
          <Button type="submit" disabled={!canSave}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
