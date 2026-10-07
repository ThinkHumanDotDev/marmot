/**
 * `run` mode of the GitHub Action (#118): "check now" (#98) for each listed monitor, waiting for the
 * result, and the verdict that decides whether the job fails.
 */
import {
  ApiError,
  type CheckResult,
  type Id,
  type MarmotClient,
  type MonitorDoc,
} from '../cli/core/client'
import { fromMarmotExport, parseSpecText } from '../cli/core/spec'
import { t } from '../cli/text'

export type Verdict = 'pass' | 'fail' | 'skip'

/** One row of the checks summary. */
export interface CheckRow {
  /** What the workflow listed (key or id). */
  ref: string
  id: Id | null
  key: string | null
  name: string | null
  /** Status of the check (`up`, `down`, `degraded`, …) or `error` when no result came back. */
  status: string
  ping: number | null
  statusCode: number | null
  /** The check's message, or the API error. */
  message: string
  /** Failed or unevaluable assertions (#96), as readable lines. */
  assertions: string[]
  verdict: Verdict
  /** Why a passing or skipped row is not a plain pass (degraded allowed, maintenance). */
  note: string | null
}

/** A monitors-file entry as far as `run` needs it. */
interface FileEntry {
  key?: unknown
  type?: unknown
  active?: unknown
}

/**
 * The monitor keys a monitors file lists, for `run` without `monitors`. Paused entries
 * (`active: false`) and push monitors (fed from outside, nothing to check) are left out. The file is
 * read without `${ENV}` interpolation: the check job does not need the monitors' credentials.
 */
export function keysFromFile(text: string): string[] {
  let raw = parseSpecText(text) as Record<string, unknown> | null
  if (raw && typeof raw === 'object' && raw.format === 'marmot') {
    raw = fromMarmotExport(raw).document as unknown as Record<string, unknown>
  }
  const list = raw && typeof raw === 'object' && Array.isArray(raw.monitors) ? raw.monitors : []
  return (list as FileEntry[])
    .filter((entry) => entry && typeof entry.key === 'string' && entry.key)
    .filter((entry) => entry.active !== false && entry.type !== 'push')
    .map((entry) => entry.key as string)
}

interface AssertionLike {
  kind?: unknown
  target?: unknown
  comparator?: unknown
  expected?: unknown
  actual?: unknown
  passed?: unknown
  error?: unknown
}

const text = (value: unknown) => (value === null || value === undefined ? '∅' : String(value))

/** Failed assertions of a result (`assertions` or `details.assertions`), as readable lines. */
export function failedAssertions(result: CheckResult): string[] {
  const list = (result.assertions ?? result.details?.assertions) as unknown
  if (!Array.isArray(list)) return []
  const lines: string[] = []
  for (const item of list as AssertionLike[]) {
    if (!item || typeof item !== 'object' || item.passed !== false) continue
    const target = typeof item.target === 'string' && item.target ? item.target : 'none'
    lines.push(
      item.error
        ? t('action.assertionError', { kind: text(item.kind), target, error: text(item.error) })
        : t('action.assertionFailed', {
            kind: text(item.kind),
            target,
            comparator: text(item.comparator),
            expected: text(item.expected),
            actual: text(item.actual),
          }),
    )
  }
  return lines
}

/**
 * Verdict for one check result. Fails on `down`, on `pending` (a failing check of a monitor with
 * retries left) and on failed assertions; `degraded` fails only with `failOnDegraded`; a monitor in
 * maintenance is skipped. Anything unknown fails, so a new status cannot slip through as a pass.
 */
export function verdictFor(
  result: { status: string; maintenance?: unknown },
  assertions: string[],
  failOnDegraded: boolean,
): { verdict: Verdict; note: string | null } {
  if (result.maintenance === true || result.status === 'maintenance') {
    return { verdict: 'skip', note: t('action.maintenance') }
  }
  if (assertions.length > 0) return { verdict: 'fail', note: null }
  switch (result.status) {
    case 'up':
      return { verdict: 'pass', note: null }
    case 'degraded':
      return failOnDegraded
        ? { verdict: 'fail', note: null }
        : { verdict: 'pass', note: t('action.degradedAllowed') }
    case 'pending':
      return { verdict: 'fail', note: t('action.pendingRetry') }
    default:
      return { verdict: 'fail', note: null }
  }
}

/** 0 when no row failed, else 1. */
export const checksExitCode = (rows: CheckRow[]): number =>
  rows.some((row) => row.verdict === 'fail') ? 1 : 0

export interface RunChecksOptions {
  failOnDegraded: boolean
  /** Checks running at the same time (the instance rate-limits on-demand checks per minute). */
  concurrency?: number
  /** Retries of a check answered with 429, `retryDelayMs` apart. */
  retries?: number
  retryDelayMs?: number
  sleep(ms: number): Promise<void>
  log?(message: string): void
}

const errorRow = (ref: string, monitor: MonitorDoc | null, message: string): CheckRow => ({
  ref,
  id: monitor?.id ?? null,
  key: monitor?.key ?? null,
  name: monitor?.name ?? null,
  status: 'error',
  ping: null,
  statusCode: null,
  message,
  assertions: [],
  verdict: 'fail',
  note: null,
})

/** Finds a listed ref among the organization's monitors: a key first, then an id (`12`, `#12`). */
export function resolveRef(monitors: MonitorDoc[], ref: string): MonitorDoc | null {
  if (!ref.startsWith('#')) {
    const byKey = monitors.find((m) => m.key === ref)
    if (byKey) return byKey
  }
  const id = ref.replace(/^#/, '')
  return monitors.find((m) => String(m.id) === id) ?? null
}

async function checkOne(
  client: MarmotClient,
  ref: string,
  monitor: MonitorDoc,
  options: RunChecksOptions,
): Promise<CheckRow> {
  const retries = options.retries ?? 4
  const delay = options.retryDelayMs ?? 15_000
  for (let attempt = 0; ; attempt++) {
    try {
      const result = (await client.checkMonitor(monitor.id, { wait: true })) as CheckResult
      const assertions = failedAssertions(result)
      const { verdict, note } = verdictFor(result, assertions, options.failOnDegraded)
      return {
        ref,
        id: monitor.id,
        key: monitor.key ?? null,
        name: monitor.name,
        status: String(result.status),
        ping: result.ping ?? null,
        statusCode: result.statusCode ?? null,
        message: result.msg ?? '',
        assertions,
        verdict,
        note,
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && attempt < retries) {
        options.log?.(t('action.rateLimited', { seconds: Math.round(delay / 1000) }))
        await options.sleep(delay)
        continue
      }
      const message =
        error instanceof ApiError
          ? `${error.status ? `${error.status} ` : ''}${error.message}`
          : error instanceof Error
            ? error.message
            : String(error)
      return errorRow(ref, monitor, message)
    }
  }
}

/** Checks every ref (in order of the list, `concurrency` at a time) and returns one row each. */
export async function runChecks(
  client: MarmotClient,
  refs: string[],
  options: RunChecksOptions,
): Promise<CheckRow[]> {
  const unique = [...new Set(refs)]
  const monitors = await client.listMonitors()
  const rows: CheckRow[] = new Array(unique.length)
  let next = 0
  const worker = async () => {
    while (next < unique.length) {
      const index = next++
      const ref = unique[index]
      const monitor = resolveRef(monitors, ref)
      rows[index] = monitor
        ? await checkOne(client, ref, monitor, options)
        : errorRow(ref, null, t('action.notFound', { ref }))
    }
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, unique.length))
  await Promise.all(Array.from({ length: concurrency }, worker))
  return rows
}
