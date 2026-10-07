'use client'

import { ChevronDown, ChevronRight, Download, ScrollText } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  auditLogApi,
  type AuditEventRecord,
  type AuditFilters,
  type AuditPage,
} from '@/lib/audit-log-api'
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  splitAction,
  type AuditEntityType,
} from '@/server/audit/actions'

export interface AuditActorOption {
  id: string
  label: string
}

interface AuditLogViewProps {
  orgId: string
  initial: AuditPage
  /** Members for the actor filter. */
  actors?: AuditActorOption[]
  /** Fixed resource (a monitor's Activity tab): hides the resource filter and the export. */
  entity?: { type: AuditEntityType; id: string }
  /** Superadmins can switch to instance-level rows. */
  superadmin?: boolean
  timeZone: string
}

const ANY = '__any'

/** `{ actor: 'type:system' | 'user:<id>' }` → API filters. */
function actorFilter(value: string): Pick<AuditFilters, 'actorType' | 'actorId'> {
  if (value.startsWith('type:')) {
    return { actorType: value.slice(5) as AuditFilters['actorType'] }
  }
  if (value.startsWith('user:')) return { actorType: 'user', actorId: value.slice(5) }
  return {}
}

function useActionLabel() {
  const tEntity = useTranslations('settings.auditLog.entities')
  const tVerb = useTranslations('settings.auditLog.verbs')
  const tAuth = useTranslations('settings.auditLog.authActions')
  type EntityKey = Parameters<typeof tEntity>[0]
  type VerbKey = Parameters<typeof tVerb>[0]
  type AuthKey = Parameters<typeof tAuth>[0]
  return (action: string): string => {
    const { entity, verb } = splitAction(action)
    if (entity === 'auth') {
      return tAuth.has(verb as AuthKey) ? tAuth(verb as AuthKey) : action
    }
    const entityLabel = tEntity.has(entity as EntityKey) ? tEntity(entity as EntityKey) : entity
    const verbLabel = tVerb.has(verb as VerbKey) ? tVerb(verb as VerbKey) : verb
    return `${entityLabel} ${verbLabel}`
  }
}

function formatValue(value: unknown, empty: string): string {
  if (value === null || value === undefined || value === '') return empty
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Field-by-field view of one event: changed paths for updates, the snapshot for create/delete. */
function EventDetail({ event }: { event: AuditEventRecord }) {
  const t = useTranslations('settings.auditLog.detail')
  const empty = t('empty')
  const rows: { field: string; before?: unknown; after?: unknown }[] = []
  let mode: 'diff' | 'after' | 'before' = 'diff'
  if (event.changedFields.length > 0) {
    for (const field of event.changedFields) {
      rows.push({ field, before: event.before?.[field], after: event.after?.[field] })
    }
  } else if (event.after && Object.keys(event.after).length > 0) {
    mode = 'after'
    for (const [field, value] of Object.entries(event.after)) rows.push({ field, after: value })
  } else if (event.before && Object.keys(event.before).length > 0) {
    mode = 'before'
    for (const [field, value] of Object.entries(event.before)) rows.push({ field, before: value })
  }

  return (
    <div className="flex flex-col gap-3 py-2 text-xs" data-testid="audit-event-detail">
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t('noChanges')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-medium">{t('field')}</th>
                {mode !== 'after' && (
                  <th className="px-3 py-1.5 font-medium">
                    {mode === 'before' ? t('deleted') : t('before')}
                  </th>
                )}
                {mode !== 'before' && (
                  <th className="px-3 py-1.5 font-medium">
                    {mode === 'after' ? t('created') : t('after')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.field} className="border-t align-top">
                  <td className="px-3 py-1.5 font-mono">{row.field}</td>
                  {mode !== 'after' && (
                    <td className="px-3 py-1.5 font-mono break-all text-red-700 dark:text-red-400">
                      {formatValue(row.before, empty)}
                    </td>
                  )}
                  {mode !== 'before' && (
                    <td className="px-3 py-1.5 font-mono break-all text-emerald-700 dark:text-emerald-400">
                      {formatValue(row.after, empty)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-muted-foreground">
        {event.entityId && (
          <>
            <dt>{t('entityId')}</dt>
            <dd className="font-mono">{event.entityId}</dd>
          </>
        )}
        <dt>{t('ip')}</dt>
        <dd className="font-mono">{event.ip ?? empty}</dd>
        <dt>{t('userAgent')}</dt>
        <dd className="break-all">{event.userAgent ?? empty}</dd>
        {event.metadata && Object.keys(event.metadata).length > 0 && (
          <>
            <dt>{t('metadata')}</dt>
            <dd className="font-mono break-all">{JSON.stringify(event.metadata)}</dd>
          </>
        )}
      </dl>
    </div>
  )
}

/**
 * Audit log table with filters (actor, action, resource, date range), an expandable diff per
 * event, paging and CSV export. Used by Settings → Audit log and a monitor's Activity tab.
 */
export function AuditLogView({
  orgId,
  initial,
  actors = [],
  entity,
  superadmin = false,
  timeZone,
}: AuditLogViewProps) {
  const t = useTranslations('settings.auditLog')
  const format = useFormatter()
  const actionLabel = useActionLabel()

  const [actor, setActor] = React.useState(ANY)
  const [entityType, setEntityType] = React.useState<string>(ANY)
  const [action, setAction] = React.useState(ANY)
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [scope, setScope] = React.useState<'organization' | 'instance'>('organization')
  const [data, setData] = React.useState<AuditPage>(initial)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())

  const filters = React.useMemo<AuditFilters>(() => {
    const out: AuditFilters = { ...(actor === ANY ? {} : actorFilter(actor)) }
    if (entity) {
      out.entityType = entity.type
      out.entityId = entity.id
    } else if (entityType !== ANY) {
      out.entityType = entityType as AuditEntityType
    }
    if (action !== ANY) out.action = action
    if (from) out.from = from
    if (to) out.to = to
    if (scope === 'instance') out.scope = 'instance'
    return out
  }, [actor, entity, entityType, action, from, to, scope])

  const firstRender = React.useRef(true)
  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    let cancelled = false
    setLoading(true)
    setError(false)
    auditLogApi
      .list(orgId, filters)
      .then((page) => {
        if (!cancelled) setData(page)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [orgId, filters])

  const loadMore = async () => {
    setLoading(true)
    setError(false)
    try {
      const next = await auditLogApi.list(orgId, filters, data.page + 1)
      setData({ ...next, docs: [...data.docs, ...next.docs] })
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const actionOptions = React.useMemo(() => {
    const prefix = entity ? `${entity.type}.` : entityType !== ANY ? `${entityType}.` : null
    return prefix ? AUDIT_ACTIONS.filter((value) => value.startsWith(prefix)) : AUDIT_ACTIONS
  }, [entity, entityType])

  const filtered =
    actor !== ANY || action !== ANY || from !== '' || to !== '' || (!entity && entityType !== ANY)
  const clear = () => {
    setActor(ANY)
    setEntityType(ANY)
    setAction(ANY)
    setFrom('')
    setTo('')
  }

  const actorName = (event: AuditEventRecord) =>
    event.actorLabel ??
    (event.actorType === 'system' ? t('actorTypes.system') : (event.actorId ?? t('unknownActor')))

  return (
    <div className="flex flex-col gap-4" data-testid="audit-log">
      <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">{t('filters.label')}</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-actor">{t('filters.actor')}</Label>
          <Select value={actor} onValueChange={setActor}>
            <SelectTrigger id="audit-actor" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('filters.anyActor')}</SelectItem>
              <SelectItem value="type:user">{t('filters.allMembers')}</SelectItem>
              <SelectItem value="type:apiKey">{t('actorTypes.apiKey')}</SelectItem>
              <SelectItem value="type:mcp">{t('actorTypes.mcp')}</SelectItem>
              <SelectItem value="type:system">{t('actorTypes.system')}</SelectItem>
              {actors.map((option) => (
                <SelectItem key={option.id} value={`user:${option.id}`}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!entity && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-entity">{t('filters.entityType')}</Label>
            <Select
              value={entityType}
              onValueChange={(value) => {
                setEntityType(value)
                setAction(ANY)
              }}
            >
              <SelectTrigger id="audit-entity" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('filters.anyEntity')}</SelectItem>
                {AUDIT_ENTITY_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`entities.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-action">{t('filters.action')}</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger id="audit-action" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('filters.anyAction')}</SelectItem>
              {actionOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {actionLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-from">{t('filters.from')}</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-to">{t('filters.to')}</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {superadmin && !entity && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-scope">{t('filters.scope')}</Label>
            <Select
              value={scope}
              onValueChange={(value) => setScope(value as 'organization' | 'instance')}
            >
              <SelectTrigger id="audit-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">{t('filters.scopeOrganization')}</SelectItem>
                <SelectItem value="instance">{t('filters.scopeInstance')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {loading ? t('loading') : t('total', { count: data.totalDocs })}
        </p>
        <div className="flex gap-2">
          {filtered && (
            <Button variant="ghost" size="sm" onClick={clear}>
              {t('clearFilters')}
            </Button>
          )}
          {!entity && (
            <Button variant="outline" size="sm" asChild>
              <a href={auditLogApi.exportUrl(orgId, filters)} download>
                <Download className="size-4" aria-hidden /> {t('exportCsv')}
              </a>
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('loadFailed')}
        </p>
      )}

      {data.docs.length === 0 ? (
        <EmptyState icon={ScrollText} title={entity ? t('emptyActivity') : t('empty')} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>{t('columns.time')}</TableHead>
                <TableHead>{t('columns.actor')}</TableHead>
                <TableHead>{t('columns.action')}</TableHead>
                {!entity && <TableHead>{t('columns.entity')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.docs.map((event) => {
                const open = expanded.has(event.id)
                return (
                  <React.Fragment key={event.id}>
                    <TableRow data-testid="audit-event" data-action={event.action}>
                      <TableCell className="py-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-expanded={open}
                          aria-label={open ? t('hideDetails') : t('showDetails')}
                          onClick={() => toggle(event.id)}
                        >
                          {open ? (
                            <ChevronDown className="size-4" aria-hidden />
                          ) : (
                            <ChevronRight className="size-4" aria-hidden />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {format.dateTime(new Date(event.createdAt), {
                          dateStyle: 'medium',
                          timeStyle: 'medium',
                          timeZone,
                        })}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="max-w-56 truncate">{actorName(event)}</span>
                          {event.actorType !== 'user' && (
                            <Badge variant="secondary">{t(`actorTypes.${event.actorType}`)}</Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>{actionLabel(event.action)}</TableCell>
                      {!entity && (
                        <TableCell className="max-w-64 truncate">
                          {event.entityLabel ?? event.entityId ?? ''}
                        </TableCell>
                      )}
                    </TableRow>
                    {open && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell />
                        <TableCell colSpan={entity ? 3 : 4} className="whitespace-normal">
                          <EventDetail event={event} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {data.hasNextPage && (
        <Button variant="outline" className="self-center" disabled={loading} onClick={loadMore}>
          {t('loadMore')}
        </Button>
      )}
    </div>
  )
}
