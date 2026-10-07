/**
 * The `marmot` command line (#116): parses the arguments, runs one command and returns its exit
 * code. All I/O goes through `CliIo` so tests run commands in-process against the route handlers.
 */
import { parseArgs } from 'node:util'

import { ApiError } from './core/client'
import { ApplyError } from './core/apply'
import { SpecError } from './core/spec'
import {
  applyCommand,
  checkNowCommand,
  exportCommand,
  infoCommand,
  listCommand,
  logsCommand,
  planCommand,
  schemaCommand,
  setActiveCommand,
  statusCommand,
} from './commands/monitors'
import {
  adhocCheckCommand,
  configCommand,
  importCommand,
  incidentsCreateCommand,
  incidentsListCommand,
  incidentsUpdateCommand,
  loginCommand,
  logoutCommand,
  maintenanceCreateCommand,
  maintenanceListCommand,
  statusPagesInfoCommand,
  statusPagesListCommand,
} from './commands/other'
import { CLI_VERSION, createContext, EXIT, UsageError, type CliIo, type Ctx } from './context'
import { colors } from './output'
import { t } from './text'

type OptionSpec = { type: 'string' | 'boolean'; short?: string; multiple?: boolean }

/** Flags every command accepts. */
const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  'no-color': { type: 'boolean' },
  url: { type: 'string' },
  'api-key': { type: 'string' },
  org: { type: 'string' },
  profile: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
}

/** Command-specific flags; a flag means the same thing wherever it is accepted. */
const OPTIONS: Record<string, OptionSpec> = {
  file: { type: 'string', short: 'f' },
  output: { type: 'string', short: 'o' },
  'dry-run': { type: 'boolean' },
  prune: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'exit-code': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  format: { type: 'string' },
  'redact-secrets': { type: 'boolean' },
  type: { type: 'string' },
  active: { type: 'boolean' },
  paused: { type: 'boolean' },
  limit: { type: 'string' },
  important: { type: 'boolean' },
  'no-wait': { type: 'boolean' },
  'fail-on-down': { type: 'boolean' },
  keyword: { type: 'string' },
  method: { type: 'string' },
  timeout: { type: 'string' },
  timing: { type: 'boolean' },
  page: { type: 'string' },
  title: { type: 'string' },
  message: { type: 'string' },
  status: { type: 'string' },
  impact: { type: 'string' },
  pinned: { type: 'boolean' },
  resolve: { type: 'boolean' },
  all: { type: 'boolean' },
  start: { type: 'string' },
  end: { type: 'string' },
  description: { type: 'string' },
  timezone: { type: 'string' },
  monitor: { type: 'string', multiple: true },
  'api-key-stdin': { type: 'boolean' },
  version: { type: 'boolean', short: 'V' },
}

interface Command {
  words: string[]
  /** Accepted command-specific flags. */
  flags: string[]
  /** Usage line (`cli.usage.*`). */
  usage: Parameters<typeof t>[0]
  run(ctx: Ctx): Promise<number>
}

const PLAN_FLAGS = ['file', 'prune', 'exit-code', 'verbose']
const EXPORT_FLAGS = ['output', 'format', 'redact-secrets']

export const COMMANDS: Command[] = [
  { words: ['login'], flags: ['api-key-stdin'], usage: 'usage.login', run: loginCommand },
  { words: ['logout'], flags: [], usage: 'usage.logout', run: logoutCommand },
  { words: ['config'], flags: [], usage: 'usage.config', run: configCommand },
  { words: ['status'], flags: ['fail-on-down'], usage: 'usage.status', run: statusCommand },
  {
    words: ['check'],
    flags: ['type', 'keyword', 'method', 'timeout', 'timing'],
    usage: 'usage.check',
    run: adhocCheckCommand,
  },
  {
    words: ['monitors', 'list'],
    flags: ['type', 'active', 'paused'],
    usage: 'usage.monitorsList',
    run: listCommand,
  },
  { words: ['monitors', 'info'], flags: [], usage: 'usage.monitorsInfo', run: infoCommand },
  {
    words: ['monitors', 'logs'],
    flags: ['limit', 'important'],
    usage: 'usage.monitorsLogs',
    run: logsCommand,
  },
  {
    words: ['monitors', 'check'],
    flags: ['no-wait', 'timing'],
    usage: 'usage.monitorsCheck',
    run: checkNowCommand,
  },
  {
    words: ['monitors', 'pause'],
    flags: [],
    usage: 'usage.monitorsPause',
    run: setActiveCommand(false),
  },
  {
    words: ['monitors', 'resume'],
    flags: [],
    usage: 'usage.monitorsResume',
    run: setActiveCommand(true),
  },
  {
    words: ['monitors', 'import'],
    flags: EXPORT_FLAGS,
    usage: 'usage.monitorsImport',
    run: exportCommand,
  },
  {
    words: ['monitors', 'export'],
    flags: EXPORT_FLAGS,
    usage: 'usage.monitorsImport',
    run: exportCommand,
  },
  { words: ['monitors', 'plan'], flags: PLAN_FLAGS, usage: 'usage.monitorsPlan', run: planCommand },
  {
    words: ['monitors', 'apply'],
    flags: [...PLAN_FLAGS, 'dry-run', 'yes'],
    usage: 'usage.monitorsApply',
    run: applyCommand,
  },
  {
    words: ['monitors', 'schema'],
    flags: ['output'],
    usage: 'usage.monitorsSchema',
    run: schemaCommand,
  },
  {
    words: ['status-pages', 'list'],
    flags: [],
    usage: 'usage.statusPagesList',
    run: statusPagesListCommand,
  },
  {
    words: ['status-pages', 'info'],
    flags: [],
    usage: 'usage.statusPagesInfo',
    run: statusPagesInfoCommand,
  },
  {
    words: ['incidents', 'list'],
    flags: ['page', 'all'],
    usage: 'usage.incidentsList',
    run: incidentsListCommand,
  },
  {
    words: ['incidents', 'create'],
    flags: ['page', 'title', 'status', 'message', 'impact', 'pinned'],
    usage: 'usage.incidentsCreate',
    run: incidentsCreateCommand,
  },
  {
    words: ['incidents', 'update'],
    flags: ['page', 'title', 'status', 'message', 'impact', 'pinned', 'resolve'],
    usage: 'usage.incidentsUpdate',
    run: incidentsUpdateCommand,
  },
  {
    words: ['maintenance', 'list'],
    flags: [],
    usage: 'usage.maintenanceList',
    run: maintenanceListCommand,
  },
  {
    words: ['maintenance', 'create'],
    flags: ['file', 'title', 'start', 'end', 'description', 'timezone', 'monitor'],
    usage: 'usage.maintenanceCreate',
    run: maintenanceCreateCommand,
  },
  { words: ['import'], flags: ['file', 'dry-run'], usage: 'usage.import', run: importCommand },
]

function helpText(c: ReturnType<typeof colors>, command?: Command): string {
  if (command) return `${c.bold(t('help.usage'))} ${t(command.usage)}\n`
  const lines = [
    t('help.intro', { version: CLI_VERSION }),
    '',
    c.bold(t('help.commands')),
    ...[...new Set(COMMANDS.map((cmd) => cmd.usage))].map((usage) => `  ${t(usage)}`),
    '',
    c.bold(t('help.globalFlags')),
    `  ${t('help.globals')}`,
    '',
    t('help.more'),
  ]
  return `${lines.join('\n')}\n`
}

function findCommand(positionals: string[]): Command | null {
  for (const command of COMMANDS) {
    if (command.words.every((word, index) => positionals[index] === word)) return command
  }
  return null
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  const noColorEnv = Boolean(io.env.NO_COLOR)
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...OPTIONS },
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${t('help.hint')}\n`)
    return EXIT.usage
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>
  const useColor =
    !values['no-color'] && !noColorEnv && (io.isTTY || Boolean(io.env.FORCE_COLOR)) && !values.json
  const c = colors(useColor)

  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`)
    return EXIT.ok
  }
  const positionals = parsed.positionals
  if (positionals.length === 0 || positionals[0] === 'help') {
    const command = positionals[0] === 'help' ? findCommand(positionals.slice(1)) : null
    io.stdout(helpText(c, command ?? undefined))
    return positionals.length === 0 && !values.help ? EXIT.usage : EXIT.ok
  }
  const command = findCommand(positionals)
  if (!command) {
    io.stderr(
      `${t('errors.unknownCommand', { command: positionals.join(' ') })}\n${t('help.hint')}\n`,
    )
    return EXIT.usage
  }
  if (values.help) {
    io.stdout(helpText(c, command))
    return EXIT.ok
  }
  const allowed = new Set([...Object.keys(GLOBAL_OPTIONS), ...command.flags])
  const unexpected = Object.keys(values).filter(
    (name) => values[name] !== undefined && !allowed.has(name),
  )
  if (unexpected.length > 0) {
    io.stderr(
      `${t('errors.flagNotAccepted', { flags: unexpected.map((f) => `--${f}`).join(', ') })}\n${c.bold(t('help.usage'))} ${t(command.usage)}\n`,
    )
    return EXIT.usage
  }

  const ctx = createContext(io, values, positionals.slice(command.words.length), c)
  try {
    return await command.run(ctx)
  } catch (error) {
    return reportError(ctx, error, command)
  }
}

function reportError(ctx: Ctx, error: unknown, command: Command): number {
  const { c, io } = ctx
  const emit = (payload: Record<string, unknown>, text: string) => {
    if (ctx.json) io.stdout(`${JSON.stringify({ error: payload }, null, 2)}\n`)
    io.stderr(text.endsWith('\n') ? text : `${text}\n`)
  }
  if (error instanceof UsageError) {
    emit(
      { type: 'usage', message: error.message },
      `${c.red(t('common.error'))} ${error.message}\n${c.bold(t('help.usage'))} ${t(command.usage)}`,
    )
    return EXIT.usage
  }
  if (error instanceof SpecError) {
    const lines = error.issues.map(
      (issue) => `  ${issue.path ? `${issue.path}: ` : ''}${issue.message}`,
    )
    emit(
      { type: 'invalid-file', issues: error.issues },
      `${c.red(t('errors.invalidFile'))}\n${lines.join('\n')}`,
    )
    return EXIT.usage
  }
  if (error instanceof ApplyError) {
    const cause = error.cause
    const issues = cause instanceof ApiError ? cause.issues : []
    const at = error.change
      ? t('apply.failedAt', { action: error.change.action, key: error.change.key })
      : ''
    const done = t('apply.partial', {
      created: error.result.created.length,
      updated: error.result.updated.length,
      deleted: error.result.deleted.length,
    })
    emit(
      {
        type: 'apply',
        message: error.message,
        change: error.change?.key ?? null,
        issues,
        applied: error.result,
      },
      [
        `${c.red(t('common.error'))} ${at}${error.message}`,
        ...issues.map((i) => `  ${i.path}: ${i.message}`),
        done,
      ].join('\n'),
    )
    return EXIT.error
  }
  if (error instanceof ApiError) {
    const hint =
      error.status === 0
        ? t('errors.network')
        : error.status === 401
          ? t('errors.unauthorized')
          : ''
    emit(
      { type: 'api', status: error.status, message: error.message, issues: error.issues },
      [
        `${c.red(t('common.error'))} ${error.status ? `${error.status} ` : ''}${error.message}`,
        ...error.issues.map((i) => `  ${i.path}: ${i.message}`),
        hint,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return EXIT.error
  }
  const message = error instanceof Error ? error.message : String(error)
  emit({ type: 'internal', message }, `${c.red(t('common.error'))} ${message}`)
  return EXIT.error
}
