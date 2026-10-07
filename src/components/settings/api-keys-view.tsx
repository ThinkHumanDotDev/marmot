'use client'

import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { apiKeysApi, type ApiKeyRow } from '@/lib/api-keys-api'

interface ApiKeysViewProps {
  orgId: string
  initial: ApiKeyRow[]
  /** `api-key:create` / `api-key:delete` (admins and owners). */
  canManage: boolean
  /** Organization time zone the expiry dates render in. */
  timeZone: string
}

const EXPIRY_OPTIONS = [
  { value: 'never', days: null },
  { value: '30', days: 30 },
  { value: '90', days: 90 },
  { value: '365', days: 365 },
] as const

/** "Last used" as a compact relative time (`5 min ago`). */
function useRelativeTime() {
  const t = useTranslations('settings.apiKeys.lastUsed')
  return (iso: string | null) => {
    if (!iso) return t('never')
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
    if (minutes < 1) return t('justNow')
    if (minutes < 60) return t('minutes', { count: minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 48) return t('hours', { count: hours })
    return t('days', { count: Math.round(hours / 24) })
  }
}

function StatusBadge({ status }: { status: ApiKeyRow['status'] }) {
  const t = useTranslations('settings.apiKeys.status')
  if (status === 'active') return <Badge variant="outline">{t('active')}</Badge>
  if (status === 'expired') return <Badge variant="destructive">{t('expired')}</Badge>
  return <Badge variant="secondary">{t('disabled')}</Badge>
}

/** Settings → API keys: list, create (reveals the key once), disable, revoke. */
export function ApiKeysView({ orgId, initial, canManage, timeZone }: ApiKeysViewProps) {
  const t = useTranslations('settings.apiKeys')
  const format = useFormatter()
  const relativeTime = useRelativeTime()
  const formatDate = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), 'date', { timeZone }) : '—'
  const [rows, setRows] = React.useState<ApiKeyRow[]>(initial)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [revealed, setRevealed] = React.useState<{ row: ApiKeyRow; key: string } | null>(null)
  const [revoking, setRevoking] = React.useState<ApiKeyRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const upsert = (row: ApiKeyRow) =>
    setRows((current) =>
      current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [row, ...current],
    )

  async function toggleActive(row: ApiKeyRow, active: boolean) {
    setBusyId(row.id)
    try {
      const { doc } = await apiKeysApi.setActive(orgId, row.id, active)
      upsert(doc)
      toast.success(active ? t('enabled') : t('disabled'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('updateFailed'))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmRevoke() {
    if (!revoking) return
    setBusyId(revoking.id)
    try {
      await apiKeysApi.revoke(orgId, revoking.id)
      setRows((current) => current.filter((r) => r.id !== revoking.id))
      toast.success(t('revoked'))
      setRevoking(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('revokeFailed'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <Card data-testid="api-keys-card">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" aria-hidden /> {t('title')}
            </CardTitle>
            <CardDescription>
              {t.rich('description', { code: (chunks) => <code>{chunks}</code> })}
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> {t('newKey')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title={t('emptyTitle')}
              description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.name')}</TableHead>
                  <TableHead>{t('columns.key')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.expires')}</TableHead>
                  <TableHead>{t('columns.lastUsed')}</TableHead>
                  {canManage && <TableHead className="w-0" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} data-testid={`api-key-${row.prefix}`}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.display}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(row.expiresAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {relativeTime(row.lastUsedAt)}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Switch
                            checked={row.active}
                            disabled={busyId === row.id || row.status === 'expired'}
                            onCheckedChange={(checked) => toggleActive(row, checked)}
                            aria-label={row.active ? t('disableKey') : t('enableKey')}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('revokeLabel', { name: row.name })}
                            disabled={busyId === row.id}
                            onClick={() => setRevoking(row)}
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
        <CreateApiKeyDialog
          orgId={orgId}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(row, key) => {
            upsert(row)
            setRevealed({ row, key })
          }}
        />
      )}

      <RevealKeyDialog revealed={revealed} onClose={() => setRevealed(null)} />

      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('revokeTitle', { name: revoking?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('revokeDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmRevoke}
              disabled={busyId === revoking?.id}
            >
              <Trash2 /> {t('revoke')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface CreateApiKeyDialogProps {
  orgId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (row: ApiKeyRow, key: string) => void
}

function CreateApiKeyDialog({ orgId, open, onOpenChange, onCreated }: CreateApiKeyDialogProps) {
  const t = useTranslations('settings.apiKeys.create')
  const [name, setName] = React.useState('')
  const [expiry, setExpiry] = React.useState<(typeof EXPIRY_OPTIONS)[number]['value']>('never')
  const [busy, setBusy] = React.useState(false)

  function reset() {
    setName('')
    setExpiry('never')
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      const days = EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days ?? null
      const { doc, key } = await apiKeysApi.create(orgId, {
        name: name.trim(),
        expiresInDays: days,
      })
      handleOpenChange(false)
      onCreated(doc, key)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="api-key-name">{t('name')}</Label>
              <Input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                maxLength={120}
                autoFocus
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api-key-expiry">{t('expiry')}</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as typeof expiry)}>
                <SelectTrigger id="api-key-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(`expiryOptions.${option.value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              <KeyRound /> {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RevealKeyDialog({
  revealed,
  onClose,
}: {
  revealed: { row: ApiKeyRow; key: string } | null
  onClose: () => void
}) {
  const t = useTranslations('settings.apiKeys.reveal')
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.key)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { name: revealed?.row.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            readOnly
            value={revealed?.key ?? ''}
            aria-label={t('keyLabel')}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
            data-testid="api-key-plaintext"
          />
          <Button variant="outline" onClick={copy} aria-label={t('copyLabel')}>
            {copied ? <Check /> : <Copy />} {copied ? t('copied') : t('copy')}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
