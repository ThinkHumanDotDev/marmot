'use client'

import { Container, Loader2, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react'
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
import { ApiError } from '@/lib/api'
import {
  DEFAULT_DOCKER_SOCKET,
  DOCKER_URL_PATTERN,
  type DockerConnectionType,
} from '@/lib/monitor-resources'

import { dockerHostsApi, type DockerHostRow } from './resources-api'

interface DockerHostsSettingsProps {
  orgId: string
  initial: DockerHostRow[]
  /** `docker-host:update` — create, edit, test and delete. */
  canManage: boolean
}

const byName = (a: DockerHostRow, b: DockerHostRow) => a.name.localeCompare(b.name)

const target = (row: Pick<DockerHostRow, 'connectionType' | 'socketPath' | 'url'>) =>
  row.connectionType === 'tcp' ? (row.url ?? '') : (row.socketPath ?? '')

/** Test outcome → toast. */
async function runTest(orgId: string, body: Parameters<typeof dockerHostsApi.test>[1]) {
  try {
    const result = await dockerHostsApi.test(orgId, body)
    toast.success('Connected to the Docker daemon', {
      description: `${result.containers} container${result.containers === 1 ? '' : 's'} on this host.`,
    })
  } catch (error) {
    const details = error instanceof ApiError ? (error.details as { error?: string } | null) : null
    toast.error('Connection failed', {
      description: details?.error ?? (error instanceof Error ? error.message : undefined),
    })
  }
}

export function DockerHostsSettings({ orgId, initial, canManage }: DockerHostsSettingsProps) {
  const [rows, setRows] = React.useState<DockerHostRow[]>(() => [...initial].sort(byName))
  const [editing, setEditing] = React.useState<DockerHostRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<DockerHostRow | null>(null)
  const [testingId, setTestingId] = React.useState<string | null>(null)

  const upsert = (row: DockerHostRow) =>
    setRows((current) =>
      (current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [...current, row]
      ).sort(byName),
    )

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Docker hosts</CardTitle>
          <CardDescription>
            Docker daemons that Docker Container monitors query, through the worker&apos;s unix
            socket or a TCP endpoint.
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="docker-host-new">
            <Plus /> New Docker host
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Container}
            title="No Docker hosts"
            description={
              canManage
                ? 'Add a Docker host, then create a Docker Container monitor.'
                : 'Admins of this organization can add Docker hosts.'
            }
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {row.name}
                    <Badge variant="outline">
                      {row.connectionType === 'tcp' ? 'TCP' : 'Socket'}
                    </Badge>
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {target(row)}
                  </span>
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Test ${row.name}`}
                      disabled={testingId === row.id}
                      onClick={async () => {
                        setTestingId(row.id)
                        await runTest(orgId, { dockerHostId: row.id })
                        setTestingId(null)
                      }}
                    >
                      {testingId === row.id ? <Loader2 className="animate-spin" /> : <PlugZap />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${row.name}`}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${row.name}`}
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
        <DockerHostDialog
          orgId={orgId}
          host={editing === 'new' ? null : editing}
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
        title={`Delete Docker host “${deleting?.name ?? ''}”?`}
        description="Docker Container monitors using it go DOWN until another host is selected."
        confirmLabel="Delete host"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await dockerHostsApi.remove(deleting.id)
            setRows((current) => current.filter((r) => r.id !== deleting.id))
            toast.success('Docker host deleted')
            setDeleting(null)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not delete the host')
          }
        }}
      />
    </Card>
  )
}

/** Radix unmounts the content when closed, so the form starts from `host` on every open. */
function DockerHostDialog({
  open,
  ...props
}: React.ComponentProps<typeof DockerHostForm> & { open: boolean }) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DockerHostForm {...props} />
      </DialogContent>
    </Dialog>
  )
}

function DockerHostForm({
  orgId,
  host,
  onOpenChange,
  onSaved,
}: {
  orgId: string
  host: DockerHostRow | null
  onOpenChange: (open: boolean) => void
  onSaved: (row: DockerHostRow) => void
}) {
  const [name, setName] = React.useState(host?.name ?? '')
  const [connectionType, setConnectionType] = React.useState<DockerConnectionType>(
    host?.connectionType ?? 'socket',
  )
  const [socketPath, setSocketPath] = React.useState(host?.socketPath ?? DEFAULT_DOCKER_SOCKET)
  const [url, setUrl] = React.useState(host?.url ?? '')
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)

  const targetValid =
    connectionType === 'socket'
      ? socketPath.trim().startsWith('/')
      : DOCKER_URL_PATTERN.test(url.trim())
  const canSave = name.trim().length > 0 && targetValid && !saving

  const payload = () =>
    connectionType === 'socket'
      ? { connectionType, socketPath: socketPath.trim() }
      : { connectionType, url: url.trim() }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const data = { name: name.trim(), ...payload() }
      const row = host
        ? await dockerHostsApi.update(host.id, data)
        : await dockerHostsApi.create(orgId, data)
      toast.success(host ? 'Docker host saved' : 'Docker host created')
      onSaved(row)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the Docker host')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <form onSubmit={save} className="grid gap-5">
        <DialogHeader>
          <DialogTitle>{host ? 'Edit Docker host' : 'New Docker host'}</DialogTitle>
          <DialogDescription>
            Socket paths are resolved on the worker; mount the socket into its container.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="docker-name">Name</Label>
          <Input
            id="docker-name"
            value={name}
            placeholder="Production host"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="docker-type">Connection type</Label>
          <Select
            value={connectionType}
            onValueChange={(v) => setConnectionType(v as DockerConnectionType)}
          >
            <SelectTrigger id="docker-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="socket">Socket</SelectItem>
              <SelectItem value="tcp">TCP / HTTP</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {connectionType === 'socket' ? (
          <div className="grid gap-2">
            <Label htmlFor="docker-socket">Socket path</Label>
            <Input
              id="docker-socket"
              className="font-mono"
              value={socketPath}
              onChange={(e) => setSocketPath(e.target.value)}
            />
          </div>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="docker-url">Daemon URL</Label>
            <Input
              id="docker-url"
              className="font-mono"
              value={url}
              placeholder="tcp://docker.example.com:2375"
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              <code>tcp://</code> and <code>http://</code> are plain text; <code>https://</code>{' '}
              uses TLS.
            </p>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={!targetValid || testing}
            onClick={async () => {
              setTesting(true)
              await runTest(orgId, payload())
              setTesting(false)
            }}
          >
            {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
            Test connection
          </Button>
          <span className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving && <Loader2 className="animate-spin" />}
              {host ? 'Save' : 'Create host'}
            </Button>
          </span>
        </DialogFooter>
      </form>
    </>
  )
}
