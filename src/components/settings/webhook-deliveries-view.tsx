'use client'

import { ArrowLeft, ChevronDown, ChevronRight, RotateCw, Send } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { WebhookDeliveryRow, WebhookDeliveryState, WebhookEndpointRow } from '@/lib/webhooks'
import { webhooksApi, type WebhookDeliveryPage } from '@/lib/webhooks-api'

interface WebhookDeliveriesViewProps {
  orgId: string
  orgSlug: string
  endpoint: WebhookEndpointRow
  initial: WebhookDeliveryPage
  canManage: boolean
  /** `WEBHOOK_DELIVERY_RETENTION_DAYS`. */
  retentionDays: number
}

const STATE_VARIANT: Record<WebhookDeliveryState, 'outline' | 'secondary' | 'destructive'> = {
  pending: 'secondary',
  retrying: 'secondary',
  succeeded: 'outline',
  failed: 'destructive',
  cancelled: 'secondary',
}

/** Request headers and body as sent (body truncated for display), the response as received. */
const DISPLAY_BODY_LIMIT = 8_000

const pretty = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > DISPLAY_BODY_LIMIT ? `${text.slice(0, DISPLAY_BODY_LIMIT)}…` : text
}

const headerLines = (headers: Record<string, string> | null) =>
  Object.entries(headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

function DeliveryDetail({ row }: { row: WebhookDeliveryRow }) {
  const t = useTranslations('settings.webhooks.deliveries.detail')
  const block = 'max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre'
  return (
    <div className="grid gap-4 py-2 lg:grid-cols-2">
      <div className="min-w-0 space-y-2">
        <h4 className="text-sm font-medium">{t('request')}</h4>
        <pre className={block}>{headerLines(row.requestHeaders) || t('notSent')}</pre>
        <pre className={block}>{pretty(row.body)}</pre>
      </div>
      <div className="min-w-0 space-y-2">
        <h4 className="text-sm font-medium">
          {row.responseStatus !== null
            ? t('responseStatus', { status: row.responseStatus })
            : t('response')}
        </h4>
        {row.error && <p className="text-sm text-destructive">{row.error}</p>}
        <pre className={block}>{headerLines(row.responseHeaders) || t('noResponse')}</pre>
        {row.responseBody ? <pre className={block}>{row.responseBody}</pre> : null}
      </div>
    </div>
  )
}

/** Settings → Webhooks → an endpoint's delivery log: state, response, timing; redeliver; test. */
export function WebhookDeliveriesView({
  orgId,
  orgSlug,
  endpoint,
  initial,
  canManage,
  retentionDays,
}: WebhookDeliveriesViewProps) {
  const t = useTranslations('settings.webhooks.deliveries')
  const tTrigger = useTranslations('settings.webhooks.deliveries.triggers')
  const tState = useTranslations('settings.webhooks.deliveries.states')
  const format = useFormatter()
  const [page, setPage] = React.useState<WebhookDeliveryPage>(initial)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  async function load(pageNumber: number) {
    setBusy('page')
    try {
      setPage(await webhooksApi.deliveries(orgId, endpoint.id, pageNumber))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('loadFailed'))
    } finally {
      setBusy(null)
    }
  }

  function showResult(delivery: WebhookDeliveryRow | null) {
    if (delivery?.state === 'succeeded') {
      toast.success(t('sentOk', { status: delivery.responseStatus ?? 0 }))
    } else {
      toast.error(t('sentFailed', { error: delivery?.error ?? '' }))
    }
  }

  async function redeliver(row: WebhookDeliveryRow) {
    setBusy(row.id)
    try {
      const { delivery } = await webhooksApi.redeliver(orgId, endpoint.id, row.id)
      showResult(delivery)
      await load(1)
      if (delivery) setExpanded(delivery.id)
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('redeliverFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function sendTest() {
    setBusy('test')
    try {
      const { delivery } = await webhooksApi.test(orgId, endpoint.id)
      showResult(delivery)
      await load(1)
      if (delivery) setExpanded(delivery.id)
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('redeliverFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/${orgSlug}/settings/webhooks`}>
            <ArrowLeft /> {t('back')}
          </Link>
        </Button>
      </div>
      <Card data-testid="webhook-deliveries">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <CardTitle className="truncate font-mono text-sm">{endpoint.url}</CardTitle>
            <CardDescription>
              {t('description', { days: retentionDays, count: page.totalDocs })}
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={sendTest} disabled={busy !== null}>
              <Send /> {t('sendTest')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {page.docs.length === 0 ? (
            <EmptyState icon={Send} title={t('emptyTitle')} description={t('emptyDescription')} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-0" />
                    <TableHead>{t('columns.event')}</TableHead>
                    <TableHead>{t('columns.state')}</TableHead>
                    <TableHead>{t('columns.response')}</TableHead>
                    <TableHead>{t('columns.duration')}</TableHead>
                    <TableHead>{t('columns.time')}</TableHead>
                    {canManage && <TableHead className="w-0" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.docs.map((row) => {
                    const open = expanded === row.id
                    return (
                      <React.Fragment key={row.id}>
                        <TableRow data-testid={`webhook-delivery-${row.id}`}>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-expanded={open}
                              aria-label={open ? t('hideDetails') : t('showDetails')}
                              onClick={() => setExpanded(open ? null : row.id)}
                            >
                              {open ? <ChevronDown /> : <ChevronRight />}
                            </Button>
                          </TableCell>
                          <TableCell>
                            <div className="font-mono text-xs">{row.eventType}</div>
                            {row.trigger !== 'event' && (
                              <div className="text-xs text-muted-foreground">
                                {tTrigger(row.trigger)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={STATE_VARIANT[row.state]}>{tState(row.state)}</Badge>
                            {row.attempts > 1 && (
                              <div className="text-xs text-muted-foreground">
                                {t('attempts', { count: row.attempts })}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {row.responseStatus ?? '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {row.durationMs !== null
                              ? t('durationMs', { ms: row.durationMs })
                              : '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {format.dateTime(new Date(row.createdAt), 'precise')}
                          </TableCell>
                          {canManage && (
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy !== null}
                                onClick={() => redeliver(row)}
                              >
                                <RotateCw /> {t('redeliver')}
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                        {open && (
                          <TableRow>
                            <TableCell colSpan={canManage ? 7 : 6} className="whitespace-normal">
                              <DeliveryDetail row={row} />
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    )
                  })}
                </TableBody>
              </Table>
              {page.totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 pt-4 text-sm">
                  <span className="text-muted-foreground">
                    {t('pageOf', { page: page.page, total: page.totalPages })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null || page.page <= 1}
                    onClick={() => load(page.page - 1)}
                  >
                    {t('previous')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null || page.page >= page.totalPages}
                    onClick={() => load(page.page + 1)}
                  >
                    {t('next')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
