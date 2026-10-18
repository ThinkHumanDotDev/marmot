/**
 * The browser script sandbox (#139) without a browser: escape attempts, limits and the bridge's
 * argument encoding. The browser-backed journeys are in `tests/int/browser-script-monitor.int.spec.ts`.
 */
import { describe, expect, it } from 'vitest'

import { GUEST_PRELUDE } from './prelude'
import { runInSandbox, type SandboxHost } from './sandbox'

interface Recorded {
  calls: { op: string; args: unknown[] }[]
  logs: string[]
}

function fakeHost(recorded: Recorded, overrides: Partial<SandboxHost> = {}): SandboxHost {
  return {
    async call(op, args) {
      recorded.calls.push({ op, args })
      if (op === 'sleep') {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(args[0]) || 0, 50)))
        return null
      }
      if (op === 'page' && args[0] === 'title') return 'Dashboard'
      if (op === 'locator' && args[1] === 'allTextContents') return ['Welcome, Ada']
      if (op === 'locator' && args[1] === 'isVisible') return true
      if (op === 'locator' && args[1] === 'count') return 1
      return null
    },
    note(op, args) {
      recorded.calls.push({ op, args })
      if (op === 'log') recorded.logs.push(String(args[1]))
    },
    url: () => 'https://example.com/dashboard',
    ...overrides,
  }
}

async function run(source: string, options: { timeoutMs?: number; host?: SandboxHost } = {}) {
  const recorded: Recorded = { calls: [], logs: [] }
  const outcome = await runInSandbox({
    prelude: GUEST_PRELUDE,
    source,
    init: { vars: { email: 'ada@example.com' }, secrets: { password: 'hunter22' }, url: '' },
    host: options.host ?? fakeHost(recorded),
    deadline: Date.now() + (options.timeoutMs ?? 5_000),
  })
  return { outcome, recorded }
}

/** Runs `expression` in the sandbox and returns what it evaluated to, as logged text. */
async function probe(expression: string): Promise<string> {
  const { outcome, recorded } = await run(
    `let value
     try { value = await (async () => (${expression}))() } catch (err) { value = 'threw: ' + (err && err.message) }
     console.log(typeof value === 'string' ? value : typeof value + ':' + String(value))`,
  )
  expect(outcome).toEqual({ ok: true })
  return recorded.logs[0] ?? ''
}

describe('browser script sandbox', () => {
  it('runs a script against the allow-listed API', async () => {
    const { outcome, recorded } = await run(`
      await test.step('log in', async () => {
        await page.goto(url || 'https://example.com/login')
        await page.getByLabel('Email').fill(vars.email)
        await page.getByLabel('Password').fill(secrets.password)
        await page.getByRole('button', { name: /sign in/i }).click()
      })
      await expect(page.getByText('Welcome')).toContainText('Welcome')
      await expect(page).toHaveTitle('Dashboard')
      expect(page.url()).toContain('/dashboard')
    `)
    expect(outcome).toEqual({ ok: true })
    const ops = recorded.calls.map((call) => call.op)
    expect(ops).toContain('step.start')
    expect(ops).toContain('step.end')
    const click = recorded.calls.find((call) => call.op === 'locator' && call.args[1] === 'click')
    // Locators travel as plain descriptions; regular expressions as source + flags.
    expect(click?.args[0]).toEqual([
      { m: 'getByRole', a: ['button', { name: { __re: ['sign in', 'i'] } }] },
    ])
    const fill = recorded.calls.find(
      (call) =>
        call.op === 'locator' && call.args[1] === 'fill' && call.args[2]?.toString() === 'hunter22',
    )
    expect(fill).toBeDefined()
  })

  it('fails with the assertion message when the expected text differs', async () => {
    const { outcome } = await run(
      `await expect(page.getByText('Welcome')).toHaveText('Goodbye', { timeout: 200 })`,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).toContain('toHaveText failed')
    expect(outcome.message).toContain('Expected: "Goodbye"')
    expect(outcome.message).toContain('Received: "Welcome, Ada"')
  })

  it('reports syntax errors as script errors', async () => {
    const { outcome } = await run('await page.goto(')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('error')
  })

  describe('escape attempts', () => {
    it('has no Node globals', async () => {
      expect(await probe(`typeof process`)).toBe('undefined')
      expect(await probe(`typeof require`)).toBe('undefined')
      expect(await probe(`typeof module`)).toBe('undefined')
      expect(await probe(`typeof Buffer`)).toBe('undefined')
      expect(await probe(`typeof global`)).toBe('undefined')
      expect(await probe(`typeof setTimeout`)).toBe('undefined')
      expect(await probe(`typeof fetch`)).toBe('undefined')
      expect(await probe(`typeof WebAssembly`)).toBe('undefined')
      expect(await probe(`typeof std`)).toBe('undefined')
      expect(await probe(`typeof os`)).toBe('undefined')
    })

    it('cannot reach the host through constructors', async () => {
      expect(await probe(`globalThis.constructor.constructor('return typeof process')()`)).toBe(
        'undefined',
      )
      expect(await probe(`(() => {}).constructor('return typeof require')()`)).toBe('undefined')
      expect(await probe(`page.goto.constructor('return typeof process')()`)).toBe('undefined')
      expect(
        await probe(
          `Object.getPrototypeOf(async function () {}).constructor('return typeof process')()`,
        ),
      ).toBe('undefined')
      expect(await probe(`expect.constructor.constructor('return this')() === globalThis`)).toBe(
        'boolean:true',
      )
      expect(await probe(`[].constructor.constructor('return this.process')()`)).toBe(
        'undefined:undefined',
      )
      expect(await probe(`eval('typeof process')`)).toBe('undefined')
    })

    it('cannot import modules', async () => {
      expect(
        await probe(`import('fs').then(() => 'imported', (err) => 'threw: ' + err.message)`),
      ).toMatch(/^threw: /)
      expect(
        await probe(`import('node:child_process').then(() => 'imported', () => 'refused')`),
      ).toBe('refused')
      expect(await probe(`import('os').then(() => 'imported', () => 'refused')`)).toBe('refused')
    })

    it('cannot call the raw bridge or unknown operations', async () => {
      expect(await probe(`typeof __marmot_host`)).toBe('undefined')
      expect(await probe(`typeof __marmot_sync`)).toBe('undefined')
      // Every operation still goes through the host's allow-list.
      const refusing = fakeHost(
        { calls: [], logs: [] },
        {
          async call(op, args) {
            throw new Error(`refused ${op} ${JSON.stringify(args[0])}`)
          },
        },
      )
      const { outcome } = await run(`await page.goto('file:///etc/passwd')`, { host: refusing })
      expect(outcome).toMatchObject({ ok: false, reason: 'error' })
    })

    it('cannot tamper with the API it was given', async () => {
      expect(await probe(`(page.goto = 1, typeof page.goto)`)).toBe('function')
      expect(await probe(`(globalThis.page = 1, typeof page)`)).toBe('object')
      expect(await probe(`(delete globalThis.expect, typeof expect)`)).toBe('function')
    })

    it('does not share state between runs', async () => {
      await run(`globalThis.leak = 'secret'`)
      expect(await probe(`typeof globalThis.leak`)).toBe('undefined')
    })
  })

  describe('limits', () => {
    it('kills a busy loop', async () => {
      const started = Date.now()
      const { outcome } = await run(`while (true) {}`, { timeoutMs: 10_000 })
      expect(outcome).toMatchObject({ ok: false, reason: 'limit' })
      expect(Date.now() - started).toBeLessThan(5_000)
    })

    it('cannot catch the interrupt', async () => {
      const { outcome } = await run(
        `for (;;) { try { while (true) {} } catch (err) { console.log('caught') } }`,
        { timeoutMs: 10_000 },
      )
      expect(outcome).toMatchObject({ ok: false, reason: 'limit' })
    })

    it('stops a script that never finishes at the timeout', async () => {
      const started = Date.now()
      const { outcome } = await run(`await new Promise(() => {})`, { timeoutMs: 500 })
      expect(outcome).toMatchObject({ ok: false, reason: 'timeout' })
      expect(Date.now() - started).toBeLessThan(2_000)
    })

    it('stops a script that keeps awaiting at the timeout', async () => {
      const { outcome } = await run(`for (;;) { await page.waitForTimeout(10) }`, {
        timeoutMs: 500,
      })
      expect(outcome).toMatchObject({ ok: false, reason: 'timeout' })
    })

    it('enforces the memory limit without blocking the worker', async () => {
      let ticks = 0
      const ticker = setInterval(() => ticks++, 50)
      const started = Date.now()
      const { outcome } = await run(
        `const chunks = []; for (;;) { chunks.push('x'.repeat(1024 * 1024) + chunks.length) }`,
        { timeoutMs: 3_000 },
      )
      clearInterval(ticker)
      expect(outcome.ok).toBe(false)
      // Either QuickJS reports the exhausted heap or the run is terminated at the deadline.
      if (!outcome.ok) expect(outcome.message).toMatch(/memory|timed out/i)
      expect(Date.now() - started).toBeLessThan(4_500)
      // The guest runs on its own thread: the worker's event loop kept turning meanwhile.
      expect(ticks).toBeGreaterThan(10)
    })

    it('enforces the stack limit', async () => {
      const { outcome } = await run(`const f = () => f(); f()`)
      expect(outcome.ok).toBe(false)
    })
  })
})
