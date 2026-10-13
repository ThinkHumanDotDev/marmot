'use client'

import {
  Check,
  Copy,
  KeyRound,
  ListTree,
  MoreHorizontal,
  Pencil,
  Plus,
  Siren,
  Trash2,
} from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { DECLARED_INCIDENT_SEVERITIES } from '@/lib/declared-incidents'
import {
  DEFAULT_EMAIL_RESOLVED_KEYWORD,
  DEFAULT_GENERIC_MAPPING,
  INTEGRATION_FORMATS,
  RULE_IMPACTS,
  RULE_INCIDENT_MODES,
  RULE_MATCH_OPERATORS,
  type GenericMapping,
  type IntegrationChoices,
  type IntegrationEventRow,
  type IntegrationFormat,
  type IntegrationRow,
} from '@/lib/inbound-alerts'
import { integrationsApi, type IntegrationSecret } from '@/lib/integrations-api'

type Rule = IntegrationRow['rules'][number]

interface IntegrationsViewProps {
  orgId: string
  initial: IntegrationRow[]
  choices: IntegrationChoices
  /** Inbound email is configured, so integrations also have an address. */
  emailEnabled: boolean
  /** `integration:manage` (admins and owners by default). */
  canManage: boolean
}

const NONE = '__none__'

const failure = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

const newRule = (): Rule => ({
  id: '',
  name: '',
  enabled: true,
  matchField: '',
  matchOperator: 'equals',
  matchValue: '',
  updateComponent: false,
  statusPage: null,
  component: null,
  impact: 'partial_outage',
  incident: 'draft',
  severity: 'major',
  monitor: null,
})

/** Settings → Integrations: inbound alert endpoints, their rules, tokens (shown once) and event log. */
export function IntegrationsView({
  orgId,
  initial,
  choices,
  emailEnabled,
  canManage,
}: IntegrationsViewProps) {
  const t = useTranslations('settings.integrations')
  const format = useFormatter()
  const [rows, setRows] = React.useState<IntegrationRow[]>(initial)
  const [editing, setEditing] = React.useState<IntegrationRow | 'new' | null>(null)
  const [revealed, setRevealed] = React.useState<IntegrationSecret | null>(null)
  const [deleting, setDeleting] = React.useState<IntegrationRow | null>(null)
  const [rotating, setRotating] = React.useState<IntegrationRow | null>(null)
  const [viewing, setViewing] = React.useState<IntegrationRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const upsert = (row: IntegrationRow) =>
    setRows((current) =>
      current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [...current, row],
    )

  async function toggleActive(row: IntegrationRow, active: boolean) {
    setBusyId(row.id)
    try {
      const { doc } = await integrationsApi.update(orgId, row.id, { active })
      upsert(doc)
    } catch (error) {
      toast.error(failure(error, t('saveFailed')))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmRotate() {
    if (!rotating) return
    setBusyId(rotating.id)
    try {
      const secret = await integrationsApi.rotateToken(orgId, rotating.id)
      upsert(secret.doc)
      setRotating(null)
      setRevealed(secret)
    } catch (error) {
      toast.error(failure(error, t('rotateFailed')))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyId(deleting.id)
    try {
      await integrationsApi.remove(orgId, deleting.id)
      setRows((current) => current.filter((r) => r.id !== deleting.id))
      toast.success(t('deleted'))
      setDeleting(null)
    } catch (error) {
      toast.error(failure(error, t('deleteFailed')))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <Card data-testid="integrations-card">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Siren className="size-4 text-muted-foreground" aria-hidden /> {t('title')}
            </CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> {t('newIntegration')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              icon={Siren}
              title={t('emptyTitle')}
              description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.name')}</TableHead>
                  <TableHead>{t('columns.format')}</TableHead>
                  <TableHead>{t('columns.rules')}</TableHead>
                  <TableHead>{t('columns.lastEvent')}</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} data-testid={`integration-${row.id}`}>
                    <TableCell>
                      <div className="font-medium">{row.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {row.tokenPrefix}…
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t(`formats.${row.format}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t('ruleCount', { count: row.rules.length })}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.lastEventAt
                        ? format.dateTime(new Date(row.lastEventAt), 'short')
                        : t('never')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        {canManage ? (
                          <Switch
                            checked={row.active}
                            disabled={busyId === row.id}
                            onCheckedChange={(checked) => toggleActive(row, checked)}
                            aria-label={t('activeLabel', { name: row.name })}
                          />
                        ) : (
                          !row.active && <Badge variant="secondary">{t('paused')}</Badge>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t('actionsLabel', { name: row.name })}
                              disabled={busyId === row.id}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setViewing(row)}>
                              <ListTree /> {t('viewEvents')}
                            </DropdownMenuItem>
                            {canManage && (
                              <>
                                <DropdownMenuItem onSelect={() => setEditing(row)}>
                                  <Pencil /> {t('edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setRotating(row)}>
                                  <KeyRound /> {t('rotateToken')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => setDeleting(row)}
                                >
                                  <Trash2 /> {t('delete')}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            {editing && (
              <IntegrationForm
                key={editing === 'new' ? 'new' : editing.id}
                orgId={orgId}
                existing={editing === 'new' ? null : editing}
                choices={choices}
                emailEnabled={emailEnabled}
                onClose={() => setEditing(null)}
                onSaved={(doc, secret) => {
                  upsert(doc)
                  if (secret) setRevealed(secret)
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}

      <RevealDialog revealed={revealed} onClose={() => setRevealed(null)} />

      <EventsDialog
        key={viewing?.id ?? 'closed'}
        orgId={orgId}
        integration={viewing}
        onClose={() => setViewing(null)}
      />

      <Dialog open={rotating !== null} onOpenChange={(open) => !open && setRotating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rotateTitle')}</DialogTitle>
            <DialogDescription>{t('rotateDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotating(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={confirmRotate} disabled={busyId === rotating?.id}>
              <KeyRound /> {t('rotateToken')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDescription', { name: deleting?.name ?? '' })}
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

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function IntegrationForm({
  orgId,
  existing,
  choices,
  emailEnabled,
  onClose,
  onSaved,
}: {
  orgId: string
  existing: IntegrationRow | null
  choices: IntegrationChoices
  emailEnabled: boolean
  onClose: () => void
  onSaved: (doc: IntegrationRow, secret: IntegrationSecret | null) => void
}) {
  const t = useTranslations('settings.integrations.form')
  const tFormats = useTranslations('settings.integrations.formats')
  const [name, setName] = React.useState(existing?.name ?? '')
  const [kind, setKind] = React.useState<IntegrationFormat>(existing?.format ?? 'alertmanager')
  const [generic, setGeneric] = React.useState<GenericMapping>({
    ...DEFAULT_GENERIC_MAPPING,
    ...(existing?.generic ?? {}),
  })
  const [keyword, setKeyword] = React.useState(
    existing?.emailResolvedKeyword || DEFAULT_EMAIL_RESOLVED_KEYWORD,
  )
  const [rules, setRules] = React.useState<Rule[]>(existing?.rules ?? [newRule()])
  const [busy, setBusy] = React.useState(false)

  const updateRule = (index: number, patch: Partial<Rule>) =>
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const data = {
      name: name.trim(),
      format: kind,
      emailResolvedKeyword: keyword.trim(),
      generic: Object.fromEntries(
        Object.entries(generic).map(([key, value]) => [key, value ?? '']),
      ),
      rules: rules.map((rule) => ({
        ...rule,
        id: rule.id || null,
        component: rule.statusPage ? rule.component : null,
      })),
    }
    try {
      if (existing) {
        const { doc } = await integrationsApi.update(orgId, existing.id, data)
        onSaved(doc, null)
      } else {
        const secret = await integrationsApi.create(orgId, data)
        onSaved(secret.doc, secret)
      }
      onClose()
    } catch (error) {
      toast.error(failure(error, t('failed')))
    } finally {
      setBusy(false)
    }
  }

  const genericFields = [
    'alertsPath',
    'titlePath',
    'statusPath',
    'severityPath',
    'dedupKeyPath',
    'descriptionPath',
    'resolvedValues',
  ] as const

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>{existing ? t('editTitle') : t('createTitle')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="integration-name" label={t('name')}>
          <Input
            id="integration-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={t('namePlaceholder')}
            autoFocus
            required
          />
        </Field>
        <Field id="integration-format" label={t('format')}>
          <Select value={kind} onValueChange={(value) => setKind(value as IntegrationFormat)}>
            <SelectTrigger id="integration-format" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTEGRATION_FORMATS.map((value) => (
                <SelectItem key={value} value={value}>
                  {tFormats(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {kind === 'generic' && (
        <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">{t('mapping')}</legend>
          {genericFields.map((key) => (
            <Field key={key} id={`generic-${key}`} label={t(`generic.${key}`)}>
              <Input
                id={`generic-${key}`}
                value={generic[key] ?? ''}
                onChange={(e) => setGeneric((current) => ({ ...current, [key]: e.target.value }))}
                maxLength={200}
                className="font-mono text-xs"
              />
            </Field>
          ))}
        </fieldset>
      )}

      {emailEnabled && (
        <Field id="integration-keyword" label={t('emailKeyword')} hint={t('emailKeywordHint')}>
          <Input
            id="integration-keyword"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            maxLength={100}
          />
        </Field>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">{t('rules')}</h3>
            <p className="text-xs text-muted-foreground">{t('rulesHint')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRules((current) => [...current, newRule()])}
          >
            <Plus /> {t('addRule')}
          </Button>
        </div>
        {rules.map((rule, index) => (
          <RuleEditor
            key={rule.id || `new-${index}`}
            index={index}
            rule={rule}
            choices={choices}
            onChange={(patch) => updateRule(index, patch)}
            onRemove={() => setRules((current) => current.filter((_, i) => i !== index))}
          />
        ))}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          <Siren /> {existing ? t('save') : t('create')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function RuleEditor({
  index,
  rule,
  choices,
  onChange,
  onRemove,
}: {
  index: number
  rule: Rule
  choices: IntegrationChoices
  onChange: (patch: Partial<Rule>) => void
  onRemove: () => void
}) {
  const t = useTranslations('settings.integrations.rule')
  const page = choices.statusPages.find((p) => p.id === rule.statusPage)
  const id = (field: string) => `rule-${index}-${field}`

  return (
    <fieldset className="grid gap-3 rounded-md border p-3" data-testid={`rule-${index}`}>
      <legend className="px-1 text-sm font-medium">{t('legend', { number: index + 1 })}</legend>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field id={id('name')} label={t('name')}>
          <Input
            id={id('name')}
            value={rule.name}
            onChange={(e) => onChange({ name: e.target.value })}
            maxLength={100}
          />
        </Field>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={rule.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
          {t('enabled')}
        </label>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 /> {t('remove')}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={id('field')} label={t('matchField')} hint={t('matchFieldHint')}>
          <Input
            id={id('field')}
            value={rule.matchField}
            onChange={(e) => onChange({ matchField: e.target.value })}
            maxLength={100}
            className="font-mono text-xs"
          />
        </Field>
        <Field id={id('operator')} label={t('matchOperator')}>
          <Select
            value={rule.matchOperator}
            onValueChange={(value) => onChange({ matchOperator: value as Rule['matchOperator'] })}
          >
            <SelectTrigger id={id('operator')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_MATCH_OPERATORS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`operators.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={id('value')} label={t('matchValue')} hint={t('matchValueHint')}>
          <Input
            id={id('value')}
            value={rule.matchValue}
            onChange={(e) => onChange({ matchValue: e.target.value })}
            maxLength={200}
            className="font-mono text-xs"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={id('incident')} label={t('incident')}>
          <Select
            value={rule.incident}
            onValueChange={(value) => onChange({ incident: value as Rule['incident'] })}
          >
            <SelectTrigger id={id('incident')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_INCIDENT_MODES.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`incidentModes.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {rule.incident === 'draft' && (
          <Field id={id('severity')} label={t('severity')}>
            <Select
              value={rule.severity}
              onValueChange={(value) => onChange({ severity: value as Rule['severity'] })}
            >
              <SelectTrigger id={id('severity')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DECLARED_INCIDENT_SEVERITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`severities.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>

      <label className="flex items-start gap-2 text-sm">
        <Switch
          checked={rule.updateComponent}
          onCheckedChange={(updateComponent) => onChange({ updateComponent })}
          aria-label={t('updateComponent')}
          aria-describedby={id('component-hint')}
        />
        <span>
          {t('updateComponent')}
          <span id={id('component-hint')} className="block text-xs text-muted-foreground">
            {t('updateComponentHint')}
          </span>
        </span>
      </label>

      {(rule.updateComponent || rule.incident === 'publish') && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id={id('page')} label={t('statusPage')}>
            <Select
              value={rule.statusPage ?? NONE}
              onValueChange={(value) =>
                onChange({ statusPage: value === NONE ? null : value, component: null })
              }
            >
              <SelectTrigger id={id('page')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('choose')}</SelectItem>
                {choices.statusPages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {rule.updateComponent && (
            <>
              <Field id={id('component')} label={t('component')}>
                <Select
                  value={rule.component ?? NONE}
                  onValueChange={(value) => onChange({ component: value === NONE ? null : value })}
                  disabled={!page}
                >
                  <SelectTrigger id={id('component')} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('choose')}</SelectItem>
                    {(page?.components ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id={id('impact')} label={t('impact')}>
                <Select
                  value={rule.impact}
                  onValueChange={(value) => onChange({ impact: value as Rule['impact'] })}
                >
                  <SelectTrigger id={id('impact')} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_IMPACTS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`impacts.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}
        </div>
      )}

      <Field id={id('monitor')} label={t('monitor')} hint={t('monitorHint')}>
        <Select
          value={rule.monitor ?? NONE}
          onValueChange={(value) => onChange({ monitor: value === NONE ? null : value })}
        >
          <SelectTrigger id={id('monitor')} className="w-full sm:w-1/2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('noMonitor')}</SelectItem>
            {choices.pushMonitors.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </fieldset>
  )
}

function CopyField({ label, value, testId }: { label: string; value: string; testId: string }) {
  const t = useTranslations('settings.integrations.reveal')
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
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
          data-testid={testId}
        />
        <Button variant="outline" onClick={copy}>
          {copied ? <Check /> : <Copy />} {copied ? t('copied') : t('copy')}
        </Button>
      </div>
    </div>
  )
}

function RevealDialog({
  revealed,
  onClose,
}: {
  revealed: IntegrationSecret | null
  onClose: () => void
}) {
  const t = useTranslations('settings.integrations.reveal')
  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {revealed && (
          <div className="grid gap-4">
            <CopyField label={t('url')} value={revealed.url} testId="integration-url" />
            {revealed.email && (
              <CopyField label={t('email')} value={revealed.email} testId="integration-email" />
            )}
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface EventResult {
  dedupKey: string
  status: string
  title: string
  outcome: string
  actions: string[]
  error?: string
}

function EventsDialog({
  orgId,
  integration,
  onClose,
}: {
  orgId: string
  integration: IntegrationRow | null
  onClose: () => void
}) {
  const t = useTranslations('settings.integrations.events')
  const format = useFormatter()
  const [events, setEvents] = React.useState<IntegrationEventRow[] | null>(null)

  React.useEffect(() => {
    if (!integration) return
    let cancelled = false
    integrationsApi
      .events(orgId, integration.id)
      .then((page) => !cancelled && setEvents(page.docs))
      .catch((error: unknown) => {
        if (!cancelled) {
          setEvents([])
          toast.error(failure(error, t('loadFailed')))
        }
      })
    return () => {
      cancelled = true
    }
  }, [orgId, integration, t])

  return (
    <Dialog open={integration !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('title', { name: integration?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {events === null ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="integration-events">
            {events.map((event) => (
              <li key={event.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {format.dateTime(new Date(event.receivedAt), 'short')}
                  </span>
                  <Badge variant="outline">{t(`sources.${event.source}`)}</Badge>
                  <span className="text-muted-foreground">
                    {t('alertCount', { count: event.alertCount })}
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {(Array.isArray(event.results) ? (event.results as EventResult[]) : []).map(
                    (result, i) => (
                      <li key={`${result.dedupKey}-${i}`} className="flex flex-wrap gap-2">
                        <Badge variant={result.outcome === 'error' ? 'destructive' : 'secondary'}>
                          {t(`outcomes.${result.outcome as 'opened'}`)}
                        </Badge>
                        <span>{result.title}</span>
                        {result.actions.length > 0 && (
                          <span className="text-muted-foreground">
                            {result.actions
                              .map((action) => t(`actions.${action as 'component'}`))
                              .join(', ')}
                          </span>
                        )}
                      </li>
                    ),
                  )}
                </ul>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t('payload')}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                    {event.payload}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button onClick={onClose}>{t('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
