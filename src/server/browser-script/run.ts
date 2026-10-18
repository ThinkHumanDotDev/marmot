/**
 * Runs a scripted browser check (#139): connects to the remote browser the `real-browser` monitor
 * uses, opens a fresh context (outbound address guard on every request, service workers and
 * downloads off, tracing on), runs the user's script in the QuickJS sandbox (`./sandbox.ts`) with
 * the API of `./prelude.ts`, and collects what the check saw: per-step timing, console errors,
 * failed requests, Web Vitals and, depending on the monitor's setting, a screenshot and a Playwright
 * trace.
 *
 * The host side of the sandbox bridge lives here (`createHost`): every operation the script asks for
 * is matched against an allow-list and its arguments are decoded from JSON. Nothing that touches the
 * worker's file system, environment or network (`page.screenshot({ path })`, `setInputFiles`,
 * `page.route`, `page.request`, `context()`, …) is reachable. User-written regular expressions are
 * only rebuilt to hand them to Playwright's selector engine, which runs them in the remote browser;
 * function arguments of `evaluate()` are passed on as source text and run in the browser page.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Browser, BrowserContext, Page } from 'playwright-core'

import {
  BROWSER_LIST_LIMIT,
  BROWSER_TEXT_LIMIT,
  type BrowserArtifactMode,
  type BrowserCheckDetails,
  type BrowserFailedRequest,
  type BrowserLogLine,
  type BrowserStep,
  type BrowserWebVitals,
  type CheckArtifactKind,
} from '@/lib/browser-script'
import { REDACTED } from '@/lib/response-log'
import {
  assertHostsAllowed,
  findBlockedMessage,
  outboundGuardActive,
} from '@/server/security/outbound-guard'

import { GUEST_PRELUDE } from './prelude'
import { runInSandbox, type SandboxHost } from './sandbox'

/** A screenshot or trace produced by a check, before it is stored. */
export interface CheckArtifactFile {
  kind: CheckArtifactKind
  filename: string
  mimeType: string
  data: Buffer
}

export interface BrowserScriptInput {
  script: string
  /** The monitor's URL: `url` in the script and the base for relative `page.goto()`. */
  startUrl: string | null
  vars: Record<string, string>
  secrets: Record<string, string>
  connect: (timeoutMs: number) => Promise<Browser>
  ignoreTls: boolean
  artifacts: BrowserArtifactMode
  /** Time for the whole check, artifacts included. */
  timeoutMs: number
  signal?: AbortSignal
}

export interface BrowserScriptRun {
  ok: boolean
  /** Why the script failed (secrets scrubbed); `null` when it passed. */
  error: string | null
  durationMs: number
  details: BrowserCheckDetails
  files: CheckArtifactFile[]
}

/** Largest trace kept (bytes); a bigger one is dropped rather than stored. */
export const TRACE_MAX_BYTES = 25 * 1024 * 1024
/** Largest value an operation may return to the script (JSON characters). */
const RESULT_MAX_CHARS = 1024 * 1024
/** Most locator steps in one chain. */
const MAX_CHAIN = 50
/** Shorter secrets are not scrubbed: they would match ordinary text. */
const MIN_SECRET_LENGTH = 4

/** Locator-building methods, by the kind of object they are called on. */
const CHAIN_METHODS = new Set([
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'frameLocator',
  'contentFrame',
  'first',
  'last',
  'nth',
  'filter',
  'and',
  'or',
])

const LOCATOR_ACTIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'clear',
  'press',
  'pressSequentially',
  'type',
  'check',
  'uncheck',
  'setChecked',
  'selectOption',
  'selectText',
  'hover',
  'focus',
  'blur',
  'tap',
  'dispatchEvent',
  'scrollIntoViewIfNeeded',
  'waitFor',
  'textContent',
  'innerText',
  'innerHTML',
  'inputValue',
  'getAttribute',
  'isVisible',
  'isHidden',
  'isEnabled',
  'isDisabled',
  'isChecked',
  'isEditable',
  'count',
  'allTextContents',
  'allInnerTexts',
  'boundingBox',
])

const PAGE_ACTIONS = new Set([
  'goto',
  'reload',
  'goBack',
  'goForward',
  'waitForURL',
  'waitForLoadState',
  'waitForTimeout',
  'waitForSelector',
  'title',
  'content',
  'setViewportSize',
  'click',
  'fill',
  'press',
  'check',
  'uncheck',
  'hover',
  'focus',
  'selectOption',
  'textContent',
  'innerText',
  'inputValue',
  'isVisible',
  'isHidden',
  'getAttribute',
  'dblclick',
  'type',
])

const KEYBOARD_ACTIONS = new Set(['press', 'type', 'down', 'up', 'insertText'])
const MOUSE_ACTIONS = new Set(['click', 'dblclick', 'move', 'down', 'up', 'wheel'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const truncate = (value: string, limit = BROWSER_TEXT_LIMIT) =>
  value.length > limit ? `${value.slice(0, limit)}…` : value

/** Replaces every secret value (longest first) in `text`. */
export function secretScrubber(secrets: Record<string, string>): (text: string) => string {
  const values = Object.values(secrets)
    .filter((value) => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  return (text) => {
    let out = text
    for (const value of values) {
      if (out.includes(value)) out = out.split(value).join(REDACTED)
      const encoded = encodeURIComponent(value)
      if (encoded !== value && out.includes(encoded)) out = out.split(encoded).join(REDACTED)
    }
    return out
  }
}

/** Only web pages may be opened (no `file:`, `chrome:`, `javascript:` …, see GHSA-2qgm-m29m-cj2h). */
export function assertNavigableUrl(value: string, base: string | null): URL {
  let url: URL
  try {
    url = base ? new URL(value, base) : new URL(value)
  } catch {
    throw new Error(`Invalid URL "${truncate(value, 200)}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid url protocol, only http and https are allowed.')
  }
  return url
}

/** A host function whose source text is `source`: Playwright serialises it, never calls it. */
function pageFunction(source: string): () => void {
  const fn = () => undefined
  Object.defineProperty(fn, 'toString', { value: () => source })
  return fn
}

/** Browser-side Web Vitals collector (navigation timing, paint, LCP and CLS observers). */
const WEB_VITALS_SCRIPT = `new Promise((resolve) => {
  const out = { ttfb: null, fcp: null, lcp: null, cls: null, domContentLoaded: null, load: null }
  const nav = performance.getEntriesByType('navigation')[0]
  if (nav) {
    out.ttfb = nav.responseStart || null
    out.domContentLoaded = nav.domContentLoadedEventEnd || null
    out.load = nav.loadEventEnd || null
  }
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]
  if (fcp) out.fcp = fcp.startTime
  const types = (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || []
  let cls = 0
  try {
    if (types.includes('layout-shift')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) cls += entry.value
      }).observe({ type: 'layout-shift', buffered: true })
    }
    if (types.includes('largest-contentful-paint')) {
      new PerformanceObserver((list) => {
        const entries = list.getEntries()
        if (entries.length) out.lcp = entries[entries.length - 1].startTime
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    }
  } catch (e) {}
  setTimeout(() => {
    if (types.includes('layout-shift')) out.cls = Math.round(cls * 1000) / 1000
    resolve(out)
  }, 50)
})`

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.()),
  ])

interface HostState {
  steps: BrowserStep[]
  stack: number[]
  logs: BrowserLogLine[]
  startedAt: number
}

/**
 * The host side of the bridge: decodes arguments and runs allow-listed operations on `page`.
 * Exported for the tests, which drive it without a sandbox.
 */
export function createHost(
  page: Page,
  options: {
    deadline: number
    baseUrl: string | null
    scrub: (text: string) => string
    signal?: AbortSignal
    state: HostState
  },
): SandboxHost {
  const remaining = () => Math.max(0, options.deadline - Date.now())

  /** Timeouts of Playwright options never outlive the check (0 means "no timeout" there). */
  const clampOptions = (value: unknown): unknown => {
    if (!isObject(value)) return value
    const out: Record<string, unknown> = { ...value }
    if ('timeout' in out) {
      const timeout = typeof out.timeout === 'number' ? out.timeout : remaining()
      out.timeout = Math.max(1, Math.min(timeout > 0 ? timeout : remaining(), remaining()))
    }
    delete out.path
    return out
  }

  type Decoded = unknown
  const decode = (
    value: unknown,
    allow: { regex?: boolean; locator?: boolean },
    depth = 0,
  ): Decoded => {
    if (depth > 20) throw new Error('Argument is nested too deeply')
    if (Array.isArray(value)) return value.map((item) => decode(item, allow, depth + 1))
    if (!isObject(value)) return value
    if (Array.isArray(value.__re)) {
      if (!allow.regex) throw new Error('A regular expression is not supported here')
      const [source, flags] = value.__re as unknown[]
      return new RegExp(String(source), String(flags ?? ''))
    }
    if ('__locator' in value) {
      if (!allow.locator) throw new Error('A locator is not supported here')
      return resolveChain(value.__locator)
    }
    if ('__fn' in value) throw new Error('A function is only supported by evaluate()')
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = decode(item, allow, depth + 1)
    return clampOptions(out)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Page | Locator | FrameLocator
  const resolveChain = (chain: unknown): any => {
    if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_CHAIN) {
      throw new Error('Invalid locator')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = page
    for (const step of chain) {
      if (!isObject(step) || typeof step.m !== 'string' || !CHAIN_METHODS.has(step.m)) {
        throw new Error(`Unsupported locator method "${isObject(step) ? String(step.m) : '?'}"`)
      }
      if (typeof current[step.m] !== 'function') {
        throw new Error(`"${step.m}" is not available here`)
      }
      const args = Array.isArray(step.a) ? step.a : []
      current = current[step.m](...(decode(args, { regex: true, locator: true }) as unknown[]))
    }
    return current
  }

  /** `evaluate(fn | expression, arg)`: the function's source runs in the browser page. */
  const evaluateArgs = (args: unknown[]): unknown[] => {
    const [fn, arg] = args
    const target =
      isObject(fn) && typeof fn.__fn === 'string'
        ? pageFunction(fn.__fn)
        : typeof fn === 'string'
          ? fn
          : null
    if (target === null) throw new Error('evaluate() expects a function or an expression')
    return [target, decode(arg ?? null, {})]
  }

  const result = (value: unknown): unknown => {
    if (value === undefined) return null
    const json = JSON.stringify(value)
    if (json && json.length > RESULT_MAX_CHARS) throw new Error('Result is too large')
    return value
  }

  const goto = async (args: unknown[]) => {
    const [target, opts] = args
    if (typeof target !== 'string') throw new Error('page.goto() expects a URL string')
    const url = assertNavigableUrl(target, options.baseUrl)
    if (outboundGuardActive()) await assertHostsAllowed([url.hostname])
    const response = await page.goto(url.href, clampOptions(decode(opts ?? {}, {})) as never)
    return response ? { status: response.status(), url: response.url() } : null
  }

  /** A wait that would outlast the check ends it at the deadline instead of returning. */
  const sleep = (ms: unknown) =>
    new Promise<null>((resolve, reject) => {
      const wanted = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0
      const left = remaining()
      if (wanted < left) setTimeout(() => resolve(null), wanted)
      else setTimeout(() => reject(new Error('Script timed out')), left)
    })

  return {
    async call(op, rawArgs) {
      if (options.signal?.aborted || remaining() <= 0) throw new Error('Script timed out')
      switch (op) {
        case 'sleep':
          return sleep(rawArgs[0])
        case 'page': {
          const [method, args] = rawArgs as [unknown, unknown]
          const list = Array.isArray(args) ? args : []
          if (method === 'evaluate') {
            const evaluate = page.evaluate.bind(page) as (...a: unknown[]) => Promise<unknown>
            return result(await evaluate(...evaluateArgs(list)))
          }
          if (typeof method !== 'string' || !PAGE_ACTIONS.has(method)) {
            throw new Error(`page.${String(method)}() is not available in browser scripts`)
          }
          if (method === 'goto') return goto(list)
          if (method === 'waitForTimeout') return sleep(list[0])
          if (method === 'waitForURL' && typeof list[0] !== 'string') {
            throw new Error('page.waitForURL() expects a URL string or a regular expression')
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fn = (page as any)[method] as (...a: unknown[]) => Promise<unknown>
          const value = await fn.apply(page, decode(list, {}) as unknown[])
          return result(
            method === 'reload' || method === 'goBack' || method === 'goForward' ? null : value,
          )
        }
        case 'locator': {
          const [chain, method, args] = rawArgs as [unknown, unknown, unknown]
          const list = Array.isArray(args) ? args : []
          const locator = resolveChain(chain)
          if (method === 'isFocused') {
            return result(
              await locator.evaluate((el: Element) => el === el.ownerDocument.activeElement),
            )
          }
          if (method === 'evaluate' || method === 'evaluateAll') {
            return result(await locator[method](...evaluateArgs(list)))
          }
          if (typeof method !== 'string' || !LOCATOR_ACTIONS.has(method)) {
            throw new Error(`locator.${String(method)}() is not available in browser scripts`)
          }
          if (typeof locator[method] !== 'function') {
            throw new Error(`"${method}" is not available here`)
          }
          return result(await locator[method](...(decode(list, { locator: true }) as unknown[])))
        }
        case 'keyboard':
        case 'mouse': {
          const [method, args] = rawArgs as [unknown, unknown]
          const allowed = op === 'keyboard' ? KEYBOARD_ACTIONS : MOUSE_ACTIONS
          if (typeof method !== 'string' || !allowed.has(method)) {
            throw new Error(`page.${op}.${String(method)}() is not available in browser scripts`)
          }
          const target = page[op] as unknown as Record<string, (...a: unknown[]) => Promise<void>>
          await target[method]!(...(decode(Array.isArray(args) ? args : [], {}) as unknown[]))
          return null
        }
        default:
          throw new Error(`Unknown operation "${op}"`)
      }
    },
    url: () => page.url(),
    note(op, args, meta) {
      const { state } = options
      const at = Math.max(0, meta.at - state.startedAt)
      switch (op) {
        case 'step.start':
          // Ids are handed out by the sandbox in order, so they are indexes into `steps`.
          if (meta.id !== state.steps.length || state.steps.length >= BROWSER_LIST_LIMIT) return
          state.steps.push({
            name: truncate(options.scrub(String(args[0] ?? '')), 200),
            depth: state.stack.length,
            startMs: at,
            durationMs: null,
            error: null,
          })
          state.stack.push(meta.id)
          return
        case 'step.end': {
          const id = args[0]
          const step = typeof id === 'number' ? state.steps[id] : undefined
          if (!step || step.durationMs !== null) return
          step.durationMs = Math.max(0, at - step.startMs)
          step.error = typeof args[1] === 'string' ? truncate(options.scrub(args[1])) : null
          const index = state.stack.lastIndexOf(id as number)
          if (index >= 0) state.stack.splice(index)
          return
        }
        case 'log':
          if (state.logs.length < BROWSER_LIST_LIMIT) {
            state.logs.push({
              level: String(args[0] ?? 'log').slice(0, 10),
              text: truncate(options.scrub(String(args[1] ?? ''))),
            })
          }
          return
      }
    },
  }
}

/** Run the script; never throws for a failing script (the result says why). */
export async function runBrowserScript(input: BrowserScriptInput): Promise<BrowserScriptRun> {
  const startedAt = Date.now()
  // Leave time at the end for the screenshot, the trace and closing the context.
  const reserve = Math.min(5_000, Math.round(input.timeoutMs * 0.25))
  const deadline = startedAt + Math.max(1_000, input.timeoutMs - reserve)
  const scrub = secretScrubber(input.secrets)

  const consoleErrors: string[] = []
  const failedRequests: BrowserFailedRequest[] = []
  const state: HostState = { steps: [], stack: [], logs: [], startedAt }
  const files: CheckArtifactFile[] = []
  let webVitals: BrowserWebVitals | null = null
  let finalUrl: string | null = null
  let error: string | null = null

  const pushRequest = (request: BrowserFailedRequest) => {
    if (failedRequests.length < BROWSER_LIST_LIMIT) failedRequests.push(request)
  }

  const browser = await input.connect(Math.max(1_000, deadline - Date.now()))
  let context: BrowserContext | null = null
  try {
    context = await browser.newContext({
      ignoreHTTPSErrors: input.ignoreTls,
      acceptDownloads: false,
      serviceWorkers: 'block',
      ...(input.startUrl ? { baseURL: input.startUrl } : {}),
    })
    context.setDefaultTimeout(Math.max(1_000, deadline - Date.now()))
    context.setDefaultNavigationTimeout(Math.max(1_000, deadline - Date.now()))

    // The outbound address guard (MONITOR_DENY_CIDRS, …) vets every request and WebSocket the page
    // makes, redirects and subresources included.
    if (outboundGuardActive()) {
      await context.route('**/*', async (route) => {
        const request = route.request()
        let blocked: string | null = null
        try {
          const url = new URL(request.url())
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            await assertHostsAllowed([url.hostname])
          } else if (url.protocol !== 'data:' && url.protocol !== 'blob:') {
            blocked = `Blocked: ${url.protocol} requests are not allowed`
          }
        } catch (err) {
          blocked = findBlockedMessage(err) ?? (err instanceof Error ? err.message : String(err))
        }
        if (blocked) {
          pushRequest({
            method: request.method(),
            url: truncate(scrub(request.url())),
            status: null,
            error: blocked,
          })
          await route.abort('blockedbyclient').catch(() => undefined)
        } else {
          await route.continue().catch(() => undefined)
        }
      })
      await context.routeWebSocket(/.*/, async (ws) => {
        try {
          await assertHostsAllowed([new URL(ws.url()).hostname])
          ws.connectToServer()
        } catch (err) {
          pushRequest({
            method: 'WEBSOCKET',
            url: truncate(scrub(ws.url())),
            status: null,
            error: findBlockedMessage(err) ?? 'blocked',
          })
          await ws.close().catch(() => undefined)
        }
      })
    }

    await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => undefined)
    const page = await context.newPage()

    page.on('console', (message) => {
      if (message.type() === 'error' && consoleErrors.length < BROWSER_LIST_LIMIT) {
        consoleErrors.push(truncate(scrub(message.text())))
      }
    })
    page.on('pageerror', (err) => {
      if (consoleErrors.length < BROWSER_LIST_LIMIT) {
        consoleErrors.push(truncate(scrub(err.message || String(err))))
      }
    })
    context.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'failed'
      // Requests the guard refused are already listed with the reason.
      if (failure.includes('ERR_BLOCKED_BY_CLIENT') && outboundGuardActive()) return
      pushRequest({
        method: request.method(),
        url: truncate(scrub(request.url())),
        status: null,
        error: failure,
      })
    })
    context.on('response', (response) => {
      if (response.status() >= 400) {
        pushRequest({
          method: response.request().method(),
          url: truncate(scrub(response.url())),
          status: response.status(),
          error: null,
        })
      }
    })

    const host = createHost(page, {
      deadline,
      baseUrl: input.startUrl,
      scrub,
      signal: input.signal,
      state,
    })
    const outcome = await runInSandbox({
      prelude: GUEST_PRELUDE,
      source: input.script,
      init: { vars: input.vars, secrets: input.secrets, url: input.startUrl ?? '' },
      host,
      deadline,
      signal: input.signal,
    })
    if (!outcome.ok) {
      error =
        outcome.reason === 'timeout'
          ? `Script timed out after ${Math.round((deadline - startedAt) / 1000)}s`
          : outcome.message
    }
    // A step still open when the script stopped failed with it.
    for (const id of state.stack) {
      const step = state.steps[id]
      if (step && step.durationMs === null) {
        step.durationMs = Date.now() - startedAt - step.startMs
        step.error = error ? truncate(scrub(error)) : null
      }
    }

    finalUrl = page.url() && page.url() !== 'about:blank' ? truncate(scrub(page.url())) : null
    webVitals = (await withTimeout(
      page.evaluate(WEB_VITALS_SCRIPT) as Promise<BrowserWebVitals>,
      2_000,
    )) as BrowserWebVitals | null

    const keep = input.artifacts === 'always' || error !== null
    if (keep) {
      const screenshot = await withTimeout(
        page.screenshot({ type: 'jpeg', quality: 80, timeout: 3_000 }),
        3_500,
      )
      if (screenshot) {
        files.push({
          kind: 'screenshot',
          filename: 'screenshot.jpg',
          mimeType: 'image/jpeg',
          data: screenshot,
        })
      }
      const trace = await stopTracing(context)
      if (trace) files.push(trace)
    } else {
      await context.tracing.stop().catch(() => undefined)
    }
  } catch (err) {
    error ??= err instanceof Error ? err.message : String(err)
  } finally {
    await context?.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }

  const blocked = error ? findBlockedMessage(error) : null
  return {
    ok: error === null,
    error: error === null ? null : truncate(scrub(blocked ?? error), 2_000),
    durationMs: Date.now() - startedAt,
    details: {
      steps: state.steps,
      consoleErrors,
      failedRequests,
      logs: state.logs,
      webVitals,
      finalUrl,
    },
    files,
  }
}

/** Stop tracing into a temporary file and read it back (Playwright writes traces to disk). */
async function stopTracing(context: BrowserContext): Promise<CheckArtifactFile | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'marmot-trace-'))
  try {
    const file = path.join(dir, 'trace.zip')
    const stopped = await withTimeout(
      context.tracing.stop({ path: file }).then(() => true),
      10_000,
    )
    if (!stopped) return null
    const data = await readFile(file)
    if (data.length === 0 || data.length > TRACE_MAX_BYTES) return null
    return { kind: 'trace', filename: 'trace.zip', mimeType: 'application/zip', data }
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
