/**
 * Worker thread of the browser script sandbox (#139); started by `./sandbox.ts`, one thread per
 * run. Plain JavaScript loaded from `src/` at runtime (like the migrations), so the same file serves
 * `pnpm dev`, the tests and the bundled worker in the image.
 *
 * The script runs in QuickJS, a separate JavaScript engine compiled to WebAssembly
 * (`quickjs-emscripten-core` with `@jitl/quickjs-wasmfile-release-sync`): it has its own heap,
 * intrinsics and prototype chains, and no Node object is ever handed to it, so
 * `globalThis.constructor.constructor`, `Function`, `eval` and `import()` only reach QuickJS' own
 * (no module loader is installed). The only way out are `__marmot_host` (asynchronous operations,
 * answered by the main thread over `parentPort`) and `__marmot_sync` (bookkeeping), both taking an
 * operation name and JSON arguments; the main thread allow-lists every operation.
 *
 * Limits enforced here: the guest heap (`memoryLimitBytes`), its stack, the time it may run without
 * awaiting the host (`sliceLimitMs`) and its total CPU time (`cpuBudgetMs`), through QuickJS'
 * uncatchable interrupt. The deadline is enforced by the main thread, which terminates this thread,
 * so even a stuck WebAssembly call cannot outlive the check.
 */
import { parentPort, workerData } from 'node:worker_threads'

import variant from '@jitl/quickjs-wasmfile-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'

const { prelude, source, init, memoryLimitBytes, maxStackBytes, sliceLimitMs, cpuBudgetMs } =
  workerData

/** @param {unknown} value */
function guestErrorMessage(value) {
  if (value && typeof value === 'object') {
    const err = /** @type {{ name?: unknown, message?: unknown }} */ (value)
    const message = typeof err.message === 'string' ? err.message : JSON.stringify(value)
    return typeof err.name === 'string' && err.name !== 'Error' && !message.startsWith(err.name)
      ? `${err.name}: ${message}`
      : message
  }
  return String(value)
}

let done = false

/** @param {{ ok: boolean, reason?: string, message?: string }} outcome */
function finish(outcome) {
  if (done) return
  done = true
  parentPort.postMessage({ type: 'done', outcome })
}

const QuickJS = await newQuickJSWASMModuleFromVariant(variant)
const runtime = QuickJS.newRuntime()
runtime.setMemoryLimit(memoryLimitBytes)
runtime.setMaxStackSize(maxStackBytes)

/** @type {{ reason: string, message: string } | null} */
let killed = null
let sliceStart = 0
let cpuUsed = 0
runtime.setInterruptHandler(() => {
  if (killed) return true
  const now = Date.now()
  if (now - sliceStart > sliceLimitMs) {
    killed = {
      reason: 'limit',
      message: `Script ran for more than ${sliceLimitMs} ms without awaiting the browser`,
    }
  } else if (cpuUsed + (now - sliceStart) > cpuBudgetMs) {
    killed = { reason: 'limit', message: `Script used more than ${cpuBudgetMs} ms of CPU time` }
  }
  return killed !== null
})

const context = runtime.newContext()
/** @type {Map<number, import('quickjs-emscripten-core').QuickJSDeferredPromise>} */
const pending = new Map()
let nextCall = 0
let nextStep = 0
/** URL of the page, refreshed with every answer of the main thread (`page.url()` is synchronous). */
let pageUrl = typeof init.url === 'string' && init.url ? init.url : 'about:blank'

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function enter(fn) {
  sliceStart = Date.now()
  try {
    return fn()
  } finally {
    cpuUsed += Date.now() - sliceStart
  }
}

let main = null

function settleIfDone() {
  if (killed) return finish({ ok: false, ...killed })
  if (!main) return
  const state = context.getPromiseState(main)
  if (state.type === 'fulfilled') {
    if (!state.notAPromise) state.value.dispose()
    finish({ ok: true })
  } else if (state.type === 'rejected') {
    const dumped = context.dump(state.error)
    state.error.dispose()
    finish({ ok: false, reason: 'error', message: guestErrorMessage(dumped) })
  }
}

function pump() {
  if (killed) return
  enter(() => {
    const result = runtime.executePendingJobs()
    if (result.error) {
      // An error escaping a job (not a rejection): the interrupt or an out-of-memory error.
      const dumped = context.dump(result.error)
      result.error.dispose()
      killed ??= { reason: 'limit', message: guestErrorMessage(dumped) }
    }
  })
  settleIfDone()
}

parentPort.on('message', (message) => {
  const deferred = pending.get(message.id)
  if (!deferred || killed || done) return
  pending.delete(message.id)
  if (typeof message.url === 'string') pageUrl = message.url
  if (message.ok) {
    const handle = context.newString(message.json)
    deferred.resolve(handle)
    handle.dispose()
  } else {
    const handle = context.newError(String(message.error))
    deferred.reject(handle)
    handle.dispose()
  }
  deferred.dispose()
  pump()
})

const hostFn = context.newFunction('__marmot_host', (opHandle, argsHandle) => {
  const op = context.getString(opHandle)
  const argsJson = argsHandle ? context.getString(argsHandle) : '[]'
  const id = nextCall++
  const deferred = context.newPromise()
  pending.set(id, deferred)
  parentPort.postMessage({ type: 'call', id, op, argsJson })
  return deferred.handle
})
context.setProp(context.global, '__marmot_host', hostFn)
hostFn.dispose()

const syncFn = context.newFunction('__marmot_sync', (opHandle, argsHandle) => {
  const op = context.getString(opHandle)
  const argsJson = argsHandle ? context.getString(argsHandle) : '[]'
  let value = null
  if (op === 'page.url') {
    value = pageUrl
  } else if (op === 'step.start' || op === 'step.end' || op === 'log') {
    if (op === 'step.start') value = nextStep++
    // Bookkeeping only: no answer is needed, so it is sent and the script carries on.
    parentPort.postMessage({ type: 'sync', op, argsJson, id: value, at: Date.now() })
  } else {
    throw context.newError(`Unknown operation "${op}"`)
  }
  return context.newString(JSON.stringify(value))
})
context.setProp(context.global, '__marmot_sync', syncFn)
syncFn.dispose()

const initHandle = context.newString(JSON.stringify(init))
context.setProp(context.global, '__marmot_init', initHandle)
initHandle.dispose()

const preludeResult = enter(() => context.evalCode(prelude, 'marmot-prelude.js'))
if (preludeResult.error) {
  const dumped = context.dump(preludeResult.error)
  preludeResult.error.dispose()
  finish({
    ok: false,
    reason: 'error',
    message: `Sandbox prelude failed: ${guestErrorMessage(dumped)}`,
  })
} else {
  preludeResult.value.dispose()
  // The script is the body of an async function; `__marmot_run` comes from the prelude.
  const wrapped = `__marmot_run(async () => {\n${source}\n})`
  const evaluated = enter(() => context.evalCode(wrapped, 'script.js'))
  if (evaluated.error) {
    const dumped = context.dump(evaluated.error)
    evaluated.error.dispose()
    finish(
      killed
        ? { ok: false, ...killed }
        : { ok: false, reason: 'error', message: guestErrorMessage(dumped) },
    )
  } else {
    main = evaluated.value
    pump()
  }
}
