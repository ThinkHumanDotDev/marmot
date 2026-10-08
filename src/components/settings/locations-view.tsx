'use client'

import { Check, Copy, KeyRound, Pencil, Plus, RadioTower, RefreshCw, Trash2, X } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { LocationStatusBadge } from '@/components/locations/location-badge'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { locationsApi, type LocationInput, type LocationRow } from '@/lib/locations-api'
import { MAX_LOCATION_LABELS } from '@/lib/probe-locations'

interface LocationsViewProps {
  orgId: string
  initial: LocationRow[]
  /** `location:create` (admins and owners). */
  canManage: boolean
  /** `NEXT_PUBLIC_SERVER_URL`, for the `docker run` snippet. */
  serverUrl: string
  offlineAfterSeconds: number
}

/** The list refreshes this often so badges follow the `probe-health` job. */
const POLL_MS = 30_000

function useRelativeTime() {
  const t = useTranslations('settings.locations.lastSeen')
  return (iso: string | null) => {
    if (!iso) return t('never')
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
    if (seconds < 60) return t('seconds', { count: Math.max(0, seconds) })
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return t('minutes', { count: minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 48) return t('hours', { count: hours })
    return t('days', { count: Math.round(hours / 24) })
  }
}

/** `docker run` command that starts an agent for this location. */
export function probeRunCommand(serverUrl: string, token: string): string {
  return [
    'docker run -d --name marmot-probe --restart unless-stopped \\',
    '  -e MARMOT_ROLE=probe \\',
    `  -e MARMOT_URL=${serverUrl} \\`,
    `  -e MARMOT_PROBE_TOKEN=${token} \\`,
    '  ghcr.io/thinkhumandotdev/marmot:latest',
  ].join('\n')
}

/** Settings → Locations: list with live status, create (token shown once), edit, rotate, delete. */
export function LocationsView({
  orgId,
  initial,
  canManage,
  serverUrl,
  offlineAfterSeconds,
}: LocationsViewProps) {
  const t = useTranslations('settings.locations')
  const format = useFormatter()
  const relativeTime = useRelativeTime()
  const [rows, setRows] = React.useState<LocationRow[]>(initial)
  const [editing, setEditing] = React.useState<LocationRow | 'new' | null>(null)
  const [revealed, setRevealed] = React.useState<{ row: LocationRow; token: string } | null>(null)
  const [rotating, setRotating] = React.useState<LocationRow | null>(null)
  const [deleting, setDeleting] = React.useState<LocationRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  React.useEffect(() => {
    const timer = setInterval(() => {
      locationsApi
        .list(orgId)
        .then(({ docs }) => setRows(docs))
        .catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [orgId])

  const upsert = (row: LocationRow) =>
    setRows((current) =>
      current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [...current, row].sort((a, b) => a.name.localeCompare(b.name)),
    )

  async function confirmRotate() {
    if (!rotating) return
    setBusyId(rotating.id)
    try {
      const { doc, token } = await locationsApi.rotateToken(orgId, rotating.id)
      upsert(doc)
      setRotating(null)
      setRevealed({ row: doc, token })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('rotateFailed'))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyId(deleting.id)
    try {
      await locationsApi.remove(orgId, deleting.id)
      setRows((current) => current.filter((r) => r.id !== deleting.id))
      toast.success(t('deleted'))
      setDeleting(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('deleteFailed'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <Card data-testid="locations-card">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <RadioTower className="size-4 text-muted-foreground" aria-hidden /> {t('title')}
            </CardTitle>
            <CardDescription>
              {t('description', { minutes: Math.round(offlineAfterSeconds / 60) })}
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> {t('newLocation')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              icon={RadioTower}
              title={t('emptyTitle')}
              description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.name')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.lastSeen')}</TableHead>
                  <TableHead>{t('columns.agent')}</TableHead>
                  <TableHead className="text-right">{t('columns.monitors')}</TableHead>
                  {canManage && <TableHead>{t('columns.token')}</TableHead>}
                  {canManage && <TableHead className="w-0" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} data-testid={`location-${row.slug}`}>
                    <TableCell>
                      <div className="font-medium">{row.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.slug}</div>
                      {row.labels.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {row.labels.map((label) => (
                            <Badge key={label.key} variant="secondary" className="font-normal">
                              {label.value ? `${label.key}: ${label.value}` : label.key}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <LocationStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground"
                      title={
                        row.lastSeenAt
                          ? format.dateTime(new Date(row.lastSeenAt), 'precise')
                          : undefined
                      }
                    >
                      {relativeTime(row.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.agent
                        ? [row.agent.hostname, row.agent.version && `v${row.agent.version}`]
                            .filter(Boolean)
                            .join(' · ')
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.monitorCount}</TableCell>
                    {canManage && (
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.tokenDisplay}
                      </TableCell>
                    )}
                    {canManage && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('editLabel', { name: row.name })}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('rotateLabel', { name: row.name })}
                            disabled={busyId === row.id}
                            onClick={() => setRotating(row)}
                          >
                            <RefreshCw />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('deleteLabel', { name: row.name })}
                            disabled={busyId === row.id}
                            onClick={() => setDeleting(row)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <LocationDialog
          orgId={orgId}
          location={editing}
          onClose={() => setEditing(null)}
          onSaved={(row, token) => {
            upsert(row)
            if (token) setRevealed({ row, token })
            else toast.success(t('saved'))
          }}
        />
      )}

      <RevealTokenDialog
        revealed={revealed}
        serverUrl={serverUrl}
        onClose={() => setRevealed(null)}
      />

      <Dialog open={rotating !== null} onOpenChange={(open) => !open && setRotating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rotateTitle', { name: rotating?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('rotateDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotating(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={confirmRotate} disabled={busyId === rotating?.id}>
              <KeyRound /> {t('rotate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: deleting?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('deleteDescription', { count: deleting?.monitorCount ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={busyId === deleting?.id}
            >
              <Trash2 /> {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface LabelRow {
  key: string
  value: string
}

function LocationDialog({
  orgId,
  location,
  onClose,
  onSaved,
}: {
  orgId: string
  location: LocationRow | 'new' | null
  onClose: () => void
  onSaved: (row: LocationRow, token?: string) => void
}) {
  return (
    <Dialog open={location !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {location !== null && (
          <LocationForm
            key={location === 'new' ? 'new' : location.id}
            orgId={orgId}
            existing={location === 'new' ? null : location}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Create / edit form; keyed by location so its state starts from the row it edits. */
function LocationForm({
  orgId,
  existing,
  onClose,
  onSaved,
}: {
  orgId: string
  existing: LocationRow | null
  onClose: () => void
  onSaved: (row: LocationRow, token?: string) => void
}) {
  const t = useTranslations('settings.locations.form')
  const isNew = existing === null
  const [name, setName] = React.useState(existing?.name ?? '')
  const [slug, setSlug] = React.useState(existing?.slug ?? '')
  const [labels, setLabels] = React.useState<LabelRow[]>(
    (existing?.labels ?? []).map((l) => ({ key: l.key, value: l.value ?? '' })),
  )
  const [busy, setBusy] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const data: LocationInput = {
      name: name.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      labels: labels
        .filter((l) => l.key.trim())
        .map((l) => ({ key: l.key.trim(), value: l.value.trim() || null })),
    }
    try {
      if (existing) {
        const { doc } = await locationsApi.update(orgId, existing.id, data)
        onClose()
        onSaved(doc)
      } else {
        const { doc, token } = await locationsApi.create(orgId, data)
        onClose()
        onSaved(doc, token)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>{isNew ? t('createTitle') : t('editTitle')}</DialogTitle>
        <DialogDescription>
          {isNew ? t('createDescription') : t('editDescription')}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="location-name">{t('name')}</Label>
          <Input
            id="location-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            maxLength={100}
            autoFocus
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="location-slug">{t('slug')}</Label>
          <Input
            id="location-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={t('slugPlaceholder')}
            maxLength={60}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">{t('slugHint')}</p>
        </div>
        <div className="grid gap-2">
          <Label>{t('labels')}</Label>
          {labels.map((label, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={label.key}
                aria-label={t('labelKey')}
                placeholder={t('labelKey')}
                maxLength={64}
                onChange={(e) =>
                  setLabels((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)),
                  )
                }
              />
              <Input
                value={label.value}
                aria-label={t('labelValue')}
                placeholder={t('labelValue')}
                maxLength={200}
                onChange={(e) =>
                  setLabels((rows) =>
                    rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('removeLabel')}
                onClick={() => setLabels((rows) => rows.filter((_, i) => i !== index))}
              >
                <X />
              </Button>
            </div>
          ))}
          {labels.length < MAX_LOCATION_LABELS && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => setLabels((rows) => [...rows, { key: '', value: '' }])}
            >
              <Plus /> {t('addLabel')}
            </Button>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {isNew ? t('create') : t('save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function CopyButton({ value, testId }: { value: string; testId?: string }) {
  const t = useTranslations('settings.locations.reveal')
  const [copied, setCopied] = React.useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyFailed'))
    }
  }
  return (
    <Button type="button" variant="outline" onClick={copy} data-testid={testId}>
      {copied ? <Check /> : <Copy />} {copied ? t('copied') : t('copy')}
    </Button>
  )
}

function RevealTokenDialog({
  revealed,
  serverUrl,
  onClose,
}: {
  revealed: { row: LocationRow; token: string } | null
  serverUrl: string
  onClose: () => void
}) {
  const t = useTranslations('settings.locations.reveal')
  const command = revealed ? probeRunCommand(serverUrl, revealed.token) : ''
  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { name: revealed?.row.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            readOnly
            value={revealed?.token ?? ''}
            aria-label={t('tokenLabel')}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
            data-testid="location-token"
          />
          <CopyButton value={revealed?.token ?? ''} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="location-run">{t('runLabel')}</Label>
          <Textarea
            id="location-run"
            readOnly
            rows={5}
            value={command}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div>
            <CopyButton value={command} />
          </div>
          <p className="text-xs text-muted-foreground">{t('runHint')}</p>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
