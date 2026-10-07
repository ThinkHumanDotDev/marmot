/** Shared plumbing of the CLI commands: I/O, flags, the API client and errors. */
import pkg from '../../package.json'

import { MarmotClient, type Id, type MonitorDoc, type StatusPageDoc } from './core/client'
import { configPath, readConfigFile, resolveConnection, type Env } from './config'
import type { Colors } from './output'
import { t } from './text'

export const CLI_VERSION: string = pkg.version

/** Exit codes, documented in docs/CLI.md. */
export const EXIT = {
  ok: 0,
  /** API, network or apply failure. */
  error: 1,
  /** Invalid command line or file. */
  usage: 2,
  /** `plan --exit-code` / `apply --dry-run --exit-code`: there are changes. */
  changes: 3,
  /** `status --fail-on-down`, `check`, `monitors check`: something is down. */
  down: 4,
} as const

/** Everything the CLI touches outside itself, so tests can run it in-process. */
export interface CliIo {
  env: Env
  stdout(text: string): void
  stderr(text: string): void
  /** stdout is a terminal (colours on by default). */
  isTTY: boolean
  /** stdin is a terminal (confirmation prompts possible). */
  interactive: boolean
  fetch?: typeof fetch
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  readStdin(): Promise<string>
  confirm(question: string): Promise<boolean>
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type Values = Record<string, string | boolean | string[] | undefined>

export interface Ctx {
  io: CliIo
  values: Values
  /** Positionals after the command words. */
  args: string[]
  c: Colors
  json: boolean
  quiet: boolean
  client(): Promise<MarmotClient>
  /** Data output (stdout). */
  print(text: string): void
  /** JSON output (stdout). */
  printJson(value: unknown): void
  /** Progress and hints (stderr; silenced by `--quiet` and `--json`). */
  info(text: string): void
  warn(text: string): void
  str(name: string): string | undefined
  bool(name: string): boolean
}

export function createContext(io: CliIo, values: Values, args: string[], c: Colors): Ctx {
  const json = values.json === true
  const quiet = values.quiet === true
  let client: MarmotClient | null = null
  return {
    io,
    values,
    args,
    c,
    json,
    quiet,
    async client() {
      if (client) return client
      const config = await readConfigFile(configPath(io.env))
      const connection = resolveConnection(
        {
          url: values.url as string | undefined,
          apiKey: values['api-key'] as string | undefined,
          org: values.org as string | undefined,
          profile: values.profile as string | undefined,
        },
        io.env,
        config,
      )
      const missing = (['url', 'apiKey', 'org'] as const).filter((k) => !connection[k])
      if (missing.length > 0)
        throw new UsageError(t('errors.notConfigured', { missing: missing.join(', ') }))
      client = new MarmotClient({
        url: connection.url as string,
        apiKey: connection.apiKey as string,
        org: connection.org as string,
        fetch: io.fetch,
        userAgent: `marmot-cli/${CLI_VERSION}`,
      })
      return client
    },
    print: (text) => io.stdout(text.endsWith('\n') ? text : `${text}\n`),
    printJson: (value) => io.stdout(`${JSON.stringify(value, null, 2)}\n`),
    info(text) {
      if (!quiet && !json) io.stderr(`${text}\n`)
    },
    warn(text) {
      if (!quiet) io.stderr(`${c.yellow(t('common.warning'))} ${text}\n`)
    },
    str: (name) => (typeof values[name] === 'string' ? (values[name] as string) : undefined),
    bool: (name) => values[name] === true,
  }
}

/** First positional, or a usage error naming `what`. */
export function requireArg(ctx: Ctx, what: string): string {
  const value = ctx.args[0]
  if (!value) throw new UsageError(t('errors.argumentMissing', { what }))
  return value
}

export function requireFlag(ctx: Ctx, name: string): string {
  const value = ctx.str(name)
  if (!value) throw new UsageError(t('errors.flagMissing', { flag: `--${name}` }))
  return value
}

/** Positive integer flag. */
export function intFlag(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.str(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(t('errors.flagInteger', { flag: `--${name}` }))
  }
  return value
}

/**
 * A monitor by reference: a monitors-as-code key, or an id (`#12` or `12`). Keys win over ids when
 * both match.
 */
export async function findMonitor(client: MarmotClient, ref: string): Promise<MonitorDoc> {
  if (!ref.startsWith('#')) {
    const [byKey] = await client.listMonitors({ key: ref })
    if (byKey) return byKey
  }
  return client.getMonitor(ref.replace(/^#/, ''))
}

/** A status page by id or slug. */
export async function findStatusPage(client: MarmotClient, ref: string): Promise<StatusPageDoc> {
  const pages = await client.listStatusPages()
  const page = pages.find((p) => p.slug === ref || String(p.id) === ref.replace(/^#/, ''))
  if (!page) throw new UsageError(t('errors.statusPageNotFound', { ref }))
  return page
}

export const idOf = (value: unknown): Id | null =>
  value && typeof value === 'object' && 'id' in value
    ? ((value as { id: Id }).id ?? null)
    : ((value as Id | null | undefined) ?? null)
