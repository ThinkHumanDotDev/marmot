/**
 * Multi-step API check (#138): an ordered list of HTTP requests (`monitors.httpSuite`, see
 * `src/lib/validation/http-suite.ts`) where values stored from one response (`store`) are used by
 * later steps as `{{ vars.<name> }}` / `{{ steps.<key>.<name> }}`, next to static `vars` and
 * `secrets`.
 *
 * Every step goes through the HTTP monitor's request path (`sendHttpRequest`: outbound address
 * guard, proxy, TLS options, redirects, timing) and is judged like an HTTP monitor
 * (`judgeHttpResponse`: accepted status codes or `status` assertions, then the #96 assertions).
 * After the first failure the remaining steps are skipped except the cleanup steps (`alwaysRun`).
 * The monitor's timeout covers the whole suite. The check is DOWN when any executed step failed,
 * with a message naming it (`step 2 "get profile": status 401`).
 *
 * Secrets — suite secrets, values stored with `secret: true` and every credential or header value a
 * step sent — are scrubbed from the stored step results, the response log and the message. The list
 * grows while the suite runs, so everything is re-scrubbed with the full list after each step.
 */
import { performance } from 'node:perf_hooks'

import type { AssertionResult, MonitorAssertion } from '@/lib/validation/assertions'
import {
  parseHttpSuite,
  referenceLabel,
  stepLabel,
  SUITE_PLACEHOLDER,
  type HttpSuiteStep,
  type SuiteStepOutcome,
  type SuiteStepResult,
} from '@/lib/validation/http-suite'
import type { Monitor } from '@/payload-types'

import { evaluateJsonata, headerValue, jsonResultToString } from './assertions'
import { judgeHttpResponse, sendHttpRequest, type HttpCheckResponse } from './http-request'
import { registerMonitorType } from './registry'
import { captureResponse, requestSecrets, scrub, secretList } from './response-capture'
import type { MonitorCheckContext } from './types'

/** A placeholder whose value is not available (a cleanup step after the step that stores it failed). */
class UnresolvedReferenceError extends Error {
  constructor(readonly label: string) {
    super(`${label} is not available`)
    this.name = 'UnresolvedReferenceError'
  }
}

type Encoder = (value: string) => string

const raw: Encoder = (value) => value
/** Inside a JSON string literal (a bare `{{ … }}` holding a number stays valid too). */
const jsonEncoder: Encoder = (value) => JSON.stringify(value).slice(1, -1)

/** Values a step can reference, filled as the suite runs. */
class SuiteScope {
  readonly vars = new Map<string, string>()
  readonly secrets = new Map<string, string>()
  readonly steps = new Map<string, Map<string, string>>()
  /** Values to scrub from everything stored. */
  readonly secretValues = new Set<string>()

  render(text: string, encode: Encoder = raw): string {
    return text.replace(
      SUITE_PLACEHOLDER,
      (_match, scope: string, name: string, field?: string) => {
        const value =
          scope === 'secrets'
            ? field
              ? undefined
              : this.secrets.get(name)
            : scope === 'vars'
              ? field
                ? undefined
                : this.vars.get(name)
              : field
                ? this.steps.get(name)?.get(field)
                : undefined
        if (value === undefined) {
          throw new UnresolvedReferenceError(
            referenceLabel({ scope: scope as 'vars', name, field: field ?? null }),
          )
        }
        return encode(value)
      },
    )
  }

  renderOptional(text: string | null, encode: Encoder = raw): string | null {
    return text === null ? null : this.render(text, encode)
  }
}

/** A value stored from a response: `header:<name>`, `status`, `body` or a JSONata expression. */
async function extractValue(from: string, response: HttpCheckResponse): Promise<string | null> {
  const header = /^header:\s*(.+)$/i.exec(from)
  if (header) return headerValue(response.headers, header[1]!)
  if (from === 'status') return String(response.statusCode)
  if (from === 'body') return response.body
  let data: unknown
  try {
    data = JSON.parse(response.body)
  } catch {
    data = response.body
  }
  try {
    return jsonResultToString(await evaluateJsonata(from, data))
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : ((err as { message?: string } | null)?.message ?? String(err))
    throw new Error(`invalid expression ${JSON.stringify(from)}: ${message}`)
  }
}

/** The step as an HTTP monitor document, so the HTTP request path can send it unchanged. */
function stepMonitor(
  monitor: Monitor,
  step: HttpSuiteStep,
  scope: SuiteScope,
): { doc: Monitor; url: string; assertions: MonitorAssertion[] } {
  const bodyEncoder: Encoder =
    step.bodyEncoding === 'json'
      ? jsonEncoder
      : step.bodyEncoding === 'form'
        ? encodeURIComponent
        : raw
  const url = scope.render(step.url, encodeURI)
  const headers: Record<string, string> = {}
  for (const header of step.headers) headers[header.name] = scope.render(header.value)
  const assertions = step.assertions.map((assertion) => ({
    ...assertion,
    target: scope.renderOptional(assertion.target ?? null),
    value: scope.renderOptional(assertion.value ?? null),
  }))
  const doc = {
    ...monitor,
    type: 'http',
    url,
    method: step.method,
    body: scope.renderOptional(step.body, bodyEncoder),
    httpBodyEncoding: step.bodyEncoding,
    headers: step.headers.length > 0 ? JSON.stringify(headers) : null,
    authMethod: step.authMethod,
    basicAuthUser: scope.renderOptional(step.basicAuthUser),
    basicAuthPass: scope.renderOptional(step.basicAuthPass),
    bearerToken: scope.renderOptional(step.bearerToken),
    oauthClientSecret: null,
    acceptedStatusCodes: step.acceptedStatusCodes,
    assertions,
  } as Monitor
  return { doc, url, assertions }
}

/** What a step did, before secrets are scrubbed. */
interface StepRun {
  step: HttpSuiteStep
  url: string
  outcome: SuiteStepOutcome
  statusCode: number | null
  start: number
  duration: number
  timing: Record<string, number | null> | null
  msg: string
  assertions: AssertionResult[]
  stored: string[]
}

const scrubResult = (result: AssertionResult, secrets: readonly string[]): AssertionResult => ({
  ...result,
  target: result.target === null ? null : scrub(result.target, secrets),
  expected: result.expected === null ? null : scrub(result.expected, secrets),
  actual: result.actual === null ? null : scrub(result.actual, secrets),
  ...(result.error ? { error: scrub(result.error, secrets) } : {}),
})

/** Failure text of a judged step: `status 401`, or the first failed assertion. */
function failureText(
  judgement: Awaited<ReturnType<typeof judgeHttpResponse>>,
  response: HttpCheckResponse,
): string {
  const failed = judgement.failed
  if (failed && failed.legacy && failed.kind === 'status') return `status ${response.statusCode}`
  return judgement.failures[0] ?? 'failed'
}

export async function runHttpSuite(ctx: MonitorCheckContext): Promise<void> {
  const suite = parseHttpSuite(ctx.monitor.httpSuite)
  if (!suite || suite.steps.length === 0) throw new Error('The suite has no steps')

  const scope = new SuiteScope()
  for (const row of suite.vars) scope.vars.set(row.name, row.value)
  for (const row of suite.secrets) {
    scope.secrets.set(row.name, row.value)
    scope.secretValues.add(row.value)
  }

  const runs: StepRun[] = []
  /** Response shown in the response log: the failing step's, else the last executed step's. */
  let shown: { response: HttpCheckResponse; requestHeaders?: Record<string, string> } | null = null
  let failure: { index: number; label: string; message: string } | null = null
  const startedAt = performance.now()
  const since = () => Math.round(performance.now() - startedAt)

  /** Store the scrubbed results on the context (again after every step: a timeout keeps them). */
  const publish = () => {
    const secrets = secretList(scope.secretValues)
    ctx.steps = runs.map((run): SuiteStepResult => ({
      key: run.step.key,
      name: scrub(stepLabel(run.step), secrets),
      method: run.step.method,
      url: scrub(run.url, secrets),
      outcome: run.outcome,
      alwaysRun: run.step.alwaysRun,
      statusCode: run.statusCode,
      start: run.start,
      duration: run.duration,
      timing: run.timing,
      msg: scrub(run.msg, secrets),
      assertions: run.assertions.map((result) => scrubResult(result, secrets)),
      stored: run.stored,
    }))
    ctx.response = shown ? captureResponse(shown.response, secrets) : null
    ctx.heartbeat.statusCode = shown ? shown.response.statusCode : null
    return secrets
  }

  for (const [index, step] of suite.steps.entries()) {
    const label = stepLabel(step)
    const base = {
      step,
      url: step.url,
      statusCode: null,
      start: since(),
      duration: 0,
      timing: null,
      assertions: [],
      stored: [],
    }
    if (failure && !step.alwaysRun) {
      runs.push({
        ...base,
        outcome: 'skipped',
        msg: `skipped after step ${failure.index + 1} failed`,
      })
      continue
    }
    if (ctx.signal.aborted) {
      runs.push({ ...base, outcome: 'skipped', msg: 'skipped: the suite timed out' })
      continue
    }

    let rendered: ReturnType<typeof stepMonitor>
    try {
      rendered = stepMonitor(ctx.monitor, step, scope)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof UnresolvedReferenceError && failure) {
        // A cleanup step that needs a value the failed step never stored has nothing to clean up.
        runs.push({ ...base, outcome: 'skipped', msg: `skipped: ${message}` })
      } else {
        runs.push({ ...base, outcome: 'failed', msg: message })
        failure ??= { index, label, message }
      }
      publish()
      continue
    }

    const run: StepRun = { ...base, url: rendered.url, outcome: 'failed', msg: '' }
    runs.push(run)
    const start = performance.now()
    try {
      const sent = await sendHttpRequest(ctx, rendered.doc)
      // Steps may talk to several hosts: no single certificate to track for expiry.
      ctx.tlsInfo = null
      run.duration = Math.round(performance.now() - start)
      run.statusCode = sent.response.statusCode
      run.timing = sent.timing ? { ...sent.timing } : null
      for (const secret of requestSecrets(sent.requestHeaders, rendered.doc)) {
        scope.secretValues.add(secret)
      }
      if (!failure) shown = sent

      const judgement = await judgeHttpResponse(sent.response, {
        assertions: rendered.assertions,
        acceptedStatusCodes: step.acceptedStatusCodes,
      })
      run.assertions = judgement.results
      if (judgement.failures.length > 0) {
        run.msg = failureText(judgement, sent.response)
      } else {
        const values = new Map<string, string>()
        for (const row of step.store) {
          const value = await extractValue(row.from, sent.response)
          if (value === null) {
            run.msg = `could not store ${row.name}: ${JSON.stringify(row.from)} matched nothing`
            break
          }
          values.set(row.name, value)
          if (row.secret) scope.secretValues.add(value)
        }
        if (!run.msg) {
          for (const [name, value] of values) scope.vars.set(name, value)
          scope.steps.set(step.key, values)
          run.stored = [...values.keys()]
          run.outcome = 'passed'
          run.msg = judgement.msg
        }
      }
    } catch (err) {
      ctx.tlsInfo = null
      run.duration = Math.round(performance.now() - start)
      const aborted =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      run.msg = aborted
        ? 'timeout by AbortSignal'
        : err instanceof Error
          ? err.message
          : String(err)
    }
    if (run.outcome === 'failed' && !failure) {
      failure = { index, label, message: run.msg }
      // A step that got no response leaves nothing to show (not the previous step's response).
      if (run.statusCode === null) shown = null
    }
    publish()
  }

  const secrets = publish()
  ctx.heartbeat.ping = since()
  if (failure) {
    throw new Error(
      scrub(
        `step ${failure.index + 1} ${JSON.stringify(failure.label)}: ${failure.message}`,
        secrets,
      ),
    )
  }
  const count = suite.steps.length
  ctx.heartbeat.msg = `${count} step${count === 1 ? '' : 's'} passed`
}

registerMonitorType({
  name: 'http-suite',
  label: 'HTTP(s) - Multi-step API',
  group: 'general',
  async check(ctx) {
    await runHttpSuite(ctx)
    ctx.heartbeat.status = 'up'
  },
})
