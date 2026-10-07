/** `login`, `logout`, `config`, `check <url>`, `status-pages`, `incidents`, `maintenance`, `import`. */
import { isValidDateTime } from '@/lib/validation/maintenance'
import {
  defaultMonitorValues,
  isHostMonitorType,
  isUrlMonitorType,
  MONITOR_TYPE_NAMES,
  type MonitorTypeName,
} from '@/lib/validation/monitor'

import { MarmotClient, type Id } from '../core/client'
import { parseSpecText } from '../core/spec'
import {
  configPath,
  DEFAULT_PROFILE,
  maskKey,
  readConfigFile,
  resolveConnection,
  writeConfigFile,
} from '../config'
import {
  CLI_VERSION,
  EXIT,
  findMonitor,
  findStatusPage,
  requireArg,
  requireFlag,
  UsageError,
  type Ctx,
} from '../context'
import { statusColor, table } from '../output'
import { t } from '../text'
import { checkUnsupported, printCheckResult } from './monitors'

// ---- login / logout / config ---------------------------------------------------------------------

/** `login`: checks the key against the instance and saves the profile. */
export async function loginCommand(ctx: Ctx): Promise<number> {
  const file = configPath(ctx.io.env)
  const config = await readConfigFile(file)
  const apiKeyFromStdin = ctx.bool('api-key-stdin') ? (await ctx.io.readStdin()).trim() : undefined
  const connection = resolveConnection(
    {
      url: ctx.str('url'),
      apiKey: apiKeyFromStdin ?? ctx.str('api-key'),
      org: ctx.str('org'),
      profile: ctx.str('profile'),
    },
    ctx.io.env,
    config,
  )
  const missing = (['url', 'apiKey', 'org'] as const).filter((k) => !connection[k])
  if (missing.length > 0) {
    throw new UsageError(t('errors.notConfigured', { missing: missing.join(', ') }))
  }
  const client = new MarmotClient({
    url: connection.url as string,
    apiKey: connection.apiKey as string,
    org: connection.org as string,
    fetch: ctx.io.fetch,
    userAgent: `marmot-cli/${CLI_VERSION}`,
  })
  await client.request('GET', '/monitors', { query: { limit: 1 } })

  config.profiles[connection.profile] = {
    url: client.baseUrl,
    apiKey: connection.apiKey as string,
    org: connection.org as string,
  }
  config.currentProfile = connection.profile
  await writeConfigFile(file, config)
  if (ctx.json)
    ctx.printJson({ profile: connection.profile, url: client.baseUrl, org: client.org, file })
  else
    ctx.print(
      t('login.done', { url: client.baseUrl, org: client.org, profile: connection.profile, file }),
    )
  return EXIT.ok
}

/** `logout`: removes the saved profile. */
export async function logoutCommand(ctx: Ctx): Promise<number> {
  const file = configPath(ctx.io.env)
  const config = await readConfigFile(file)
  const profile =
    ctx.str('profile') || ctx.io.env.MARMOT_PROFILE || config.currentProfile || DEFAULT_PROFILE
  const existed = profile in config.profiles
  delete config.profiles[profile]
  if (config.currentProfile === profile) delete config.currentProfile
  if (existed) await writeConfigFile(file, config)
  if (ctx.json) ctx.printJson({ profile, removed: existed })
  else ctx.print(t(existed ? 'logout.done' : 'logout.none', { profile }))
  return EXIT.ok
}

/** `config`: the connection the CLI would use, and where it comes from. */
export async function configCommand(ctx: Ctx): Promise<number> {
  const file = configPath(ctx.io.env)
  const config = await readConfigFile(file)
  const connection = resolveConnection(
    {
      url: ctx.str('url'),
      apiKey: ctx.str('api-key'),
      org: ctx.str('org'),
      profile: ctx.str('profile'),
    },
    ctx.io.env,
    config,
  )
  const shown = {
    ...connection,
    apiKey: maskKey(connection.apiKey),
    file,
    profiles: Object.keys(config.profiles),
  }
  if (ctx.json) ctx.printJson(shown)
  else {
    ctx.print(
      [
        [t('columns.profile'), shown.profile],
        [t('columns.url'), shown.url ?? '—'],
        [t('columns.org'), shown.org ?? '—'],
        [t('columns.apiKey'), shown.apiKey ?? '—'],
        [t('columns.file'), file],
      ]
        .map(([label, value]) => `${ctx.c.bold(label.padEnd(10))} ${value}`)
        .join('\n'),
    )
  }
  return EXIT.ok
}

// ---- check <url> -----------------------------------------------------------------------------------

/** `check <target>`: an ad-hoc check of an unsaved configuration (#98). */
export async function adhocCheckCommand(ctx: Ctx): Promise<number> {
  const target = requireArg(ctx, t('args.target'))
  const type = (ctx.str('type') ??
    (/^[a-z]+:\/\//i.test(target) ? 'http' : 'ping')) as MonitorTypeName
  if (!MONITOR_TYPE_NAMES.includes(type)) throw new UsageError(t('errors.typeInvalid', { type }))
  const body: Record<string, unknown> = { ...defaultMonitorValues(type), name: target }
  if (isUrlMonitorType(type)) body.url = target
  else if (isHostMonitorType(type)) {
    const match = /^(.+?)(?::(\d+))?$/.exec(target.replace(/^[a-z]+:\/\//i, ''))
    body.hostname = match?.[1] ?? target
    if (match?.[2]) body.port = Number(match[2])
  } else {
    throw new UsageError(t('errors.typeNotAdhoc', { type }))
  }
  const keyword = ctx.str('keyword')
  if (keyword) {
    body.keyword = keyword
    if (type === 'http') body.type = 'keyword'
  }
  const method = ctx.str('method')
  if (method) body.method = method.toUpperCase()
  const timeout = ctx.str('timeout')
  if (timeout) {
    const seconds = Number(timeout)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new UsageError(t('errors.flagInteger', { flag: '--timeout' }))
    }
    body.timeout = seconds
  }
  const client = await ctx.client()
  const result = await client.adhocCheck(body).catch(checkUnsupported)
  return printCheckResult(ctx, result)
}

// ---- status pages ------------------------------------------------------------------------------------

export async function statusPagesListCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const pages = await client.listStatusPages()
  if (ctx.json) ctx.printJson(pages)
  else {
    const rows = [[t('columns.id'), t('columns.slug'), t('columns.title'), t('columns.published')]]
    for (const page of pages) {
      rows.push([
        String(page.id),
        page.slug,
        page.title,
        page.published ? t('common.yes') : t('common.no'),
      ])
    }
    ctx.print(pages.length > 0 ? table(rows, ctx.c) : t('statusPages.none'))
  }
  return EXIT.ok
}

export async function statusPagesInfoCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const page = await client.getStatusPage(
    (await findStatusPage(client, requireArg(ctx, t('args.statusPage')))).id,
  )
  if (ctx.json) {
    ctx.printJson(page)
    return EXIT.ok
  }
  const groups = Array.isArray(page.groups)
    ? (page.groups as { name?: string; monitors?: unknown[] }[])
    : []
  const lines = [
    `${ctx.c.bold(t('columns.title').padEnd(12))} ${page.title}`,
    `${ctx.c.bold(t('columns.slug').padEnd(12))} ${page.slug}`,
    `${ctx.c.bold(t('columns.published').padEnd(12))} ${page.published ? t('common.yes') : t('common.no')}`,
    ...groups.map(
      (group) =>
        `${ctx.c.bold(t('columns.group').padEnd(12))} ${group.name ?? ''} (${t('statusPages.components', { count: group.monitors?.length ?? 0 })})`,
    ),
  ]
  ctx.print(lines.join('\n'))
  return EXIT.ok
}

// ---- incidents -----------------------------------------------------------------------------------------

const INCIDENT_STATUS_VALUES = ['investigating', 'identified', 'monitoring', 'resolved']

function incidentStatus(ctx: Ctx, fallback?: string): string | undefined {
  const status = ctx.str('status') ?? fallback
  if (status !== undefined && !INCIDENT_STATUS_VALUES.includes(status)) {
    throw new UsageError(
      t('errors.oneOf', { flag: '--status', values: INCIDENT_STATUS_VALUES.join(', ') }),
    )
  }
  return status
}

async function pageOf(ctx: Ctx, client: MarmotClient): Promise<Id> {
  return (await findStatusPage(client, requireFlag(ctx, 'page'))).id
}

export async function incidentsListCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const incidents = (await client.listIncidents(await pageOf(ctx, client))).filter(
    (incident) => ctx.bool('all') || incident.active !== false,
  )
  if (ctx.json) ctx.printJson(incidents)
  else {
    const rows = [[t('columns.id'), t('columns.title'), t('columns.status'), t('columns.created')]]
    for (const incident of incidents) {
      const latest = incident.updates?.[incident.updates.length - 1]?.status
      const status = incident.active === false ? 'resolved' : (latest ?? 'investigating')
      rows.push([
        String(incident.id),
        incident.title,
        statusColor(status, ctx.c),
        incident.createdAt ?? '',
      ])
    }
    ctx.print(incidents.length > 0 ? table(rows, ctx.c) : t('incidents.none'))
  }
  return EXIT.ok
}

export async function incidentsCreateCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const pageId = await pageOf(ctx, client)
  const body: Record<string, unknown> = {
    title: requireFlag(ctx, 'title'),
    status: incidentStatus(ctx, 'investigating'),
  }
  const message = ctx.str('message')
  if (message) body.message = message
  const impact = ctx.str('impact')
  if (impact) body.impact = impact
  if (ctx.bool('pinned')) body.pinned = true
  const incident = await client.createIncident(pageId, body)
  if (ctx.json) ctx.printJson(incident)
  else ctx.print(t('incidents.created', { id: String(incident.id), title: incident.title }))
  return EXIT.ok
}

export async function incidentsUpdateCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const pageId = await pageOf(ctx, client)
  const incidentId = requireArg(ctx, t('args.incident'))
  const results: unknown[] = []
  const patch: Record<string, unknown> = {}
  const title = ctx.str('title')
  if (title) patch.title = title
  if (ctx.bool('pinned')) patch.pinned = true
  const impact = ctx.str('impact')
  if (impact) patch.impact = impact
  if (Object.keys(patch).length > 0)
    results.push(await client.updateIncident(pageId, incidentId, patch))

  const status = ctx.bool('resolve') ? 'resolved' : incidentStatus(ctx)
  const message = ctx.str('message')
  if (status || message) {
    if (!status) throw new UsageError(t('errors.flagMissing', { flag: '--status' }))
    results.push(
      await client.postIncidentUpdate(pageId, incidentId, {
        status,
        ...(message ? { message } : {}),
      }),
    )
  }
  if (results.length === 0) throw new UsageError(t('incidents.nothingToUpdate'))
  if (ctx.json) ctx.printJson(results[results.length - 1])
  else ctx.print(t('incidents.updated', { id: incidentId }))
  return EXIT.ok
}

// ---- maintenance -------------------------------------------------------------------------------------

export async function maintenanceListCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const items = await client.listMaintenance()
  if (ctx.json) ctx.printJson(items)
  else {
    const rows = [[t('columns.id'), t('columns.title'), t('columns.status'), t('columns.strategy')]]
    for (const item of items) {
      rows.push([String(item.id), item.title, item.status ?? '', item.strategy ?? ''])
    }
    ctx.print(items.length > 0 ? table(rows, ctx.c) : t('maintenance.none'))
  }
  return EXIT.ok
}

/**
 * `maintenance create`: a single window from flags (`--title --start --end [--monitor …]`), or any
 * maintenance body from `-f file` (YAML or JSON, the API's `MaintenanceFormValues`).
 */
export async function maintenanceCreateCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  let body: Record<string, unknown>
  const file = ctx.str('file')
  if (file) {
    const parsed = parseSpecText(
      file === '-' ? await ctx.io.readStdin() : await ctx.io.readFile(file),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UsageError(t('errors.bodyObject'))
    }
    body = parsed as Record<string, unknown>
  } else {
    const start = requireFlag(ctx, 'start')
    const end = requireFlag(ctx, 'end')
    for (const [flag, value] of [
      ['--start', start],
      ['--end', end],
    ]) {
      if (!isValidDateTime(value)) throw new UsageError(t('errors.dateTime', { flag }))
    }
    body = {
      title: requireFlag(ctx, 'title'),
      strategy: 'single',
      dateRange: { start, end },
    }
    const description = ctx.str('description')
    if (description) body.description = description
    const timezone = ctx.str('timezone')
    if (timezone) body.timezone = timezone
  }
  const monitorRefs = (ctx.values.monitor as string[] | undefined) ?? []
  if (monitorRefs.length > 0) {
    body.monitors = await Promise.all(
      monitorRefs.map(async (ref) => (await findMonitor(client, ref)).id),
    )
  }
  const item = await client.createMaintenance(body)
  if (ctx.json) ctx.printJson(item)
  else ctx.print(t('maintenance.created', { id: String(item.id), title: item.title }))
  return EXIT.ok
}

// ---- import --------------------------------------------------------------------------------------------

interface ImportSection {
  create: number
  skipped: { name: string; reason: string }[]
}

/** `import -f file`: imports a Marmot export or an Uptime Kuma backup through the server's importer. */
export async function importCommand(ctx: Ctx): Promise<number> {
  const file = requireFlag(ctx, 'file')
  const text = file === '-' ? await ctx.io.readStdin() : await ctx.io.readFile(file)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new UsageError(t('errors.notJson', { file }))
  }
  const client = await ctx.client()
  const dryRun = ctx.bool('dry-run')
  const report = await client.importFile(json, dryRun)
  if (ctx.json) {
    ctx.printJson(report)
    return EXIT.ok
  }
  const sections = ['monitors', 'notifications', 'statusPages', 'templates'] as const
  for (const section of sections) {
    const part = report[section] as ImportSection | undefined
    if (!part) continue
    ctx.print(
      t('import.section', {
        section,
        create: part.create,
        skipped: part.skipped.length,
        dryRun: String(dryRun),
      }),
    )
    for (const skipped of part.skipped)
      ctx.print(ctx.c.dim(`    ${skipped.name}: ${skipped.reason}`))
  }
  for (const warning of (report.warnings as string[] | undefined) ?? []) ctx.warn(warning)
  return EXIT.ok
}
