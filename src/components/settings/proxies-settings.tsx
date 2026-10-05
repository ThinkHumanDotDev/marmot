'use client'

import { Loader2, Network, Pencil, Plus, Trash2 } from 'lucide-react'
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

const PROTOCOL_LABELS: Record<ProxyProtocol, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks: 'SOCKS (v5, remote DNS)',
  socks5: 'SOCKS v5',
  socks5h: 'SOCKS v5 (remote DNS)',
  socks4: 'SOCKS v4',
}

const sortRows = (rows: ProxyRow[]) =>
  [...rows].sort((a, b) => proxyLabel(a).localeCompare(proxyLabel(b)))

export function ProxiesSettings({ orgId, initial, canManage }: ProxiesSettingsProps) {
  const [rows, setRows] = React.useState<ProxyRow[]>(() => sortRows(initial))
  const [editing, setEditing] = React.useState<ProxyRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<ProxyRow | null>(null)

  const upsert = (row: ProxyRow) =>
    setRows((current) => {
      // Saving a default proxy clears the flag on the others (server-side hook).
      const others = current
        .filter((r) => r.id !== row.id)
        .map((r) => (row.default ? { ...r, default: false } : r))
      return sortRows([...others, row])
    })

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Proxies</CardTitle>
          <CardDescription>
            HTTP(s) and SOCKS proxies that HTTP monitors can send their requests through. The
            default proxy is preselected for new HTTP monitors.
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="proxy-new">
            <Plus /> New proxy
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Network}
            title="No proxies"
            description={
              canManage
                ? 'Add a proxy, then pick it in the HTTP options of a monitor.'
                : 'Admins of this organization can add proxies.'
            }
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
                  {row.default && <Badge variant="secondary">Default</Badge>}
                  {row.auth && <Badge variant="outline">Auth</Badge>}
                  {!row.active && <Badge variant="outline">Inactive</Badge>}
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${proxyLabel(row)}`}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${proxyLabel(row)}`}
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
        title={`Delete proxy ${deleting ? proxyLabel(deleting) : ''}?`}
        description="Monitors using it fall back to direct connections. This cannot be undone."
        confirmLabel="Delete proxy"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await proxiesApi.remove(deleting.id)
            setRows((current) => current.filter((r) => r.id !== deleting.id))
            toast.success('Proxy deleted')
            setDeleting(null)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not delete the proxy')
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
      toast.success(proxy ? 'Proxy saved' : 'Proxy created')
      onSaved(row)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the proxy')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <form onSubmit={save} className="grid gap-5">
        <DialogHeader>
          <DialogTitle>{proxy ? 'Edit proxy' : 'New proxy'}</DialogTitle>
          <DialogDescription>
            SOCKS v4 and v5 resolve hostnames locally; SOCKS v5 (remote DNS) lets the proxy resolve
            them.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="proxy-protocol">Protocol</Label>
          <Select value={form.protocol} onValueChange={(v) => set('protocol', v as ProxyProtocol)}>
            <SelectTrigger id="proxy-protocol" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROXY_PROTOCOLS.map((protocol) => (
                <SelectItem key={protocol} value={protocol}>
                  {PROTOCOL_LABELS[protocol]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-5 sm:grid-cols-[1fr_7rem]">
          <div className="grid gap-2">
            <Label htmlFor="proxy-host">Host</Label>
            <Input
              id="proxy-host"
              value={form.host}
              placeholder="proxy.example.com"
              autoComplete="off"
              onChange={(e) => set('host', e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="proxy-port">Port</Label>
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
          label="Authentication"
          description="The proxy requires a username and password."
          checked={form.auth}
          onChange={(v) => set('auth', v)}
        />
        {form.auth && (
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="proxy-username">Username</Label>
              <Input
                id="proxy-username"
                value={form.username}
                autoComplete="off"
                onChange={(e) => set('username', e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="proxy-password">Password</Label>
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
          label="Active"
          description="Inactive proxies are skipped: monitors connect directly."
          checked={form.active}
          onChange={(v) => set('active', v)}
        />
        <SwitchRow
          id="proxy-default"
          label="Default"
          description="Preselect this proxy for new HTTP monitors."
          checked={form.default}
          onChange={(v) => set('default', v)}
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving && <Loader2 className="animate-spin" />}
            {proxy ? 'Save' : 'Create proxy'}
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
