'use client'

import { Loader2, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

import { notificationsApi, type ChannelMonitorRow, type NotificationRow } from './types'

interface ChannelMonitorsDialogProps {
  orgId: string
  /** Channel whose monitors are edited; `null` closes the dialog. */
  channel: NotificationRow | null
  onOpenChange: (open: boolean) => void
}

/** The channel's "Monitors" section: attach the channel to monitors or detach it from them. */
export function ChannelMonitorsDialog({
  orgId,
  channel,
  onOpenChange,
}: ChannelMonitorsDialogProps) {
  return (
    <Dialog open={channel !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Keyed by channel so every opening starts from a fresh load. */}
        {channel && (
          <ChannelMonitorsBody
            key={channel.id}
            orgId={orgId}
            channel={channel}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ChannelMonitorsBody({
  orgId,
  channel,
  onOpenChange,
}: {
  orgId: string
  channel: NotificationRow
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('notifications.monitors')
  const [monitors, setMonitors] = React.useState<ChannelMonitorRow[] | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const channelId = channel.id

  React.useEffect(() => {
    let cancelled = false
    notificationsApi
      .monitors(orgId, channelId)
      .then((rows) => {
        if (cancelled) return
        setMonitors(rows)
        setSelected(new Set(rows.filter((row) => row.attached).map((row) => row.id)))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        toast.error(t('loadFailed'), {
          description: error instanceof Error ? error.message : undefined,
        })
        onOpenChange(false)
      })
    return () => {
      cancelled = true
    }
  }, [orgId, channelId, onOpenChange, t])

  const needle = query.trim().toLowerCase()
  const visible = (monitors ?? []).filter(
    (row) => !needle || row.name.toLowerCase().includes(needle),
  )

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const setVisible = (on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const row of visible) {
        if (on) next.add(row.id)
        else next.delete(row.id)
      }
      return next
    })

  async function save() {
    setSaving(true)
    try {
      await notificationsApi.setMonitors(orgId, channelId, [...selected])
      toast.success(t('saved'))
      onOpenChange(false)
    } catch (error) {
      toast.error(t('saveFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title', { name: channel.name })}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>

      {monitors === null ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        </div>
      ) : monitors.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="relative">
            <Search
              className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="pl-8"
              aria-label={t('search')}
              placeholder={t('search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('selected', { count: selected.size })}</span>
            <span className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setVisible(true)}>
                {t('selectAll')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setVisible(false)}>
                {t('clear')}
              </Button>
            </span>
          </div>
          {visible.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{t('noMatch')}</p>
          ) : (
            <ul
              className="max-h-80 divide-y overflow-y-auto rounded-lg border"
              data-testid="channel-monitors"
            >
              {visible.map((row) => {
                const inputId = `channel-monitor-${row.id}`
                return (
                  <li
                    key={row.id}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2',
                      !row.active && 'text-muted-foreground',
                    )}
                  >
                    <label
                      htmlFor={inputId}
                      className="flex min-w-0 flex-1 items-center gap-2 text-sm"
                    >
                      <span className="truncate font-medium">{row.name}</span>
                      {!row.active && <Badge variant="outline">{t('paused')}</Badge>}
                    </label>
                    <Switch
                      id={inputId}
                      aria-label={t('toggle', { name: row.name })}
                      checked={selected.has(row.id)}
                      onCheckedChange={(on) => toggle(row.id, on)}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button onClick={() => void save()} disabled={saving || monitors === null}>
          {saving && <Loader2 className="animate-spin" />}
          {t('save')}
        </Button>
      </DialogFooter>
    </>
  )
}
