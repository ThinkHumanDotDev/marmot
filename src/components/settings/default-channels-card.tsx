'use client'

import { Bell } from 'lucide-react'
import Link from 'next/link'
import * as React from 'react'
import { toast } from 'sonner'

import { notificationsApi, type NotificationRow } from '@/components/notifications/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface DefaultChannelsCardProps {
  orgId: string
  orgSlug: string
  channels: NotificationRow[]
  /** `notification:update` */
  canManage: boolean
}

/**
 * Which channels new monitors get attached to automatically (`notifications.isDefault`). Toggles
 * PATCH the channel through `/api/orgs/:orgId/notifications/:id`.
 */
export function DefaultChannelsCard({
  orgId,
  orgSlug,
  channels,
  canManage,
}: DefaultChannelsCardProps) {
  const [rows, setRows] = React.useState(channels)
  const [busy, setBusy] = React.useState<string | null>(null)

  async function toggle(row: NotificationRow, isDefault: boolean) {
    setBusy(row.id)
    setRows((list) => list.map((r) => (r.id === row.id ? { ...r, isDefault } : r)))
    try {
      await notificationsApi.update(orgId, row.id, { isDefault })
      toast.success(
        isDefault ? `${row.name} is now a default channel` : `${row.name} is no longer a default`,
      )
    } catch (error) {
      setRows((list) => list.map((r) => (r.id === row.id ? { ...r, isDefault: !isDefault } : r)))
      toast.error(error instanceof Error ? error.message : 'Could not update the channel.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default notification channels</CardTitle>
        <CardDescription>
          Default channels are attached to every new monitor automatically. Existing monitors keep
          their own selection.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        {rows.length === 0 ? (
          <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
            <p>This organization has no notification channels yet.</p>
            <Button asChild variant="outline" size="sm">
              <Link href={`/${orgSlug}/notifications`}>
                <Bell aria-hidden /> Add a channel
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => {
              const id = `default-${row.id}`
              return (
                <li key={row.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <Label htmlFor={id} className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{row.name}</span>
                      <span className="text-xs text-muted-foreground">{row.type}</span>
                      {!row.active && <Badge variant="outline">Paused</Badge>}
                    </Label>
                  </div>
                  <Switch
                    id={id}
                    checked={row.isDefault}
                    disabled={!canManage || busy === row.id}
                    onCheckedChange={(checked) => toggle(row, checked)}
                    aria-label={`Default for new monitors: ${row.name}`}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
