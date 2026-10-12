'use client'

import { Cable, KeyRound, Loader2, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api'
import {
  DEFAULT_SSH_PORT,
  normalizeHostFingerprint,
  type SshTunnelAuthMethod,
} from '@/lib/ssh-tunnels'

import { sshTunnelsApi, type SshTunnelRow, type SshTunnelTestBody } from './resources-api'

interface SshTunnelsSettingsProps {
  orgId: string
  initial: SshTunnelRow[]
  /** `ssh-tunnel:update` — create, edit, test and delete. */
  canManage: boolean
}

const byName = (locale: string) => (a: SshTunnelRow, b: SshTunnelRow) =>
  a.name.localeCompare(b.name, locale)

/** The server's error message and the host key it saw, from a failed test. */
function testFailure(error: unknown): { message?: string; fingerprint?: string } {
  const details =
    error instanceof ApiError
      ? (error.details as { error?: string; fingerprint?: string } | null)
      : null
  return {
    message: details?.error ?? (error instanceof Error ? error.message : undefined),
    fingerprint: details?.fingerprint,
  }
}

/** Test outcome → toast; resolves with the fingerprint the bastion presented on a failure. */
function useRunTest() {
  const t = useTranslations('settings.sshTunnels.test')
  return async (orgId: string, body: SshTunnelTestBody): Promise<string | undefined> => {
    try {
      const result = await sshTunnelsApi.test(orgId, body)
      toast.success(t('connected'), {
        description: t('connectedIn', { ms: result.ms ?? 0 }),
      })
      return undefined
    } catch (error) {
      const failure = testFailure(error)
      toast.error(t('failed'), { description: failure.message })
      return failure.fingerprint
    }
  }
}

export function SshTunnelsSettings({ orgId, initial, canManage }: SshTunnelsSettingsProps) {
  const t = useTranslations('settings.sshTunnels')
  const locale = useLocale()
  const runTest = useRunTest()
  const [rows, setRows] = React.useState<SshTunnelRow[]>(() => [...initial].sort(byName(locale)))
  const [editing, setEditing] = React.useState<SshTunnelRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<SshTunnelRow | null>(null)
  const [testingId, setTestingId] = React.useState<string | null>(null)

  const upsert = (row: SshTunnelRow) =>
    setRows((current) =>
      (current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [...current, row]
      ).sort(byName(locale)),
    )

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="ssh-tunnel-new">
            <Plus /> {t('new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Cable}
            title={t('emptyTitle')}
            description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {row.name}
                    <Badge variant="outline">
                      {row.authMethod === 'privateKey'
                        ? t('badge.privateKey')
                        : t('badge.password')}
                    </Badge>
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {row.username}@{row.host}:{row.port}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {row.knownHostFingerprint}
                  </span>
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('testLabel', { name: row.name })}
                      disabled={testingId === row.id}
                      onClick={async () => {
                        setTestingId(row.id)
                        await runTest(orgId, { sshTunnelId: row.id })
                        setTestingId(null)
                      }}
                    >
                      {testingId === row.id ? <Loader2 className="animate-spin" /> : <PlugZap />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('editLabel', { name: row.name })}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { name: row.name })}
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
        <SshTunnelDialog
          orgId={orgId}
          tunnel={editing === 'new' ? null : editing}
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
        title={t('confirmDeleteTitle', { name: deleting?.name ?? '' })}
        description={t('confirmDeleteDescription')}
        confirmLabel={t('confirmDelete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await sshTunnelsApi.remove(deleting.id)
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

/** Radix unmounts the content when closed, so the form starts from `tunnel` on every open. */
function SshTunnelDialog({
  open,
  ...props
}: React.ComponentProps<typeof SshTunnelForm> & { open: boolean }) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <SshTunnelForm {...props} />
      </DialogContent>
    </Dialog>
  )
}

function SshTunnelForm({
  orgId,
  tunnel,
  onOpenChange,
  onSaved,
}: {
  orgId: string
  tunnel: SshTunnelRow | null
  onOpenChange: (open: boolean) => void
  onSaved: (row: SshTunnelRow) => void
}) {
  const t = useTranslations('settings.sshTunnels.form')
  const runTest = useRunTest()
  const [name, setName] = React.useState(tunnel?.name ?? '')
  const [host, setHost] = React.useState(tunnel?.host ?? '')
  const [port, setPort] = React.useState(String(tunnel?.port ?? DEFAULT_SSH_PORT))
  const [username, setUsername] = React.useState(tunnel?.username ?? '')
  const [authMethod, setAuthMethod] = React.useState<SshTunnelAuthMethod>(
    tunnel?.authMethod ?? 'password',
  )
  // Credentials are never sent to the browser: empty means "keep the stored one".
  const [password, setPassword] = React.useState('')
  const [privateKey, setPrivateKey] = React.useState('')
  const [passphrase, setPassphrase] = React.useState('')
  const [fingerprint, setFingerprint] = React.useState(tunnel?.knownHostFingerprint ?? '')
  const [presented, setPresented] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [fetching, setFetching] = React.useState(false)

  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const sameMethod = tunnel?.authMethod === authMethod
  const storedSecret =
    sameMethod && (authMethod === 'password' ? tunnel?.hasPassword : tunnel?.hasPrivateKey)
  const secretGiven = authMethod === 'password' ? password.length > 0 : privateKey.trim().length > 0
  const fingerprintValid = normalizeHostFingerprint(fingerprint) !== null
  const targetValid = host.trim().length > 0 && portValid
  const connectionValid =
    targetValid &&
    username.trim().length > 0 &&
    fingerprintValid &&
    (secretGiven || Boolean(storedSecret))
  const canSave = name.trim().length > 0 && connectionValid && !saving

  const connection = (): SshTunnelTestBody => ({
    host: host.trim(),
    port: portNumber,
    username: username.trim(),
    authMethod,
    knownHostFingerprint: fingerprint.trim(),
    ...(authMethod === 'password'
      ? password
        ? { password }
        : {}
      : {
          ...(privateKey.trim() ? { privateKey } : {}),
          ...(passphrase ? { passphrase } : {}),
        }),
  })

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const data = { name: name.trim(), ...connection() }
      const row = tunnel
        ? await sshTunnelsApi.update(tunnel.id, data)
        : await sshTunnelsApi.create(orgId, data)
      toast.success(tunnel ? t('saved') : t('created'))
      onSaved(row)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setSaving(false)
    }
  }

  async function fetchFingerprint() {
    setFetching(true)
    try {
      const result = await sshTunnelsApi.test(orgId, {
        host: host.trim(),
        port: portNumber,
        fetchFingerprint: true,
      })
      setPresented(result.fingerprint)
    } catch (error) {
      toast.error(t('fingerprintFailed'), { description: testFailure(error).message })
    } finally {
      setFetching(false)
    }
  }

  const secretHint = storedSecret ? t('keepSecret') : undefined

  return (
    <form onSubmit={save} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{tunnel ? t('editTitle') : t('newTitle')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="ssh-name">{t('name')}</Label>
        <Input
          id="ssh-name"
          value={name}
          placeholder={t('namePlaceholder')}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
        <div className="grid gap-2">
          <Label htmlFor="ssh-host">{t('host')}</Label>
          <Input
            id="ssh-host"
            className="font-mono"
            value={host}
            placeholder="bastion.example.com"
            autoComplete="off"
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ssh-port">{t('port')}</Label>
          <Input
            id="ssh-port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="ssh-username">{t('username')}</Label>
          <Input
            id="ssh-username"
            value={username}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ssh-auth">{t('authMethod')}</Label>
          <Select value={authMethod} onValueChange={(v) => setAuthMethod(v as SshTunnelAuthMethod)}>
            <SelectTrigger id="ssh-auth" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">{t('password')}</SelectItem>
              <SelectItem value="privateKey">{t('privateKey')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {authMethod === 'password' ? (
        <div className="grid gap-2">
          <Label htmlFor="ssh-password">{t('password')}</Label>
          <Input
            id="ssh-password"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {secretHint && <p className="text-sm text-muted-foreground">{secretHint}</p>}
        </div>
      ) : (
        <>
          <div className="grid gap-2">
            <Label htmlFor="ssh-key">{t('privateKey')}</Label>
            <Textarea
              id="ssh-key"
              className="min-h-28 font-mono text-xs"
              value={privateKey}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPrivateKey(e.target.value)}
            />
            {secretHint && <p className="text-sm text-muted-foreground">{secretHint}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ssh-passphrase">{t('passphrase')}</Label>
            <Input
              id="ssh-passphrase"
              type="password"
              value={passphrase}
              autoComplete="new-password"
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
        </>
      )}
      <div className="grid gap-2">
        <Label htmlFor="ssh-fingerprint">{t('fingerprint')}</Label>
        <div className="flex gap-2">
          <Input
            id="ssh-fingerprint"
            className="font-mono"
            value={fingerprint}
            placeholder="SHA256:…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setFingerprint(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!targetValid || fetching}
            onClick={fetchFingerprint}
          >
            {fetching ? <Loader2 className="animate-spin" /> : <KeyRound />}
            {t('fetchFingerprint')}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {t.rich('fingerprintHint', { code: (chunks) => <code>{chunks}</code> })}
        </p>
        {presented && presented !== normalizeHostFingerprint(fingerprint) && (
          <div className="grid gap-2 rounded-md border p-3 text-sm" data-testid="ssh-presented">
            <p className="break-all">{t('presentedFingerprint', { fingerprint: presented })}</p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="justify-self-start"
              onClick={() => {
                setFingerprint(presented)
                setPresented(null)
              }}
            >
              {t('useFingerprint')}
            </Button>
          </div>
        )}
      </div>
      <DialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="outline"
          disabled={!connectionValid || testing}
          onClick={async () => {
            setTesting(true)
            const seen = await runTest(orgId, {
              ...(tunnel ? { sshTunnelId: tunnel.id } : {}),
              ...connection(),
            })
            if (seen) setPresented(seen)
            setTesting(false)
          }}
        >
          {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
          {t('test')}
        </Button>
        <span className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving && <Loader2 className="animate-spin" />}
            {tunnel ? t('save') : t('create')}
          </Button>
        </span>
      </DialogFooter>
    </form>
  )
}
