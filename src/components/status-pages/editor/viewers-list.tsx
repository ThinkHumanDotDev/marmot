'use client'

import { Ban, RotateCcw, Trash2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { StatusPageViewer } from '@/payload-types'

import { statusPagesApi, type OrgId } from '../api'

/** Visitors of an `email-domain` page: list, revoke / restore, remove. */
export function ViewersList({
  orgId,
  pageId,
  canEdit,
  timeZone,
}: {
  orgId: OrgId
  pageId: OrgId
  canEdit: boolean
  timeZone: string
}) {
  const t = useTranslations('statusPages.access.editor.viewers')
  const format = useFormatter()
  const [viewers, setViewers] = React.useState<StatusPageViewer[] | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    statusPagesApi.viewers
      .list(orgId, pageId)
      .then(({ docs }) => {
        if (!cancelled) setViewers(docs)
      })
      .catch(() => {
        if (!cancelled) {
          setViewers([])
          toast.error(t('loadFailed'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [orgId, pageId, t])

  async function run(viewer: StatusPageViewer, action: () => Promise<StatusPageViewer | null>) {
    setBusy(String(viewer.id))
    try {
      const next = await action()
      setViewers((list) =>
        (list ?? []).flatMap((v) =>
          String(v.id) === String(viewer.id) ? (next ? [next] : []) : [v],
        ),
      )
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('updateFailed'))
    } finally {
      setBusy(null)
    }
  }

  const setStatus = (viewer: StatusPageViewer, status: StatusPageViewer['status']) =>
    run(
      viewer,
      async () => (await statusPagesApi.viewers.setStatus(orgId, pageId, viewer.id, status)).doc,
    )
  const remove = (viewer: StatusPageViewer) =>
    run(viewer, async () => {
      await statusPagesApi.viewers.remove(orgId, pageId, viewer.id)
      return null
    })

  return (
    <section className="flex flex-col gap-3" aria-labelledby="sp-viewers-title">
      <div>
        <h2 id="sp-viewers-title" className="text-base font-medium">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {viewers !== null && viewers.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('email')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead>{t('lastSeen')}</TableHead>
                {canEdit && <TableHead className="sr-only">{t('revoke')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(viewers ?? []).map((viewer) => {
                const revoked = viewer.status === 'revoked'
                const pending = busy === String(viewer.id)
                return (
                  <TableRow key={viewer.id}>
                    <TableCell className="font-medium">{viewer.email}</TableCell>
                    <TableCell>
                      <Badge variant={revoked ? 'destructive' : 'secondary'}>
                        {revoked ? t('revoked') : t('active')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {viewer.lastSeenAt
                        ? format.dateTime(new Date(viewer.lastSeenAt), 'short', { timeZone })
                        : t('never')}
                    </TableCell>
                    {canEdit && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setStatus(viewer, revoked ? 'active' : 'revoked')}
                          >
                            {revoked ? (
                              <RotateCcw className="size-4" aria-hidden />
                            ) : (
                              <Ban className="size-4" aria-hidden />
                            )}
                            {revoked ? t('restore') : t('revoke')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => remove(viewer)}
                          >
                            <Trash2 className="size-4" aria-hidden />
                            {t('remove')}
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
