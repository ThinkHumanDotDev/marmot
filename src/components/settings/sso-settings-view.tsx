'use client'

import { Check, Copy, Globe, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  ssoApi,
  type SsoConnectionInput,
  type SsoConnectionRow,
  type SsoDomainRow,
} from '@/lib/sso-api'

interface SsoSettingsViewProps {
  orgId: string
  orgSlug: string
  connections: SsoConnectionRow[]
  domains: SsoDomainRow[]
  /** `sso:manage` (owners). */
  canManage: boolean
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{value}</code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {
              toast.error('Could not copy')
            }
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  )
}

const emptyForm = (slugPrefix: string): SsoConnectionInput => ({
  name: '',
  slug: `${slugPrefix}-sso`,
  type: 'oidc',
  enabled: true,
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  idpEntryPoint: '',
  idpEntityId: '',
  idpCert: '',
  wantAssertionsSigned: true,
  allowIdpInitiated: false,
  autoProvision: true,
  defaultRole: 'member',
})

const toForm = (row: SsoConnectionRow): SsoConnectionInput => ({
  name: row.name,
  slug: row.slug,
  type: row.type,
  enabled: row.enabled,
  issuerUrl: row.issuerUrl ?? '',
  clientId: row.clientId ?? '',
  clientSecret: '',
  scopes: row.scopes ?? 'openid email profile',
  idpEntryPoint: row.idpEntryPoint ?? '',
  idpEntityId: row.idpEntityId ?? '',
  idpCert: row.idpCert ?? '',
  wantAssertionsSigned: row.wantAssertionsSigned,
  allowIdpInitiated: row.allowIdpInitiated,
  autoProvision: row.autoProvision,
  defaultRole: row.defaultRole === 'owner' ? 'member' : row.defaultRole,
})

/**
 * Settings → Security: the organization's single sign-on connections (OpenID Connect or SAML 2.0)
 * and the email domains it has verified. Owners manage, admins can see.
 */
export function SsoSettingsView({
  orgId,
  orgSlug,
  connections: initialConnections,
  domains: initialDomains,
  canManage,
}: SsoSettingsViewProps) {
  const [connections, setConnections] = React.useState(initialConnections)
  const [domains, setDomains] = React.useState(initialDomains)
  const [editing, setEditing] = React.useState<{
    row: SsoConnectionRow | null
    form: SsoConnectionInput
  } | null>(null)
  const [removing, setRemoving] = React.useState<SsoConnectionRow | null>(null)
  const [removingDomain, setRemovingDomain] = React.useState<SsoDomainRow | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [newDomain, setNewDomain] = React.useState('')
  const [metadataUrl, setMetadataUrl] = React.useState('')
  const ids = { domain: React.useId(), metadata: React.useId() }

  const upsert = (row: SsoConnectionRow) =>
    setConnections((current) =>
      current.some((c) => String(c.id) === String(row.id))
        ? current.map((c) => (String(c.id) === String(row.id) ? row : c))
        : [...current, row].sort((a, b) => a.name.localeCompare(b.name)),
    )

  async function run(key: string, action: () => Promise<void>, fallback: string) {
    setBusy(key)
    try {
      await action()
    } catch (error) {
      toast.error(message(error, fallback))
    } finally {
      setBusy(null)
    }
  }

  const saveConnection = () =>
    run(
      'save',
      async () => {
        if (!editing) return
        const data = { ...editing.form }
        if (!data.clientSecret) delete data.clientSecret
        const { doc } = editing.row
          ? await ssoApi.connections.update(orgId, editing.row.id, data)
          : await ssoApi.connections.create(orgId, data)
        upsert(doc)
        toast.success(editing.row ? 'Connection saved' : 'Connection created')
        setEditing(null)
      },
      'Could not save the connection.',
    )

  const toggle = (row: SsoConnectionRow, enabled: boolean) =>
    run(
      String(row.id),
      async () => {
        const { doc } = await ssoApi.connections.update(orgId, row.id, { enabled })
        upsert(doc)
        toast.success(enabled ? 'Connection enabled' : 'Connection disabled')
      },
      'Could not update the connection.',
    )

  const confirmRemove = async () => {
    if (!removing) return
    await run(
      String(removing.id),
      async () => {
        await ssoApi.connections.remove(orgId, removing.id)
        setConnections((current) => current.filter((c) => String(c.id) !== String(removing.id)))
        toast.success('Connection deleted')
        setRemoving(null)
      },
      'Could not delete the connection.',
    )
  }

  const addDomain = (event: React.FormEvent) => {
    event.preventDefault()
    return run(
      'domain',
      async () => {
        const { doc } = await ssoApi.domains.add(orgId, newDomain)
        setDomains((current) => [...current, doc].sort((a, b) => a.domain.localeCompare(b.domain)))
        setNewDomain('')
        toast.success(`Add the TXT record for ${doc.domain}, then verify it`)
      },
      'Could not add the domain.',
    )
  }

  const verify = (row: SsoDomainRow) =>
    run(
      String(row.id),
      async () => {
        const result = await ssoApi.domains.verify(orgId, row.id)
        setDomains((current) =>
          current.map((d) => (String(d.id) === String(row.id) ? result.doc : d)),
        )
        if (result.verified) toast.success(`${row.domain} verified`)
        else toast.error(result.reason ?? 'Not verified yet')
      },
      'Could not verify the domain.',
    )

  const confirmRemoveDomain = async () => {
    if (!removingDomain) return
    await run(
      String(removingDomain.id),
      async () => {
        await ssoApi.domains.remove(orgId, removingDomain.id)
        setDomains((current) => current.filter((d) => String(d.id) !== String(removingDomain.id)))
        toast.success('Domain removed')
        setRemovingDomain(null)
      },
      'Could not remove the domain.',
    )
  }

  const importMetadata = () =>
    run(
      'metadata',
      async () => {
        if (!editing) return
        const parsed = await ssoApi.parseMetadata(orgId, { url: metadataUrl.trim() })
        setEditing({
          ...editing,
          form: {
            ...editing.form,
            idpEntryPoint: parsed.entryPoint,
            idpEntityId: parsed.entityId,
            idpCert: parsed.certificate ?? editing.form.idpCert,
          },
        })
        toast.success('Identity provider settings imported')
      },
      'Could not read the metadata.',
    )

  const form = editing?.form
  const setForm = (patch: Partial<SsoConnectionInput>) =>
    setEditing((current) =>
      current ? { ...current, form: { ...current.form, ...patch } } : current,
    )

  return (
    <>
      <Card data-testid="sso-connections-card">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" aria-hidden /> Single sign-on
            </CardTitle>
            <CardDescription>
              Let members sign in through your identity provider (OpenID Connect or SAML 2.0).
              People who sign in this way join this organization automatically. Shareable sign-in
              link: <code>/login/sso?org={orgSlug}</code>
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => setEditing({ row: null, form: emptyForm(orgSlug) })}>
              <Plus /> New connection
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {connections.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No connections yet"
              description={
                canManage
                  ? 'Connect Okta, Entra ID, Keycloak, Google Workspace or any OIDC/SAML provider.'
                  : 'Owners of this organization can set up single sign-on.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Provisioning</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((row) => (
                  <TableRow key={String(row.id)}>
                    <TableCell>
                      <button
                        type="button"
                        className="font-medium underline-offset-4 hover:underline"
                        onClick={() => setEditing({ row, form: toForm(row) })}
                      >
                        {row.name}
                      </button>
                      <p className="text-xs text-muted-foreground">{row.slug}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {row.type === 'saml' ? 'SAML 2.0' : 'OpenID Connect'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.autoProvision ? `Join as ${row.defaultRole}` : 'Existing users only'}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={row.enabled}
                        disabled={!canManage || busy === String(row.id)}
                        onCheckedChange={(enabled) => toggle(row, enabled)}
                        aria-label={`${row.name} enabled`}
                      />
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${row.name}`}
                          onClick={() => setRemoving(row)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="sso-domains-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" aria-hidden /> Verified domains
          </CardTitle>
          <CardDescription>
            People who enter an email on a verified domain on the SSO sign-in page are sent to your
            connections. Prove ownership with a DNS TXT record; a domain can belong to one
            organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {canManage && (
            <form onSubmit={addDomain} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor={ids.domain}>Domain</Label>
                <Input
                  id={ids.domain}
                  placeholder="example.com"
                  value={newDomain}
                  onChange={(event) => setNewDomain(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={busy === 'domain' || !newDomain.trim()}>
                <Plus /> Add domain
              </Button>
            </form>
          )}
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domains yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border">
              {domains.map((row) => (
                <li key={String(row.id)} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 font-medium">{row.domain}</span>
                    {row.verifiedAt ? (
                      <Badge variant="outline">Verified</Badge>
                    ) : (
                      <Badge variant="secondary">Pending</Badge>
                    )}
                    {canManage && !row.verifiedAt && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === String(row.id)}
                        onClick={() => verify(row)}
                      >
                        <RefreshCw className="size-4" /> Verify
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${row.domain}`}
                        onClick={() => setRemovingDomain(row)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  {!row.verifiedAt && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <CopyField label="TXT record name" value={row.record.name} />
                      <CopyField label="TXT record value" value={row.record.value} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          {form && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void saveConnection()
              }}
              className="flex flex-col gap-4"
            >
              <DialogHeader>
                <DialogTitle>
                  {editing?.row ? `Edit ${editing.row.name}` : 'New connection'}
                </DialogTitle>
                <DialogDescription>
                  {form.type === 'saml'
                    ? 'Register the service-provider details below at your identity provider, then paste what it gives you back.'
                    : 'Register the redirect URI below at your identity provider as a confidential web client.'}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label>Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ name: e.target.value })}
                    required
                    placeholder="Okta"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Slug</Label>
                  <Input
                    value={form.slug}
                    onChange={(e) => setForm({ slug: e.target.value })}
                    required
                    pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"
                    disabled={Boolean(editing?.row)}
                    placeholder="acme-okta"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Protocol</Label>
                  <Select
                    value={form.type}
                    onValueChange={(type) => setForm({ type: type as 'oidc' | 'saml' })}
                    disabled={Boolean(editing?.row)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="oidc">OpenID Connect</SelectItem>
                      <SelectItem value="saml">SAML 2.0</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Default role for new members</Label>
                  <Select
                    value={form.defaultRole ?? 'member'}
                    onValueChange={(role) =>
                      setForm({ defaultRole: role as SsoConnectionInput['defaultRole'] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">admin</SelectItem>
                      <SelectItem value="member">member</SelectItem>
                      <SelectItem value="viewer">viewer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {form.type === 'oidc' ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <Label>Issuer URL</Label>
                    <Input
                      type="url"
                      value={form.issuerUrl}
                      onChange={(e) => setForm({ issuerUrl: e.target.value })}
                      required
                      placeholder="https://acme.okta.com"
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label>Client id</Label>
                      <Input
                        value={form.clientId}
                        onChange={(e) => setForm({ clientId: e.target.value })}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label>Client secret</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={form.clientSecret}
                        onChange={(e) => setForm({ clientSecret: e.target.value })}
                        required={!editing?.row?.hasClientSecret}
                        placeholder={editing?.row?.hasClientSecret ? 'Unchanged' : ''}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>Scopes</Label>
                    <Input
                      value={form.scopes}
                      onChange={(e) => setForm({ scopes: e.target.value })}
                    />
                  </div>
                  {editing?.row && (
                    <CopyField label="Redirect URI" value={editing.row.callbackUrl} />
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {editing?.row && (
                    <div className="grid gap-2 rounded-md border p-3">
                      <CopyField
                        label="SP entity id / metadata URL"
                        value={editing.row.metadataUrl ?? ''}
                      />
                      <CopyField
                        label="Assertion consumer service URL (ACS)"
                        value={editing.row.callbackUrl}
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={ids.metadata}>Import from IdP metadata URL (optional)</Label>
                    <div className="flex gap-2">
                      <Input
                        id={ids.metadata}
                        type="url"
                        value={metadataUrl}
                        onChange={(e) => setMetadataUrl(e.target.value)}
                        placeholder="https://idp.example.com/metadata"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy === 'metadata' || !metadataUrl.trim()}
                        onClick={importMetadata}
                      >
                        Import
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>IdP single sign-on URL</Label>
                    <Input
                      type="url"
                      value={form.idpEntryPoint}
                      onChange={(e) => setForm({ idpEntryPoint: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>IdP entity id (issuer)</Label>
                    <Input
                      value={form.idpEntityId}
                      onChange={(e) => setForm({ idpEntityId: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>IdP signing certificate</Label>
                    <Textarea
                      rows={5}
                      value={form.idpCert}
                      onChange={(e) => setForm({ idpCert: e.target.value })}
                      required
                      placeholder="-----BEGIN CERTIFICATE-----"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label>Require signed assertions</Label>
                    <Switch
                      checked={form.wantAssertionsSigned !== false}
                      onCheckedChange={(v) => setForm({ wantAssertionsSigned: v })}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label>Allow IdP-initiated login</Label>
                    <Switch
                      checked={form.allowIdpInitiated === true}
                      onCheckedChange={(v) => setForm({ allowIdpInitiated: v })}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Create accounts on first login</Label>
                  <p className="text-xs text-muted-foreground">
                    Off: only existing Marmot users can sign in through this connection.
                  </p>
                </div>
                <Switch
                  checked={form.autoProvision !== false}
                  onCheckedChange={(v) => setForm({ autoProvision: v })}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy === 'save'}>
                  {busy === 'save' ? 'Saving…' : editing?.row ? 'Save' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete ${removing?.name ?? ''}?`}
        description="Members will no longer be able to sign in through this connection. Linked identities stay on their accounts."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmRemove}
      />
      <ConfirmDialog
        open={removingDomain !== null}
        onOpenChange={(open) => !open && setRemovingDomain(null)}
        title={`Remove ${removingDomain?.domain ?? ''}?`}
        description="Emails on this domain will no longer be routed to your connections."
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemoveDomain}
      />
    </>
  )
}
