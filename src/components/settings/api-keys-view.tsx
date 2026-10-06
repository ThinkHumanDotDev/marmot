'use client'

import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
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
}

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Never expires', days: null },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '1 year', days: 365 },
] as const

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—'

const relativeTime = (iso: string | null) => {
  if (!iso) return 'Never'
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function StatusBadge({ status }: { status: ApiKeyRow['status'] }) {
  if (status === 'active') return <Badge variant="outline">Active</Badge>
  if (status === 'expired') return <Badge variant="destructive">Expired</Badge>
  return <Badge variant="secondary">Disabled</Badge>
}

/** Settings → API keys: list, create (reveals the key once), disable, revoke. */
export function ApiKeysView({ orgId, initial, canManage }: ApiKeysViewProps) {
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
      toast.success(active ? 'API key enabled' : 'API key disabled')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the key')
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
      toast.success('API key revoked')
      setRevoking(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke the key')
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
              <KeyRound className="size-4 text-muted-foreground" aria-hidden /> API keys
            </CardTitle>
            <CardDescription>
              Keys authenticate Prometheus scrapes of <code>/api/metrics</code> and badges of
              monitors that are not on a public status page. Send them as{' '}
              <code>Authorization: Bearer</code> or <code>X-API-Key</code>.
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New key
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description={
                canManage
                  ? 'Create a key to scrape metrics or embed private badges.'
                  : 'Admins of this organization can create API keys.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Last used</TableHead>
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
                            aria-label={row.active ? 'Disable key' : 'Enable key'}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Revoke ${row.name}`}
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
            <DialogTitle>Revoke “{revoking?.name}”?</DialogTitle>
            <DialogDescription>
              Anything still using this key will get 401 responses immediately. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmRevoke}
              disabled={busyId === revoking?.id}
            >
              <Trash2 /> Revoke key
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
      toast.error(error instanceof Error ? error.message : 'Could not create the key')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              Give the key a name you will recognise in this list, for example the system that will
              use it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="api-key-name">Name</Label>
              <Input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Prometheus"
                maxLength={120}
                autoFocus
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api-key-expiry">Expiry</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as typeof expiry)}>
                <SelectTrigger id="api-key-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              <KeyRound /> Create key
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
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.key)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Copy failed. Select the key and copy it manually.')
    }
  }

  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy your new API key</DialogTitle>
          <DialogDescription>
            This is the only time the key for “{revealed?.row.name}” is shown. Store it somewhere
            safe; if you lose it, revoke it and create a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            readOnly
            value={revealed?.key ?? ''}
            aria-label="API key"
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
            data-testid="api-key-plaintext"
          />
          <Button variant="outline" onClick={copy} aria-label="Copy API key">
            {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
