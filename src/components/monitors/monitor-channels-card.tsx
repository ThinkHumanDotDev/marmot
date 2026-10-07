'use client'

import { Loader2, Send } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ProviderIcon } from '@/components/notifications/provider-icon'
import { notificationsApi } from '@/components/notifications/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { MonitorChannelOption } from '@/server/monitors/page-data'

/**
 * Channels attached to a monitor on its detail page. Everyone who can see the monitor sees the
 * list; users who may manage channels (`notification:update`) get a "Test" button per channel.
 */
export function MonitorChannelsCard({
  orgId,
  orgSlug,
  channels,
  canTest,
  canEdit,
}: {
  orgId: string | number
  orgSlug: string
  channels: MonitorChannelOption[]
  canTest: boolean
  canEdit: boolean
}) {
  const t = useTranslations('monitors.channels')
  const [testing, setTesting] = React.useState<string | null>(null)

  async function sendTest(channel: MonitorChannelOption) {
    setTesting(String(channel.id))
    try {
      const result = await notificationsApi.test(String(orgId), {
        notificationId: String(channel.id),
      })
      toast.success(t('testSent'), { description: result.result })
    } catch (error) {
      const details = error instanceof ApiError ? (error.details as { error?: string }) : null
      toast.error(t('testFailed'), {
        description: details?.error ?? (error instanceof Error ? error.message : undefined),
      })
    } finally {
      setTesting(null)
    }
  }

  return (
    <Card className="gap-3" data-testid="monitor-channels">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {channels.length === 0 ? (
          <p className="text-muted-foreground">{canEdit ? t('noneEditable') : t('none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {channels.map((channel) => (
              <li
                key={String(channel.id)}
                className={cn(
                  'flex items-center gap-2',
                  !channel.active && 'text-muted-foreground',
                )}
              >
                <ProviderIcon group={channel.group} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="truncate">{channel.name}</span>
                    {!channel.active && <Badge variant="outline">{t('paused')}</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">{channel.typeLabel}</span>
                </span>
                {canTest && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('testLabel', { name: channel.name })}
                    disabled={testing !== null}
                    onClick={() => void sendTest(channel)}
                  >
                    {testing === String(channel.id) ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Send />
                    )}
                    {t('test')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canTest && (
          <Link
            href={`/${orgSlug}/notifications`}
            className="mt-3 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t('manage')}
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
