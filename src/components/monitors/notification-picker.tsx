'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { Control } from 'react-hook-form'

import { ProviderIcon } from '@/components/notifications/provider-icon'
import { Badge } from '@/components/ui/badge'
import { FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import type { MonitorFormInput, MonitorFormValues } from '@/lib/validation/monitor'
import { cn } from '@/lib/utils'
import type { MonitorChannelOption } from '@/server/monitors/page-data'

/**
 * Notification channel picker of the monitor form: one switch per channel of the organization.
 * Paused channels are listed only when already attached, so they can be detached.
 */
export function NotificationPicker({
  control,
  channels,
  orgSlug,
}: {
  control: Control<MonitorFormInput, unknown, MonitorFormValues>
  channels: MonitorChannelOption[]
  orgSlug: string
}) {
  const t = useTranslations('monitors.channels')

  return (
    <FormField
      control={control}
      name="notifications"
      render={({ field }) => {
        const selected = (field.value as (string | number)[] | undefined) ?? []
        const selectedKeys = new Set(selected.map(String))
        const visible = channels.filter((c) => c.active || selectedKeys.has(String(c.id)))
        const toggle = (channel: MonitorChannelOption, on: boolean) =>
          field.onChange(
            on
              ? [...selected, channel.id]
              : selected.filter((id) => String(id) !== String(channel.id)),
          )
        return (
          <FormItem>
            <FormLabel className="sr-only">{t('title')}</FormLabel>
            {visible.length === 0 ? (
              <FormDescription>{t('empty')}</FormDescription>
            ) : (
              <ul className="divide-y rounded-lg border" data-testid="monitor-notifications">
                {visible.map((channel) => {
                  const checked = selectedKeys.has(String(channel.id))
                  const inputId = `monitor-channel-${channel.id}`
                  return (
                    <li
                      key={String(channel.id)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5',
                        !channel.active && 'text-muted-foreground',
                      )}
                    >
                      <ProviderIcon group={channel.group} />
                      <label htmlFor={inputId} className="flex min-w-0 flex-1 flex-col">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <span className="truncate">{channel.name}</span>
                          {channel.isDefault && <Badge variant="secondary">{t('default')}</Badge>}
                          {!channel.active && <Badge variant="outline">{t('paused')}</Badge>}
                        </span>
                        <span className="text-xs text-muted-foreground">{channel.typeLabel}</span>
                      </label>
                      <Switch
                        id={inputId}
                        aria-label={t('toggle', { name: channel.name })}
                        checked={checked}
                        onCheckedChange={(on) => toggle(channel, on)}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
            <FormDescription>
              {t('defaultsHint')}{' '}
              <Link href={`/${orgSlug}/notifications`} className="underline underline-offset-2">
                {t('manage')}
              </Link>
            </FormDescription>
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}
