'use client'

import { Copy, Link2, Loader2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { slaApi, type ShareRowView } from './sla-api'

/**
 * Public share links of an SLA report (#156): create one for the range on screen (its URL is
 * shown once), list them and revoke them.
 */
export function ShareLinks({
  orgId,
  reportId,
  from,
  to,
  initial,
}: {
  orgId: string
  reportId: string
  from: string
  to: string
  initial: ShareRowView[]
}) {
  const t = useTranslations('sla.report.shares')
  const format = useFormatter()
  const [rows, setRows] = React.useState(initial)
  const [created, setCreated] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [revoking, setRevoking] = React.useState<ShareRowView | null>(null)
  const day = (date: string) => format.dateTime(new Date(`${date}T00:00:00Z`), 'utcDate')
  const rangeOf = (row: { from: string; to: string }) =>
    t('range', { from: day(row.from), to: day(row.to) })

  const create = async () => {
    setBusy(true)
    try {
      const result = await slaApi.createShare(orgId, reportId, { from, to })
      setRows((current) => [result.doc, ...current])
      setCreated(result.url)
      toast.success(t('created'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('copied'))
    } catch {
      // Clipboard access denied: the field stays selectable.
    }
  }

  return (
    <Card className="print:hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
        <Button size="sm" onClick={create} disabled={busy} data-testid="sla-share-create">
          {busy ? <Loader2 className="animate-spin" /> : <Link2 />} {t('create')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {created && (
          <div className="flex gap-2" data-testid="sla-share-url">
            <Input readOnly value={created} onFocus={(event) => event.target.select()} />
            <Button
              variant="outline"
              size="icon"
              aria-label={t('copy')}
              onClick={() => copy(created)}
            >
              <Copy />
            </Button>
          </div>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li
                key={row.id}
                data-sla-share={row.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div className="space-y-0.5">
                  <span className="font-medium">{rangeOf(row)}</span>
                  <p className="text-xs text-muted-foreground">
                    {t('createdAt', { date: format.dateTime(new Date(row.createdAt), 'short') })}
                  </p>
                </div>
                {row.revokedAt ? (
                  <Badge variant="outline">
                    {t('revoked', { date: format.dateTime(new Date(row.revokedAt), 'short') })}
                  </Badge>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('revokeLabel', { range: rangeOf(row) })}
                    onClick={() => setRevoking(row)}
                  >
                    {t('revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('confirmRevokeTitle')}
        description={t('confirmRevokeDescription')}
        confirmLabel={t('revoke')}
        destructive
        onConfirm={async () => {
          if (!revoking) return
          try {
            const { doc } = await slaApi.revokeShare(orgId, reportId, revoking.id)
            setRows((current) => current.map((row) => (row.id === doc.id ? doc : row)))
            toast.success(t('revokedToast'))
            setRevoking(null)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('failed'))
          }
        }}
      />
    </Card>
  )
}
