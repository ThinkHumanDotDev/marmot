'use client'

import { Loader2, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
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
import { PROXY_PROTOCOLS, type ProxyProtocol } from '@/lib/monitor-resources'
import { cn } from '@/lib/utils'

import { proxiesApi, proxyLabel, type ProxyRow } from './resources-api'

interface ProxiesSettingsProps {
  orgId: string
  initial: ProxyRow[]
  /** `proxy:update` — create, edit and delete. */
  canManage: boolean
}

const sortRows = (rows: ProxyRow[], locale: string) =>
  [...rows].sort((a, b) => proxyLabel(a).localeCompare(proxyLabel(b), locale))

export function ProxiesSettings({ orgId, initial, canManage }: ProxiesSettingsProps) {
  const t = useTranslations('settings.proxies')
  const locale = useLocale()
  const [rows, setRows] = React.useState<ProxyRow[]>(() => sortRows(initial, locale))
  const [editing, setEditing] = React.useState<ProxyRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<ProxyRow | null>(null)

  const upsert = (row: ProxyRow) =>
    setRows((current) => {
      // Saving a default proxy clears the flag on the others (server-side hook).
      const others = current
        .filter((r) => r.id !== row.id)
        .map((r) => (row.default ? { ...r, default: false } : r))
      return sortRows([...others, row], locale)
    })

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="proxy-new">
            <Plus /> {t('new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Network}
            title={t('emptyTitle')}
            description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li
                key={row.id}
                className={cn(
                  'flex items-center justify-between gap-3 px-3 py-2',
                  !row.active && 'text-muted-foreground',
                )}
              >
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-sm">{proxyLabel(row)}</span>
                  {row.default && <Badge variant="secondary">{t('badge.default')}</Badge>}
                  {row.auth && <Badge variant="outline">{t('badge.auth')}</Badge>}
                  {!row.active && <Badge variant="outline">{t('badge.inactive')}</Badge>}
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('editLabel', { name: proxyLabel(row) })}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { name: proxyLabel(row) })}
                      onClick={() => setDeleting(row)}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {canManage && (
        <ProxyDialog
          orgId={orgId}
          proxy={editing === 'new' ? null : editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={(row) => {
            upsert(row)
            setEditing(null)
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('confirmDeleteTitle', { name: deleting ? proxyLabel(deleting) : '' })}
        description={t('confirmDeleteDescription')}
        confirmLabel={t('confirmDelete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await proxiesApi.remove(deleting.id)
            setRows((current) => current.filter((r) => r.id !== deleting.id))
            toast.success(t('deleted'))
            setDeleting(null)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('deleteFailed'))
          }
        }}
      />
    </Card>
  )
}

interface ProxyFormState {
  protocol: ProxyProtocol
  host: string
  port: string
  auth: boolean
  username: string
  password: string
  active: boolean
  default: boolean
}

const emptyForm: ProxyFormState = {
  protocol: 'https',
  host: '',
  port: '',
  auth: false,
  username: '',
  password: '',
  active: true,
  default: false,
}

/** Radix unmounts the content when closed, so the form starts from `proxy` on every open. */
function ProxyDialog({
  open,
  ...props
}: React.ComponentProps<typeof ProxyForm> & { open: boolean }) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <ProxyForm {...props} />
      </DialogContent>
    </Dialog>
  )
}

function ProxyForm({
  orgId,
  proxy,
  onOpenChange,
  onSaved,
}: {
  orgId: string
  proxy: ProxyRow | null
  onOpenChange: (open: boolean) => void
  onSaved: (row: ProxyRow) => void
}) {
  const t = useTranslations('settings.proxies.form')
  const [form, setForm] = React.useState<ProxyFormState>(() =>
    proxy
      ? {
          protocol: proxy.protocol,
          host: proxy.host,
          port: String(proxy.port),
          auth: proxy.auth,
          username: proxy.username ?? '',
          password: proxy.password ?? '',
          active: proxy.active,
          default: proxy.default,
        }
      : emptyForm,
  )
  const [saving, setSaving] = React.useState(false)

  const set = <K extends keyof ProxyFormState>(key: K, value: ProxyFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const port = Number(form.port)
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535
  const canSave =
    form.host.trim().length > 0 && portValid && (!form.auth || form.username.trim()) && !saving

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const data = {
        protocol: form.protocol,
        host: form.host.trim(),
        port,
        auth: form.auth,
        username: form.auth ? form.username.trim() : null,
        password: form.auth ? form.password : null,
        active: form.active,
        default: form.default,
      }
      const row = proxy
        ? await proxiesApi.update(proxy.id, data)
        : await proxiesApi.create(orgId, data)
      toast.success(proxy ? t('saved') : t('created'))
      onSaved(row)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <form onSubmit={save} className="grid gap-5">
        <DialogHeader>
          <DialogTitle>{proxy ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="proxy-protocol">{t('protocol')}</Label>
          <Select value={form.protocol} onValueChange={(v) => set('protocol', v as ProxyProtocol)}>
            <SelectTrigger id="proxy-protocol" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROXY_PROTOCOLS.map((protocol) => (
                <SelectItem key={protocol} value={protocol}>
                  {t(`protocols.${protocol}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-5 sm:grid-cols-[1fr_7rem]">
          <div className="grid gap-2">
            <Label htmlFor="proxy-host">{t('host')}</Label>
            <Input
              id="proxy-host"
              value={form.host}
              placeholder={t('hostPlaceholder')}
              autoComplete="off"
              onChange={(e) => set('host', e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="proxy-port">{t('port')}</Label>
            <Input
              id="proxy-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={form.port}
              placeholder="8080"
              onChange={(e) => set('port', e.target.value)}
            />
          </div>
        </div>
        <SwitchRow
          id="proxy-auth"
          label={t('auth')}
          description={t('authHint')}
          checked={form.auth}
          onChange={(v) => set('auth', v)}
        />
        {form.auth && (
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="proxy-username">{t('username')}</Label>
              <Input
                id="proxy-username"
                value={form.username}
                autoComplete="off"
                onChange={(e) => set('username', e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="proxy-password">{t('password')}</Label>
              <Input
                id="proxy-password"
                type="password"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => set('password', e.target.value)}
              />
            </div>
          </div>
        )}
        <SwitchRow
          id="proxy-active"
          label={t('active')}
          description={t('activeHint')}
          checked={form.active}
          onChange={(v) => set('active', v)}
        />
        <SwitchRow
          id="proxy-default"
          label={t('default')}
          description={t('defaultHint')}
          checked={form.default}
          onChange={(v) => set('default', v)}
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving && <Loader2 className="animate-spin" />}
            {proxy ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

export function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
