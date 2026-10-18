/**
 * Scripted browser check (#139): runs a user-supplied Playwright script (`browserScript`) against the
 * remote browser the `real-browser` monitor uses (`remoteBrowser`). UP when the script finishes,
 * DOWN with the failing step or assertion otherwise. The script runs in an isolated QuickJS sandbox
 * on its own thread, never in the worker's JavaScript engine (`src/server/browser-script/`).
 *
 * The check reports per-step timing, console errors, failed requests and Web Vitals
 * (`ctx.browser`, stored on `heartbeats.browser`) and, on failure or always
 * (`browserArtifacts`), a screenshot and a Playwright trace (`ctx.artifacts`, stored in
 * `check-artifacts` by the worker).
 */
import {
  BROWSER_SCRIPT_TYPE,
  BROWSER_SCRIPT_VARIABLE_NAME,
  type BrowserArtifactMode,
} from '@/lib/browser-script'
import type { Monitor } from '@/payload-types'
import { runBrowserScript } from '@/server/browser-script/run'
import { assertHostLocalAllowed } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, loadOptionalDriver, requireField, withAbort } from './util'

type VariableRows = { name?: string | null; value?: string | null }[] | null | undefined

function collectVariables(rows: VariableRows): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows ?? []) {
    const name = row?.name?.trim()
    if (name && BROWSER_SCRIPT_VARIABLE_NAME.test(name)) out[name] = row.value ?? ''
  }
  return out
}

/** `vars` and `secrets` of the script from the monitor's variables and secrets. */
export function scriptVariables(monitor: Pick<Monitor, 'browserVariables' | 'browserSecrets'>): {
  vars: Record<string, string>
  secrets: Record<string, string>
} {
  return {
    vars: collectVariables(monitor.browserVariables),
    secrets: collectVariables(monitor.browserSecrets),
  }
}

registerMonitorType({
  name: BROWSER_SCRIPT_TYPE,
  label: 'Browser Script (Playwright)',
  group: 'general',
  async check(ctx) {
    // The browser resolves and connects on its own; while private addresses are denied, browser
    // checks are refused like the Browser Engine monitor (see docs/Security.md).
    assertHostLocalAllowed('The Browser Script monitor')
    const script = requireField(ctx.monitor.browserScript, 'Script')
    const remote = ctx.monitor.remoteBrowser?.trim()
    if (!remote) {
      throw new Error(
        'Remote browser URL is required: Marmot connects to a Playwright-compatible remote browser (ws://…) and does not launch Chromium itself.',
      )
    }
    const startUrl = ctx.monitor.url?.trim() || null
    const { chromium } = await loadOptionalDriver(
      () => import('playwright-core'),
      'playwright-core',
      'Browser Script',
    )
    const { vars, secrets } = scriptVariables(ctx.monitor)
    const run = await runBrowserScript({
      script,
      startUrl,
      vars,
      secrets,
      connect: (timeout) => withAbort(chromium.connect(remote, { timeout }), ctx.signal),
      ignoreTls: Boolean(ctx.monitor.ignoreTls),
      artifacts: (ctx.monitor.browserArtifacts ?? 'failure') as BrowserArtifactMode,
      timeoutMs: checkTimeoutMs(ctx.monitor),
      signal: ctx.signal,
    })
    ctx.browser = run.details
    ctx.artifacts = run.files
    ctx.heartbeat.ping = run.durationMs
    // Assertion messages span lines (expected / received); the heartbeat message is one line.
    if (!run.ok) throw new Error((run.error ?? 'Script failed').replace(/\s*\n\s*/g, ' · '))
    const steps = run.details.steps.filter((step) => step.depth === 0).length
    ctx.heartbeat.msg = steps > 0 ? `Passed (${steps} steps)` : 'Passed'
    ctx.heartbeat.status = 'up'
  },
})
