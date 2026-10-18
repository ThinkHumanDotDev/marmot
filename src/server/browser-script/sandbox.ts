/**
 * Sandbox for user-supplied browser scripts (#139).
 *
 * Every run gets its own worker thread (`./sandbox-thread.mjs`) with a fresh QuickJS instance:
 * a separate JavaScript engine compiled to WebAssembly. The script never runs in Node's engine —
 * no `eval`, `new Function` or `node:vm` in the worker process — so it has no `process`, `require`,
 * `import()`, file system, environment, timers or sockets, and no prototype chain that leads to
 * Node's realm (see the thread's header for details).
 *
 * The only capabilities a script has are the operations of `SandboxHost`, answered here on the main
 * thread (`./run.ts` allow-lists them and drives the remote browser). Values cross both boundaries as
 * JSON strings.
 *
 * Limits:
 * - guest heap `MEMORY_LIMIT_BYTES` and stack `MAX_STACK_BYTES` (QuickJS);
 * - `SLICE_LIMIT_MS` of running without awaiting the browser and `CPU_BUDGET_MS` in total (QuickJS'
 *   uncatchable interrupt);
 * - the check's deadline: the thread is terminated, which also stops code QuickJS cannot interrupt
 *   (a slow native allocation near the memory limit), and the thread's own V8 heap is capped
 *   (`resourceLimits`). Because the guest runs on its own thread, none of this blocks the worker's
 *   event loop.
 */
import path from 'node:path'
import { Worker } from 'node:worker_threads'

/** Guest heap limit. A Playwright script needs a few hundred KB; this leaves ample room. */
export const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024
/** Guest stack limit (deep recursion fails with a RangeError). */
export const MAX_STACK_BYTES = 512 * 1024
/** Longest the guest may run without awaiting the browser. */
export const SLICE_LIMIT_MS = 1_000
/** Total guest CPU time per run, all slices together. */
export const CPU_BUDGET_MS = 5_000

/**
 * The sandbox thread, loaded from `src/` relative to the working directory like the migrations
 * (`src/db/adapter.ts`): the image keeps `src/` and runs from `/app`.
 */
export const SANDBOX_THREAD_PATH = path.resolve(
  process.cwd(),
  'src/server/browser-script/sandbox-thread.mjs',
)

/** The host side of the bridge: the only capabilities a script has. */
export interface SandboxHost {
  /** An asynchronous operation (`page.goto`, `locator.click`, …). Throws to reject in the guest. */
  call(op: string, args: unknown[]): Promise<unknown>
  /**
   * Bookkeeping sent by the guest without waiting for an answer (`step.start`, `step.end`, `log`),
   * with the guest's step id and clock.
   */
  note(op: string, args: unknown[], meta: { id: number | null; at: number }): void
  /** The page's current URL, handed to the guest with every answer (`page.url()` is synchronous). */
  url(): string
}

export interface SandboxOptions {
  /** Code evaluated before the script, as the sandbox's own setup (the API prelude). */
  prelude: string
  /** The user's script: the body of an async function. */
  source: string
  /** JSON-serialisable values exposed to the prelude as `__marmot_init`. */
  init: Record<string, unknown>
  host: SandboxHost
  /** Wall-clock deadline (epoch ms) of the whole run. */
  deadline: number
  /** Aborts the run (the check's timeout signal). */
  signal?: AbortSignal
  memoryLimitBytes?: number
  sliceLimitMs?: number
  cpuBudgetMs?: number
}

export type SandboxOutcome =
  | { ok: true }
  | {
      ok: false
      /** `timeout`: deadline or abort; `limit`: CPU or memory limit; `error`: the script threw. */
      reason: 'timeout' | 'limit' | 'error'
      message: string
    }

type ThreadMessage =
  | { type: 'call'; id: number; op: string; argsJson: string }
  | { type: 'sync'; op: string; argsJson: string; id: number | null; at: number }
  | { type: 'done'; outcome: SandboxOutcome }

const parseArgs = (json: string): unknown[] => {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Run `source` in a fresh sandbox with the prelude's API and resolve once its promise settles, a
 * limit trips or the deadline passes. Never throws for script errors.
 */
export function runInSandbox(options: SandboxOptions): Promise<SandboxOutcome> {
  return new Promise<SandboxOutcome>((resolve) => {
    let settled = false
    const worker = new Worker(SANDBOX_THREAD_PATH, {
      workerData: {
        prelude: options.prelude,
        source: options.source,
        init: options.init,
        memoryLimitBytes: options.memoryLimitBytes ?? MEMORY_LIMIT_BYTES,
        maxStackBytes: MAX_STACK_BYTES,
        sliceLimitMs: options.sliceLimitMs ?? SLICE_LIMIT_MS,
        cpuBudgetMs: options.cpuBudgetMs ?? CPU_BUDGET_MS,
      },
      // The thread runs our code only, but it gets nothing it does not need either.
      env: {},
      argv: [],
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    })

    const done = (outcome: SandboxOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate().catch(() => undefined)
      resolve(outcome)
    }
    const onAbort = () => done({ ok: false, reason: 'timeout', message: 'Script timed out' })
    const timer = setTimeout(onAbort, Math.max(0, options.deadline - Date.now()))
    if (options.signal?.aborted) onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (message: ThreadMessage) => {
      if (settled) return
      if (message.type === 'done') {
        done(message.outcome)
        return
      }
      if (message.type === 'sync') {
        try {
          options.host.note(message.op, parseArgs(message.argsJson), {
            id: message.id,
            at: message.at,
          })
        } catch {
          // Bookkeeping never fails the script.
        }
        return
      }
      if (message.type !== 'call') return
      const { id } = message
      options.host.call(message.op, parseArgs(message.argsJson)).then(
        (value) => {
          if (settled) return
          worker.postMessage({
            id,
            ok: true,
            json: JSON.stringify(value ?? null),
            url: safeUrl(options.host),
          })
        },
        (err: unknown) => {
          if (settled) return
          worker.postMessage({
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            url: safeUrl(options.host),
          })
        },
      )
    })
    worker.on('error', (err) => {
      // The thread's own V8 heap limit (`resourceLimits`) ends up here too.
      const message = err instanceof Error ? err.message : String(err)
      done({
        ok: false,
        reason: /memory|heap/i.test(message) ? 'limit' : 'error',
        message: `Sandbox failed: ${message}`,
      })
    })
    worker.on('exit', () => {
      done({ ok: false, reason: 'error', message: 'Sandbox stopped unexpectedly' })
    })
  })
}

function safeUrl(host: SandboxHost): string | undefined {
  try {
    return host.url()
  } catch {
    return undefined
  }
}
