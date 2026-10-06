/**
 * Helpers shared by the monitor types that talk to databases, brokers and other protocols.
 *
 * Heavy client libraries are `optionalDependencies` and loaded lazily inside `check()` with a
 * literal specifier (`await import('mysql2/promise')`), so the worker bundle (esbuild, packages
 * external) and a minimal install both work. `loadOptionalDriver` turns a failed import into a
 * readable "install <pkg>" error for the heartbeat message.
 */
import type { Monitor } from '@/payload-types'

const MISSING_MODULE_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'])
const MISSING_MODULE_PATTERNS = [
  /Cannot find (module|package)/i,
  /ERR_MODULE_NOT_FOUND/,
  /Failed to (load|resolve) (url|import|module)/i,
]

/** Is `err` what Node (or a bundler) throws when an import cannot be resolved? */
export function isModuleNotFound(err: unknown, depth = 0): boolean {
  if (!err) return false
  const code = (err as NodeJS.ErrnoException).code
  if (code && MISSING_MODULE_CODES.has(code)) return true
  const message = err instanceof Error ? err.message : String(err)
  if (MISSING_MODULE_PATTERNS.some((pattern) => pattern.test(message))) return true
  // Loaders (and test runners) may wrap the resolution error; look at the cause chain.
  const cause = (err as { cause?: unknown }).cause
  return depth < 5 && cause !== undefined && cause !== err && isModuleNotFound(cause, depth + 1)
}

/** Readable message for a missing optional driver. */
export function missingDriverMessage(pkg: string, typeLabel: string): string {
  return `The "${pkg}" package is not installed. Install ${pkg} to use the ${typeLabel} monitor (pnpm add ${pkg}).`
}

/**
 * Run `load` (an `import()` with a literal specifier) and translate a missing module into a
 * readable error. Any other failure (a broken native binding, say) is rethrown untouched.
 */
export async function loadOptionalDriver<T>(
  load: () => Promise<T>,
  pkg: string,
  typeLabel: string,
): Promise<T> {
  try {
    return await load()
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw new Error(missingDriverMessage(pkg, typeLabel))
    }
    throw err
  }
}

/**
 * Effective check timeout in milliseconds: the monitor's `timeout`, or 80% of the interval when it
 * is 0 (Uptime Kuma's fallback). Mirrors `checkTimeoutMs` of the engine worker without pulling
 * BullMQ into the monitor types.
 */
export function checkTimeoutMs(monitor: Pick<Monitor, 'timeout' | 'interval'>): number {
  const seconds =
    monitor.timeout && monitor.timeout > 0 ? monitor.timeout : Math.max(1, monitor.interval) * 0.8
  return Math.max(1, Math.round(seconds * 1000))
}

/** `monitor[field]` trimmed, or a readable error when it is empty. */
export function requireField(value: string | null | undefined, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) throw new Error(`${label} is required`)
  return trimmed
}

/** `monitor.hostname` trimmed, or a readable error. */
export function requireHostname(monitor: Pick<Monitor, 'hostname'>): string {
  return requireField(monitor.hostname, 'Hostname')
}

/** Error message of an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * Race `promise` against `signal`: when the signal aborts first, `onAbort` runs (close sockets,
 * destroy clients) and the result rejects with the engine's timeout wording.
 */
export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      try {
        onAbort?.()
      } catch {
        // Cleanup errors must not mask the timeout.
      }
      const err = new Error('timeout by AbortSignal')
      err.name = 'TimeoutError'
      reject(err)
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', abort)
        reject(err)
      },
    )
  })
}

/** Parse a JSON object stored in a text field (`{}` when empty); readable error otherwise. */
export function parseJsonObject(
  value: string | null | undefined,
  label: string,
): Record<string, unknown> {
  if (!value || !value.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${errorMessage(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}
