/** `marmot monitors …` and `marmot status`. */
import { ApiError, type CheckResult, type MarmotClient } from '../core/client'
import { applyPlan } from '../core/apply'
import { exportMonitors, toYaml } from '../core/export'
import { hasChanges, planMonitors, type PreparedPlan, type RemoteState } from '../core/plan'
import {
  monitorsDocumentJsonSchema,
  parseSpecText,
  readSpecDocument,
  type SpecDocument,
} from '../core/spec'
import { EXIT, findMonitor, idOf, intFlag, requireArg, UsageError, type Ctx } from '../context'
import { formatValue, renderPlan, statusColor, table } from '../output'
import { parseRequestTiming, TIMING_PHASES } from '@/lib/request-timing'

import { t } from '../text'

/** Monitors, channels and tags of the organization. Channels need a `write` key (member). */
export async function loadState(client: MarmotClient): Promise<RemoteState> {
  const [monitors, tags, notifications] = await Promise.all([
    client.listMonitors(),
    client.listTags(),
    client.listNotifications().catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) return null
      throw error
    }),
  ])
  return { monitors, tags, notifications }
}

/** Reads `-f <file>` (`-` for stdin) into a monitors document. */
async function readDocument(ctx: Ctx): Promise<{ document: SpecDocument; warnings: string[] }> {
  const file = ctx.str('file')
  if (!file) throw new UsageError(t('errors.flagMissing', { flag: '--file' }))
  let text: string
  try {
    text = file === '-' ? await ctx.io.readStdin() : await ctx.io.readFile(file)
  } catch (error) {
    throw new UsageError(
      t('errors.fileUnreadable', { file, reason: error instanceof Error ? error.message : '' }),
    )
  }
  return readSpecDocument(parseSpecText(text), ctx.io.env)
}

async function preparePlan(ctx: Ctx): Promise<PreparedPlan> {
  const { document, warnings } = await readDocument(ctx)
  const client = await ctx.client()
  const prepared = planMonitors(document, await loadState(client), { prune: ctx.bool('prune') })
  prepared.plan.warnings.unshift(...warnings)
  return prepared
}

/** `monitors plan -f file` and `monitors apply -f file --dry-run`. */
export async function planCommand(ctx: Ctx): Promise<number> {
  const { plan } = await preparePlan(ctx)
  if (ctx.json) ctx.printJson({ dryRun: true, ...plan })
  else ctx.print(renderPlan(plan, ctx.c, { verbose: ctx.bool('verbose') }))
  return ctx.bool('exit-code') && hasChanges(plan) ? EXIT.changes : EXIT.ok
}

/** `monitors apply -f file [--prune] [-y]`. */
export async function applyCommand(ctx: Ctx): Promise<number> {
  if (ctx.bool('dry-run')) return planCommand(ctx)
  const prepared = await preparePlan(ctx)
  const { plan } = prepared
  if (!hasChanges(plan)) {
    if (ctx.json) ctx.printJson({ dryRun: false, ...plan, applied: null })
    else ctx.print(renderPlan(plan, ctx.c))
    return EXIT.ok
  }
  if (!ctx.json) ctx.print(renderPlan(plan, ctx.c, { verbose: ctx.bool('verbose') }))
  if (!ctx.bool('yes')) {
    if (!ctx.io.interactive) throw new UsageError(t('apply.confirmNonInteractive'))
    if (!(await ctx.io.confirm(t('apply.confirm')))) {
      ctx.info(t('apply.cancelled'))
      return EXIT.ok
    }
  }
  const client = await ctx.client()
  const result = await applyPlan(client, prepared, {
    onChange: (change) => ctx.info(t('apply.progress', { action: change.action, key: change.key })),
  })
  if (ctx.json) ctx.printJson({ dryRun: false, ...plan, applied: result })
  else {
    ctx.print(
      t('apply.done', {
        created: result.created.length,
        updated: result.updated.length,
        deleted: result.deleted.length,
      }),
    )
  }
  return EXIT.ok
}

/** `monitors import` (alias `monitors export`): the organization's monitors as YAML or JSON. */
export async function exportCommand(ctx: Ctx): Promise<number> {
  const format = ctx.str('format') ?? (ctx.json ? 'json' : 'yaml')
  if (format !== 'yaml' && format !== 'json') {
    throw new UsageError(t('errors.formatInvalid', { format }))
  }
  const client = await ctx.client()
  const result = exportMonitors(await loadState(client), {
    redactSecrets: ctx.bool('redact-secrets'),
  })
  const text =
    format === 'json' ? `${JSON.stringify(result.document, null, 2)}\n` : toYaml(result.document)
  const output = ctx.str('output')
  if (output) {
    await ctx.io.writeFile(output, text)
    ctx.info(t('export.written', { file: output, count: result.document.monitors.length }))
  } else {
    ctx.io.stdout(text)
  }
  if (result.generatedKeys.length > 0) {
    ctx.info(t('export.generatedKeys', { count: result.generatedKeys.length }))
  }
  if (result.secretVariables.length > 0) {
    ctx.info(t('export.secretVariables', { names: result.secretVariables.join(', ') }))
  }
  return EXIT.ok
}

/** `monitors schema`: JSON Schema of the file format. */
export async function schemaCommand(ctx: Ctx): Promise<number> {
  const text = `${JSON.stringify(monitorsDocumentJsonSchema(), null, 2)}\n`
  const output = ctx.str('output')
  if (output) await ctx.io.writeFile(output, text)
  else ctx.io.stdout(text)
  return EXIT.ok
}

const target = (m: Record<string, unknown>): string => {
  if (typeof m.url === 'string' && m.url && m.url !== 'https://') return m.url
  if (typeof m.hostname === 'string' && m.hostname) {
    return m.port ? `${m.hostname}:${m.port}` : m.hostname
  }
  return ''
}

const lastStatus = (m: {
  active?: boolean | null
  status?: { lastStatus?: string | null } | null
}) => (m.active === false ? 'paused' : (m.status?.lastStatus ?? null))

/** `monitors list`. */
export async function listCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const active = ctx.bool('active') ? true : ctx.bool('paused') ? false : undefined
  const monitors = await client.listMonitors({ type: ctx.str('type'), active })
  if (ctx.json) {
    ctx.printJson(monitors)
    return EXIT.ok
  }
  const rows = [
    [
      t('columns.id'),
      t('columns.key'),
      t('columns.name'),
      t('columns.type'),
      t('columns.status'),
      t('columns.target'),
    ],
  ]
  for (const m of monitors) {
    rows.push([
      String(m.id),
      m.key ?? '',
      m.name,
      m.type,
      statusColor(lastStatus(m), ctx.c),
      target(m),
    ])
  }
  ctx.print(monitors.length > 0 ? table(rows, ctx.c) : t('monitors.none'))
  return EXIT.ok
}

/** `monitors info <ref>`. */
export async function infoCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const monitor = await findMonitor(client, requireArg(ctx, t('args.monitor')))
  if (ctx.json) {
    ctx.printJson(monitor)
    return EXIT.ok
  }
  const rows: [string, string][] = [
    [t('columns.id'), String(monitor.id)],
    [t('columns.key'), monitor.key ?? '—'],
    [t('columns.name'), monitor.name],
    [t('columns.type'), monitor.type],
    [t('columns.target'), target(monitor) || '—'],
    [t('columns.interval'), `${monitor.interval ?? '—'}s`],
    [t('columns.status'), statusColor(lastStatus(monitor), ctx.c)],
    [t('columns.lastCheck'), monitor.status?.lastCheckAt ?? '—'],
    [t('columns.ping'), monitor.status?.lastPing != null ? `${monitor.status.lastPing} ms` : '—'],
    [t('columns.message'), monitor.status?.lastMsg ?? '—'],
    [t('columns.parent'), idOf(monitor.parent) === null ? '—' : `#${idOf(monitor.parent)}`],
  ]
  ctx.print(rows.map(([label, value]) => `${ctx.c.bold(label.padEnd(12))} ${value}`).join('\n'))
  return EXIT.ok
}

/** `monitors logs <ref>`: latest heartbeats. */
export async function logsCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const monitor = await findMonitor(client, requireArg(ctx, t('args.monitor')))
  const beats = await client.heartbeats(monitor.id, {
    limit: intFlag(ctx, 'limit', 50),
    important: ctx.bool('important'),
  })
  if (ctx.json) {
    ctx.printJson(beats)
    return EXIT.ok
  }
  const rows = [[t('columns.time'), t('columns.status'), t('columns.ping'), t('columns.message')]]
  for (const beat of beats) {
    rows.push([
      beat.time,
      statusColor(beat.status, ctx.c),
      beat.ping != null ? `${beat.ping} ms` : '',
      beat.msg ?? '',
    ])
  }
  ctx.print(beats.length > 0 ? table(rows, ctx.c) : t('monitors.noHeartbeats'))
  return EXIT.ok
}

/** `monitors pause|resume <ref>`. */
export function setActiveCommand(active: boolean) {
  return async (ctx: Ctx): Promise<number> => {
    const client = await ctx.client()
    const monitor = await findMonitor(client, requireArg(ctx, t('args.monitor')))
    const result = await client.setMonitorActive(monitor.id, active)
    if (ctx.json) ctx.printJson(result)
    else ctx.print(t(active ? 'monitors.resumed' : 'monitors.paused', { name: monitor.name }))
    return EXIT.ok
  }
}

/** Prints an on-demand check result; exit code 4 when it is down. */
export function printCheckResult(ctx: Ctx, result: CheckResult): number {
  if (ctx.json) ctx.printJson(result)
  else {
    const lines = [
      `${statusColor(result.status, ctx.c)}  ${result.msg}`,
      [
        result.ping != null ? t('check.ping', { ms: result.ping }) : null,
        result.statusCode != null ? t('check.statusCode', { code: result.statusCode }) : null,
        t('check.elapsed', { ms: result.elapsedMs }),
      ]
        .filter(Boolean)
        .join(' · '),
    ]
    if (result.tls) {
      lines.push(
        t('check.tls', {
          valid: result.tls.valid ? t('common.yes') : t('common.no'),
          days: result.tls.daysRemaining ?? '?',
        }),
      )
    }
    const timing = ctx.bool('timing') ? parseRequestTiming(result.timing) : null
    if (timing) {
      lines.push(
        TIMING_PHASES.flatMap((phase) => {
          const ms = timing[phase]
          return ms === null ? [] : [t('check.phase', { name: t(`check.phases.${phase}`), ms })]
        }).join(' · '),
      )
    }
    if (ctx.bool('timing') && result.details) {
      for (const [name, value] of Object.entries(result.details)) {
        lines.push(`${ctx.c.dim(name)}: ${formatValue(value, 200)}`)
      }
    }
    ctx.print(lines.join('\n'))
  }
  return result.status === 'down' ? EXIT.down : EXIT.ok
}

/** Turns a 404 from the check endpoints into a readable hint (servers without #98). */
export function checkUnsupported(error: unknown): never {
  if (error instanceof ApiError && error.status === 404) {
    throw new ApiError(404, `${error.message} — ${t('check.unsupported')}`)
  }
  throw error
}

/** `monitors check <ref>`: run the monitor's check now. */
export async function checkNowCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const monitor = await findMonitor(client, requireArg(ctx, t('args.monitor')))
  const wait = !ctx.bool('no-wait')
  const result = await client.checkMonitor(monitor.id, { wait }).catch(checkUnsupported)
  if (!wait || !('status' in result)) {
    if (ctx.json) ctx.printJson(result)
    else ctx.print(t('check.queued', { name: monitor.name }))
    return EXIT.ok
  }
  return printCheckResult(ctx, result)
}

/** `status`: an overview of the organization's monitors. */
export async function statusCommand(ctx: Ctx): Promise<number> {
  const client = await ctx.client()
  const monitors = (await client.listMonitors()).filter((m) => m.type !== 'group')
  const counts: Record<string, number> = {}
  for (const m of monitors) {
    const status = lastStatus(m) ?? 'unknown'
    counts[status] = (counts[status] ?? 0) + 1
  }
  const problems = monitors.filter((m) => {
    const status = lastStatus(m)
    return status === 'down' || status === 'degraded' || status === 'pending'
  })
  const down = monitors.filter((m) => lastStatus(m) === 'down').length
  if (ctx.json) {
    ctx.printJson({
      total: monitors.length,
      counts,
      problems: problems.map((m) => ({
        id: m.id,
        key: m.key ?? null,
        name: m.name,
        status: lastStatus(m),
        message: m.status?.lastMsg ?? null,
        since: m.status?.lastCheckAt ?? null,
      })),
    })
  } else {
    const summary = Object.entries(counts)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([status, count]) => `${statusColor(status, ctx.c)} ${count}`)
      .join('  ')
    ctx.print(`${t('status.total', { count: monitors.length })}  ${summary}`)
    if (problems.length > 0) {
      const rows = [
        [t('columns.key'), t('columns.name'), t('columns.status'), t('columns.message')],
      ]
      for (const m of problems) {
        rows.push([
          m.key ?? `#${m.id}`,
          m.name,
          statusColor(lastStatus(m), ctx.c),
          m.status?.lastMsg ?? '',
        ])
      }
      ctx.print(`\n${table(rows, ctx.c)}`)
    } else if (monitors.length > 0 && monitors.every((m) => lastStatus(m) === 'up')) {
      ctx.print(ctx.c.green(t('status.allGood')))
    }
  }
  return ctx.bool('fail-on-down') && down > 0 ? EXIT.down : EXIT.ok
}
