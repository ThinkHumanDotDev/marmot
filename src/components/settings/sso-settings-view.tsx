'use client'

import { Check, Copy, Globe, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
  /** `organizations.enforceSso`. */
  enforceSso: boolean
  /** `sso:manage` (owners). */
  canManage: boolean
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

function CopyField({ label, value }: { label: string; value: string }) {
  const t = useTranslations('settings.sso')
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
          aria-label={t('copyLabel', { label })}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {
              toast.error(t('copyFailed'))
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
  enforceSso: initialEnforceSso,
  canManage,
}: SsoSettingsViewProps) {
  const t = useTranslations('settings.sso')
  const locale = useLocale()
  const [connections, setConnections] = React.useState(initialConnections)
  const [domains, setDomains] = React.useState(initialDomains)
  const [enforceSso, setEnforceSso] = React.useState(initialEnforceSso)
  const canEnforce = domains.some((d) => d.verifiedAt) && connections.some((c) => c.enabled)

  const setEnforcement = (value: boolean) =>
    run(
      'enforce',
      async () => {
        const result = await ssoApi.setEnforcement(orgId, value)
        setEnforceSso(result.enforceSso)
        toast.success(result.enforceSso ? t('enforcement.enabled') : t('enforcement.disabled'))
      },
      t('enforcement.failed'),
    )
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
        : [...current, row].sort((a, b) => a.name.localeCompare(b.name, locale)),
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
        toast.success(editing.row ? t('connections.saved') : t('connections.created'))
        setEditing(null)
      },
      t('connections.saveFailed'),
    )

  const toggle = (row: SsoConnectionRow, enabled: boolean) =>
    run(
      String(row.id),
      async () => {
        const { doc } = await ssoApi.connections.update(orgId, row.id, { enabled })
        upsert(doc)
        toast.success(enabled ? t('connections.enabledToast') : t('connections.disabledToast'))
      },
      t('connections.updateFailed'),
    )

  const confirmRemove = async () => {
    if (!removing) return
    await run(
      String(removing.id),
      async () => {
        await ssoApi.connections.remove(orgId, removing.id)
        setConnections((current) => current.filter((c) => String(c.id) !== String(removing.id)))
        toast.success(t('connections.deleted'))
        setRemoving(null)
      },
      t('connections.deleteFailed'),
    )
  }

  const addDomain = (event: React.FormEvent) => {
    event.preventDefault()
    return run(
      'domain',
      async () => {
        const { doc } = await ssoApi.domains.add(orgId, newDomain)
        setDomains((current) =>
          [...current, doc].sort((a, b) => a.domain.localeCompare(b.domain, locale)),
        )
        setNewDomain('')
        toast.success(t('domains.added', { domain: doc.domain }))
      },
      t('domains.addFailed'),
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
        if (result.verified) toast.success(t('domains.verifiedToast', { domain: row.domain }))
        else toast.error(result.reason ?? t('domains.notVerified'))
      },
      t('domains.verifyFailed'),
    )

  const confirmRemoveDomain = async () => {
    if (!removingDomain) return
    await run(
      String(removingDomain.id),
      async () => {
        await ssoApi.domains.remove(orgId, removingDomain.id)
        setDomains((current) => current.filter((d) => String(d.id) !== String(removingDomain.id)))
        toast.success(t('domains.removed'))
        setRemovingDomain(null)
      },
      t('domains.removeFailed'),
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
        toast.success(t('form.metadataImported'))
      },
      t('form.metadataFailed'),
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
              <KeyRound className="size-4 text-muted-foreground" aria-hidden />{' '}
              {t('connections.title')}
            </CardTitle>
            <CardDescription>
              {t.rich('connections.description', {
                link: () => <code>/login/sso?org={orgSlug}</code>,
              })}
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => setEditing({ row: null, form: emptyForm(orgSlug) })}>
              <Plus /> {t('connections.new')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {connections.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title={t('connections.emptyTitle')}
              description={
                canManage ? t('connections.emptyDescription') : t('connections.emptyReadOnly')
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('connections.columns.name')}</TableHead>
                  <TableHead>{t('connections.columns.type')}</TableHead>
                  <TableHead>{t('connections.columns.provisioning')}</TableHead>
                  <TableHead>{t('connections.columns.enabled')}</TableHead>
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
                        {row.type === 'saml' ? t('protocols.saml') : t('protocols.oidc')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.autoProvision
                        ? t('connections.joinAs', { role: row.defaultRole })
                        : t('connections.existingOnly')}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={row.enabled}
                        disabled={!canManage || busy === String(row.id)}
                        onCheckedChange={(enabled) => toggle(row, enabled)}
                        aria-label={t('connections.enabledLabel', { name: row.name })}
                      />
                    </TableCell>
                    <TableCell>
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('connections.deleteLabel', { name: row.name })}
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
            <Globe className="size-4 text-muted-foreground" aria-hidden /> {t('domains.title')}
          </CardTitle>
          <CardDescription>{t('domains.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {canManage && (
            <form onSubmit={addDomain} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor={ids.domain}>{t('domains.domain')}</Label>
                <Input
                  id={ids.domain}
                  placeholder={t('domains.domainPlaceholder')}
                  value={newDomain}
                  onChange={(event) => setNewDomain(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={busy === 'domain' || !newDomain.trim()}>
                <Plus /> {t('domains.add')}
              </Button>
            </form>
          )}
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('domains.empty')}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border">
              {domains.map((row) => (
                <li key={String(row.id)} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 font-medium">{row.domain}</span>
                    {row.verifiedAt ? (
                      <Badge variant="outline">{t('domains.verified')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('domains.pending')}</Badge>
                    )}
                    {canManage && !row.verifiedAt && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === String(row.id)}
                        onClick={() => verify(row)}
                      >
                        <RefreshCw className="size-4" /> {t('domains.verify')}
                      </Button>
                    )}
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('domains.removeLabel', { domain: row.domain })}
                        onClick={() => setRemovingDomain(row)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  {!row.verifiedAt && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <CopyField label={t('domains.recordName')} value={row.record.name} />
                      <CopyField label={t('domains.recordValue')} value={row.record.value} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card data-testid="sso-enforcement-card">
        <CardHeader>
          <CardTitle>{t('enforcement.title')}</CardTitle>
          <CardDescription>{t('enforcement.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {canEnforce
              ? enforceSso
                ? t('enforcement.on')
                : t('enforcement.off')
              : t('enforcement.unavailable')}
          </p>
          <Switch
            checked={enforceSso}
            disabled={!canManage || !canEnforce || busy === 'enforce'}
            onCheckedChange={setEnforcement}
            aria-label={t('enforcement.title')}
          />
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
                  {editing?.row
                    ? t('form.editTitle', { name: editing.row.name })
                    : t('form.newTitle')}
                </DialogTitle>
                <DialogDescription>
                  {form.type === 'saml' ? t('form.samlDescription') : t('form.oidcDescription')}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label>{t('form.name')}</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ name: e.target.value })}
                    required
                    placeholder={t('form.namePlaceholder')}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{t('form.slug')}</Label>
                  <Input
                    value={form.slug}
                    onChange={(e) => setForm({ slug: e.target.value })}
                    required
                    pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"
                    disabled={Boolean(editing?.row)}
                    placeholder={t('form.slugPlaceholder')}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{t('form.protocol')}</Label>
                  <Select
                    value={form.type}
                    onValueChange={(type) => setForm({ type: type as 'oidc' | 'saml' })}
                    disabled={Boolean(editing?.row)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="oidc">{t('protocols.oidc')}</SelectItem>
                      <SelectItem value="saml">{t('protocols.saml')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label>{t('form.defaultRole')}</Label>
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
                      <SelectItem value="admin">{t('roles.admin')}</SelectItem>
                      <SelectItem value="member">{t('roles.member')}</SelectItem>
                      <SelectItem value="viewer">{t('roles.viewer')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {form.type === 'oidc' ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <Label>{t('form.issuerUrl')}</Label>
                    <Input
                      type="url"
                      value={form.issuerUrl}
                      onChange={(e) => setForm({ issuerUrl: e.target.value })}
                      required
                      placeholder={t('form.issuerUrlPlaceholder')}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label>{t('form.clientId')}</Label>
                      <Input
                        value={form.clientId}
                        onChange={(e) => setForm({ clientId: e.target.value })}
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label>{t('form.clientSecret')}</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={form.clientSecret}
                        onChange={(e) => setForm({ clientSecret: e.target.value })}
                        required={!editing?.row?.hasClientSecret}
                        placeholder={editing?.row?.hasClientSecret ? t('form.unchanged') : ''}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>{t('form.scopes')}</Label>
                    <Input
                      value={form.scopes}
                      onChange={(e) => setForm({ scopes: e.target.value })}
                    />
                  </div>
                  {editing?.row && (
                    <CopyField label={t('form.redirectUri')} value={editing.row.callbackUrl} />
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {editing?.row && (
                    <div className="grid gap-2 rounded-md border p-3">
                      <CopyField
                        label={t('form.spEntityId')}
                        value={editing.row.metadataUrl ?? ''}
                      />
                      <CopyField label={t('form.acsUrl')} value={editing.row.callbackUrl} />
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={ids.metadata}>{t('form.metadataUrl')}</Label>
                    <div className="flex gap-2">
                      <Input
                        id={ids.metadata}
                        type="url"
                        value={metadataUrl}
                        onChange={(e) => setMetadataUrl(e.target.value)}
                        placeholder={t('form.metadataUrlPlaceholder')}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy === 'metadata' || !metadataUrl.trim()}
                        onClick={importMetadata}
                      >
                        {t('form.import')}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>{t('form.idpEntryPoint')}</Label>
                    <Input
                      type="url"
                      value={form.idpEntryPoint}
                      onChange={(e) => setForm({ idpEntryPoint: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>{t('form.idpEntityId')}</Label>
                    <Input
                      value={form.idpEntityId}
                      onChange={(e) => setForm({ idpEntityId: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>{t('form.idpCert')}</Label>
                    <Textarea
                      rows={5}
                      value={form.idpCert}
                      onChange={(e) => setForm({ idpCert: e.target.value })}
                      required
                      placeholder="-----BEGIN CERTIFICATE-----"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label>{t('form.wantAssertionsSigned')}</Label>
                    <Switch
                      checked={form.wantAssertionsSigned !== false}
                      onCheckedChange={(v) => setForm({ wantAssertionsSigned: v })}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label>{t('form.allowIdpInitiated')}</Label>
                    <Switch
                      checked={form.allowIdpInitiated === true}
                      onCheckedChange={(v) => setForm({ allowIdpInitiated: v })}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>{t('form.autoProvision')}</Label>
                  <p className="text-xs text-muted-foreground">{t('form.autoProvisionHint')}</p>
                </div>
                <Switch
                  checked={form.autoProvision !== false}
                  onCheckedChange={(v) => setForm({ autoProvision: v })}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  {t('form.cancel')}
                </Button>
                <Button type="submit" disabled={busy === 'save'}>
                  {busy === 'save'
                    ? t('form.saving')
                    : editing?.row
                      ? t('form.save')
                      : t('form.create')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('connections.confirmDeleteTitle', { name: removing?.name ?? '' })}
        description={t('connections.confirmDeleteDescription')}
        confirmLabel={t('connections.confirmDelete')}
        destructive
        onConfirm={confirmRemove}
      />
      <ConfirmDialog
        open={removingDomain !== null}
        onOpenChange={(open) => !open && setRemovingDomain(null)}
        title={t('domains.confirmRemoveTitle', { domain: removingDomain?.domain ?? '' })}
        description={t('domains.confirmRemoveDescription')}
        confirmLabel={t('domains.confirmRemove')}
        destructive
        onConfirm={confirmRemoveDomain}
      />
    </>
  )
}
