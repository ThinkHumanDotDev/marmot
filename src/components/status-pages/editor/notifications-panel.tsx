'use client'

import { RefreshCw } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  SUBSCRIBER_CHANNELS,
  smsSegments,
  type NotificationBatchState,
} from '@/lib/status-page-subscribers'
import { cn } from '@/lib/utils'

import { subscribersApi, type NotificationDetail, type NotificationRow, type OrgId } from '../api'

const STATE_STYLES: Record<NotificationBatchState, string> = {
  pending_review: 'bg-status-pending/15 text-foreground',
  sending: 'bg-status-maintenance/15 text-foreground',
  sent: 'bg-status-up/15 text-foreground',
  partially_failed: 'bg-status-pending/15 text-foreground',
  failed: 'bg-status-down/15 text-foreground',
  discarded: 'bg-muted text-muted-foreground',
}

function Detail({
  orgId,
  pageId,
  id,
  canSend,
  onChanged,
}: {
  orgId: OrgId
  pageId: OrgId
  id: OrgId
  canSend: boolean
  onChanged: () => void
}) {
  const t = useTranslations('statusPages.subscribers.notifications')
  const tc = useTranslations('statusPages.subscribe.channels')
  const format = useFormatter()
  const [detail, setDetail] = React.useState<NotificationDetail | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setDetail(await subscribersApi.notifications.get(orgId, pageId, id))
    } catch {
      toast.error(t('loadFailed'))
    }
  }, [orgId, pageId, id, t])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  async function act(action: 'send' | 'discard' | 'retry') {
    if (
      action === 'send' &&
      detail &&
      !window.confirm(t('sendConfirm', { count: detail.preview.recipients.total }))
    ) {
      return
    }
    setBusy(true)
    try {
      await subscribersApi.notifications.act(orgId, pageId, id, action)
      toast.success(t('actionDone'))
      await load()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!detail) return <div className="h-64 animate-pulse rounded-xl border bg-muted/30" />
  const { doc, preview, deliveries } = detail
  const counts = deliveries.counts
  const finished = doc.state !== 'pending_review' && doc.state !== 'discarded'

  return (
    <div className="flex flex-col gap-5 rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t(`events.${doc.event}`)}</p>
          <h3 className="truncate text-base font-medium">{doc.title}</h3>
          <p className="text-xs text-muted-foreground tabular-nums">
            {t('created', { time: format.dateTime(new Date(doc.createdAt), 'short') })}
          </p>
        </div>
        <Badge className={STATE_STYLES[doc.state]}>{t(`states.${doc.state}`)}</Badge>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t('recipients')}</h4>
        <p className="text-sm">{t('recipientTotal', { count: preview.recipients.total })}</p>
        <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {SUBSCRIBER_CHANNELS.map((channel) => (
            <li key={channel} className="rounded-md border px-2 py-0.5">
              {t('recipientsByChannel', {
                channel: tc(channel),
                count: preview.recipients[channel],
              })}
            </li>
          ))}
        </ul>
        {preview.smsUnavailable && (
          <p className="text-xs text-destructive">{t('smsUnavailable')}</p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className="text-sm font-medium">{t('emailPreview')}</h4>
          <p className="truncate text-xs font-medium" title={preview.email.subject}>
            {preview.email.subject}
          </p>
          <iframe
            title={t('emailPreview')}
            sandbox=""
            srcDoc={preview.email.html}
            className="h-80 w-full rounded-md border bg-white"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className="text-sm font-medium">{t('smsPreview')}</h4>
          <p className="rounded-md border bg-muted/40 p-3 text-sm break-words whitespace-pre-wrap">
            {preview.sms}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('smsSegments', { count: smsSegments(preview.sms) })}
          </p>
        </div>
      </div>

      {finished && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{t('deliveries')}</h4>
          <p className="text-sm text-muted-foreground">
            {t('deliveryCounts', {
              sent: counts.sent,
              failed: counts.failed,
              pending: counts.queued + counts.retrying,
              skipped: counts.skipped,
            })}
          </p>
          {deliveries.docs.length > 0 && (
            <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border text-xs">
              {deliveries.docs.map((row) => (
                <li
                  key={String(row.id)}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                >
                  <span className="font-mono">{row.target}</span>
                  <span className="text-muted-foreground">{tc(row.channel)}</span>
                  <span
                    className={cn(
                      row.state === 'failed' && 'text-destructive',
                      row.state === 'sent' && 'text-status-up',
                    )}
                  >
                    {t(`deliveryStates.${row.state}`)}
                  </span>
                  <span className="text-muted-foreground">
                    {t('attempts', { count: row.attempts })}
                  </span>
                  {row.error && <span className="basis-full text-destructive">{row.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {!canSend && doc.state === 'pending_review' && (
          <p className="mr-auto text-xs text-muted-foreground">{t('noPermission')}</p>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw aria-hidden /> {t('refresh')}
        </Button>
        {canSend && doc.state === 'pending_review' && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void act('discard')}
            >
              {t('discard')}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void act('send')}>
              {busy ? t('sending') : t('send')}
            </Button>
          </>
        )}
        {canSend && (doc.state === 'failed' || doc.state === 'partially_failed') && (
          <Button type="button" disabled={busy} onClick={() => void act('retry')}>
            {t('retry')}
          </Button>
        )}
      </div>
    </div>
  )
}

/** Builder tab "Notifications": drafts awaiting review and what was sent to subscribers. */
export function NotificationsPanel({
  orgId,
  pageId,
  canSend,
}: {
  orgId: OrgId
  pageId: OrgId
  canSend: boolean
}) {
  const t = useTranslations('statusPages.subscribers.notifications')
  const format = useFormatter()
  const [rows, setRows] = React.useState<NotificationRow[] | null>(null)
  const [selected, setSelected] = React.useState<OrgId | null>(null)

  const load = React.useCallback(async () => {
    try {
      const { docs } = await subscribersApi.notifications.list(orgId, pageId)
      setRows(docs)
      setSelected((current) => current ?? docs[0]?.id ?? null)
    } catch {
      toast.error(t('loadFailed'))
    }
  }, [orgId, pageId, t])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-medium">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw aria-hidden /> {t('refresh')}
        </Button>
      </div>
      {rows && rows.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <ul className="flex flex-col gap-2">
            {(rows ?? []).map((row) => (
              <li key={String(row.id)}>
                <button
                  type="button"
                  onClick={() => setSelected(row.id)}
                  aria-current={String(selected) === String(row.id) || undefined}
                  className={cn(
                    'flex w-full flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left text-sm',
                    String(selected) === String(row.id)
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted/50',
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="truncate font-medium">{row.title}</span>
                    <Badge className={cn('shrink-0', STATE_STYLES[row.state])}>
                      {t(`states.${row.state}`)}
                    </Badge>
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t('listMeta', {
                      event: t(`events.${row.event}`),
                      time: format.dateTime(new Date(row.createdAt), 'short'),
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected !== null && (
            <Detail
              key={String(selected)}
              orgId={orgId}
              pageId={pageId}
              id={selected}
              canSend={canSend}
              onChanged={() => void load()}
            />
          )}
        </div>
      )}
    </div>
  )
}
