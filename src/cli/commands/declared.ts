/**
 * `declared-incidents list|info|declare|update|note` (#285): the team's declared incidents through
 * `/api/orgs/:orgId/declared-incidents/**`.
 */
import {
  DECLARED_INCIDENT_SEVERITIES,
  DECLARED_INCIDENT_STATUSES,
  DECLARED_STATUS_FILTERS,
  UNASSIGNED_COMMANDER,
} from '@/lib/declared-incidents'

import type { DeclaredIncidentDoc } from '../core/client'
import { EXIT, intFlag, requireArg, requireFlag, UsageError, type Ctx } from '../context'
import { table } from '../output'
import { t } from '../text'

function oneOf(ctx: Ctx, flag: string, values: readonly string[]): string | undefined {
  const value = ctx.str(flag)
  if (value !== undefined && !values.includes(value)) {
    throw new UsageError(t('errors.oneOf', { flag: `--${flag}`, values: values.join(', ') }))
  }
  return value
}

/** `--start` as an ISO instant; a value without a zone is local time. */
function startFlag(ctx: Ctx): string | undefined {
  const value = ctx.str('start')
  if (value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new UsageError(t('errors.dateTime', { flag: '--start' }))
  return date.toISOString()
}

function severityText(ctx: Ctx, severity: string): string {
  if (severity === 'critical') return ctx.c.red(severity)
  if (severity === 'major') return ctx.c.yellow(severity)
  return ctx.c.dim(severity)
}

function statusText(ctx: Ctx, status: string): string {
  if (status === 'open') return ctx.c.red(status)
  if (status === 'mitigated') return ctx.c.yellow(status)
  if (status === 'resolved') return ctx.c.green(status)
  return ctx.c.dim(status)
}

export async function declaredListCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const result = await client.listDeclaredIncidents({
    status: oneOf(ctx, 'status', DECLARED_STATUS_FILTERS) ?? 'active',
    severity: oneOf(ctx, 'severity', DECLARED_INCIDENT_SEVERITIES),
    commander: ctx.str('commander'),
    limit: Math.min(intFlag(ctx, 'limit', 25), 100),
  })
  if (ctx.json) {
    ctx.printJson(result)
    return EXIT.ok
  }
  const rows = [
    [
      t('columns.id'),
      t('columns.title'),
      t('columns.severity'),
      t('columns.status'),
      t('columns.commander'),
      t('columns.started'),
    ],
  ]
  for (const incident of result.docs) {
    rows.push([
      incident.id,
      incident.title,
      severityText(ctx, incident.severity),
      statusText(ctx, incident.status),
      incident.commander?.name ?? ctx.c.dim(t('declared.unassigned')),
      incident.startedAt,
    ])
  }
  ctx.print(result.docs.length > 0 ? table(rows, ctx.c) : t('declared.none'))
  if (result.totalDocs > result.docs.length) {
    ctx.info(t('declared.more', { shown: result.docs.length, total: result.totalDocs }))
  }
  return EXIT.ok
}

function printIncident(ctx: Ctx, incident: DeclaredIncidentDoc): void {
  const label = (key: Parameters<typeof t>[0]) => ctx.c.bold(t(key).padEnd(12))
  const lines = [
    `${label('columns.id')} ${incident.id}`,
    `${label('columns.title')} ${incident.title}`,
    `${label('columns.severity')} ${severityText(ctx, incident.severity)}`,
    `${label('columns.status')} ${statusText(ctx, incident.status)}`,
    `${label('columns.commander')} ${incident.commander?.name ?? t('declared.unassigned')}`,
    `${label('columns.started')} ${incident.startedAt}`,
  ]
  if (incident.summary) lines.push('', ctx.c.bold(t('declared.summary')), incident.summary)
  lines.push('', `${ctx.c.bold(t('declared.postmortem'))} ${incident.postmortem.status}`)
  const items = incident.postmortem.actionItems ?? []
  if (items.length > 0) {
    lines.push('', ctx.c.bold(t('declared.actionItems')))
    for (const item of items) {
      const extra = [item.owner?.name, item.dueDate, item.ticketUrl].filter(Boolean).join(', ')
      lines.push(
        `  [${item.done ? 'x' : ' '}] ${item.title}${extra ? ctx.c.dim(` (${extra})`) : ''}`,
      )
    }
  }
  if (incident.timeline.length > 0) {
    lines.push('', ctx.c.bold(t('declared.timeline')))
    for (const entry of incident.timeline) {
      const by = entry.by?.name ? ` ${ctx.c.dim(entry.by.name)}` : ''
      const message = entry.type === 'note' && entry.message ? `: ${entry.message}` : ''
      lines.push(`  ${ctx.c.dim(entry.at)} ${entry.type}${by}${message}`)
    }
  }
  ctx.print(lines.join('\n'))
}

export async function declaredInfoCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const incident = await client.getDeclaredIncident(requireArg(ctx, t('args.declaredIncident')))
  if (ctx.json) ctx.printJson(incident)
  else printIncident(ctx, incident)
  return EXIT.ok
}

export async function declaredDeclareCommand(ctx: Ctx): Promise<number> {
  const body: Record<string, unknown> = { title: requireFlag(ctx, 'title') }
  const severity = oneOf(ctx, 'severity', DECLARED_INCIDENT_SEVERITIES)
  if (severity) body.severity = severity
  const summary = ctx.str('summary')
  if (summary) body.summary = summary
  const commander = ctx.str('commander')
  if (commander) body.commander = commander
  const startedAt = startFlag(ctx)
  if (startedAt) body.startedAt = startedAt
  const monitorIncident = ctx.str('monitor-incident')
  if (monitorIncident) body.monitorIncident = monitorIncident
  const client = await ctx.client()
  const incident = await client.declareIncident(body)
  if (ctx.json) ctx.printJson(incident)
  else ctx.print(t('declared.declared', { id: incident.id, title: incident.title }))
  return EXIT.ok
}

export async function declaredUpdateCommand(ctx: Ctx): Promise<number> {
  const id = requireArg(ctx, t('args.declaredIncident'))
  const body: Record<string, unknown> = {}
  const status = oneOf(ctx, 'status', DECLARED_INCIDENT_STATUSES)
  if (status) body.status = status
  const severity = oneOf(ctx, 'severity', DECLARED_INCIDENT_SEVERITIES)
  if (severity) body.severity = severity
  const commander = ctx.str('commander')
  if (commander) body.commander = commander === UNASSIGNED_COMMANDER ? null : commander
  const title = ctx.str('title')
  if (title) body.title = title
  const summary = ctx.str('summary')
  if (summary !== undefined) body.summary = summary || null
  const startedAt = startFlag(ctx)
  if (startedAt) body.startedAt = startedAt
  if (Object.keys(body).length === 0) throw new UsageError(t('declared.nothingToUpdate'))
  const client = await ctx.client()
  const incident = await client.updateDeclaredIncident(id, body)
  if (ctx.json) ctx.printJson(incident)
  else ctx.print(t('declared.updated', { id: incident.id }))
  return EXIT.ok
}

export async function declaredNoteCommand(ctx: Ctx): Promise<number> {
  const id = requireArg(ctx, t('args.declaredIncident'))
  const message = requireFlag(ctx, 'message')
  const client = await ctx.client()
  const incident = await client.addDeclaredIncidentNote(id, message)
  if (ctx.json) ctx.printJson(incident)
  else ctx.print(t('declared.noted', { id: incident.id }))
  return EXIT.ok
}
