/**
 * Checkly → import plan (#283), read through the public API v1
 * (https://developers.checklyhq.com, `https://api.checklyhq.com/v1`,
 * `Authorization: Bearer <key>` and `X-Checkly-Account: <account id>`):
 *
 * - `GET /checks` → every check of the account, paginated with `page` / `limit` (100 at most)
 *
 * API checks become HTTP monitors with their request (method, URL and query parameters, headers,
 * body, basic auth, redirects, TLS) and assertions; URL monitors become HTTP monitors, TCP monitors
 * port monitors and ICMP monitors ping monitors. Browser, multistep, Playwright, heartbeat and the
 * other check types have no Marmot equivalent and are skipped with a reason. Checkly has no status
 * pages to import here: its checks are the monitors.
 */
import type { ImportResource } from '@/lib/import-export'
import {
  assertionProblems,
  type AssertionComparator,
  type AssertionKind,
  type MonitorAssertion,
} from '@/lib/validation/assertions'
import {
  defaultMonitorValues,
  HTTP_METHODS,
  MAX_DEGRADED_AFTER_MS,
  MIN_INTERVAL_SECONDS,
  type MonitorFormInput,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'

import type { ImportText } from '../text'
import { asBool, asInt, asKey, asText, emptyPlan, isRecord, type ImportPlan } from '../types'
import {
  MAX_PAGES,
  ProviderError,
  providerClient,
  type FetchLike,
  type ProviderClient,
} from './fetch'
import { issueList, type Credentials, type ImportProvider } from './shared'

export const CHECKLY_API = 'https://api.checklyhq.com/v1'
const PER_PAGE = 100
const ACCOUNT_ID = /^[0-9a-f-]{8,64}$/i

type Json = Record<string, unknown>

export interface ChecklySnapshot {
  checks: Json[]
}

async function list(client: ProviderClient, path: string): Promise<Json[]> {
  const items: Json[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await client.get(`${path}?limit=${PER_PAGE}&page=${page}`)
    if (!Array.isArray(body)) throw new ProviderError('invalidResponse')
    items.push(...body.filter(isRecord))
    if (body.length < PER_PAGE) break
  }
  return items
}

/** Check types Marmot has an equivalent for. */
const CHECK_TYPES: Record<string, MonitorTypeName> = {
  API: 'http',
  URL: 'http',
  TCP: 'port',
  ICMP: 'ping',
}

const UNSUPPORTED_LABELS: Record<string, string> = {
  BROWSER: 'Browser',
  MULTI_STEP: 'Multistep',
  PLAYWRIGHT: 'Playwright Check Suite',
  HEARTBEAT: 'Heartbeat',
  AGENTIC: 'Agentic',
  DNS: 'DNS',
  GRPC: 'gRPC',
  SSL: 'SSL',
  TRACEROUTE: 'Traceroute',
}

/** Checkly resolves `{{VARIABLE}}` from its environment variables; Marmot cannot. */
const usesVariables = (value: string | null): boolean => value !== null && value.includes('{{')

const ASSERTION_KINDS: Record<string, AssertionKind> = {
  STATUS_CODE: 'status',
  HEADERS: 'header',
  TEXT_BODY: 'textBody',
  JSON_BODY: 'jsonBody',
}

const COMPARATORS: Record<string, AssertionComparator> = {
  EQUALS: 'eq',
  NOT_EQUALS: 'not_eq',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'not_contains',
  LESS_THAN: 'lt',
  GREATER_THAN: 'gt',
  IS_EMPTY: 'empty',
  NOT_EMPTY: 'not_empty',
}

/**
 * A simple JSONPath (`$.data[0].status`) as the JSONata expression Marmot evaluates
 * (`data[0].status`); anything else (filters, wildcards, recursive descent) has no safe
 * translation.
 */
function jsonataOf(path: string): string | null {
  const trimmed = path.trim()
  if (trimmed === '$') return '$'
  if (!/^\$(\.[A-Za-z_][\w]*|\[\d+\])+$/.test(trimmed)) return null
  return trimmed.slice(1).replace(/^\./, '')
}

/** Checkly assertions → Marmot assertions; the ones without an equivalent are counted. */
function mapAssertions(value: unknown): { assertions: MonitorAssertion[]; dropped: number } {
  const assertions: MonitorAssertion[] = []
  let dropped = 0
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isRecord(raw)) continue
    const kind = ASSERTION_KINDS[String(raw.source)]
    const comparator = COMPARATORS[String(raw.comparison)]
    // A regex extracts part of the value before comparing it: no Marmot equivalent.
    if (!kind || !comparator || asText(raw.regex)) {
      dropped += 1
      continue
    }
    const property = asText(raw.property)
    const target =
      kind === 'header' ? property : kind === 'jsonBody' ? jsonataOf(property ?? '$') : null
    if ((kind === 'header' || kind === 'jsonBody') && !target) {
      dropped += 1
      continue
    }
    const row: MonitorAssertion = {
      kind,
      target,
      comparator,
      value: comparator === 'empty' || comparator === 'not_empty' ? null : asText(raw.target),
    }
    if (assertionProblems([row], 'http').length > 0) {
      dropped += 1
      continue
    }
    assertions.push(row)
  }
  return { assertions, dropped }
}

function headersJson(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const entries = value.filter(isRecord).flatMap((row) => {
    const name = asText(row.key)
    return name ? [[name.trim(), asText(row.value) ?? ''] as const] : []
  })
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null
}

/** The request URL with Checkly's separate query parameters appended. */
function urlWithQuery(url: string | null, params: unknown): string | null {
  if (!url || !Array.isArray(params) || params.length === 0) return url
  try {
    const parsed = new URL(url)
    for (const row of params.filter(isRecord)) {
      const key = asText(row.key)
      if (key) parsed.searchParams.append(key, asText(row.value) ?? '')
    }
    return parsed.toString()
  } catch {
    return url
  }
}

/** Check interval in seconds: `frequency` minutes, or `frequencyOffset` seconds below a minute. */
function intervalOf(check: Json): number | null {
  const minutes = asInt(check.frequency)
  if (minutes === null) return null
  if (minutes > 0) return minutes * 60
  const seconds = asInt(check.frequencyOffset)
  return seconds !== null && seconds > 0 ? seconds : null
}

/** Checkly's retry strategy → retries before a monitor is DOWN, and the pause between them. */
function retriesOf(check: Json, interval: number): { maxRetries: number; retryInterval: number } {
  const strategy = isRecord(check.retryStrategy) ? check.retryStrategy : null
  const type = strategy ? String(strategy.type ?? '').toUpperCase() : 'NO_RETRIES'
  if (!strategy || type === 'NO_RETRIES') return { maxRetries: 0, retryInterval: interval }
  const retries = type === 'SINGLE_RETRY' ? 1 : (asInt(strategy.maxRetries) ?? 1)
  const backoff = asInt(strategy.baseBackoffSeconds)
  return {
    maxRetries: Math.min(Math.max(retries, 0), 10),
    retryInterval: backoff !== null ? Math.max(backoff, MIN_INTERVAL_SECONDS) : interval,
  }
}

const BODY_ENCODINGS: Record<string, MonitorFormInput['httpBodyEncoding']> = {
  JSON: 'json',
  FORM: 'form',
}

function mapCheck(
  check: Json,
  name: string,
  warnings: string[],
  t: ImportText,
): { input: MonitorFormInput } | { skip: string } {
  const sourceType = String(check.checkType ?? '').toUpperCase()
  const type = CHECK_TYPES[sourceType]
  if (!type) {
    return {
      skip: t('monitorTypeUnsupported', {
        type: UNSUPPORTED_LABELS[sourceType] ?? (sourceType || '?'),
      }),
    }
  }
  const request = isRecord(check.request) ? check.request : {}
  const defaults = defaultMonitorValues(type)
  const url = type === 'http' ? urlWithQuery(asText(request.url), request.queryParameters) : null
  const hostname = type === 'http' ? null : asText(request.hostname)
  if (usesVariables(url) || usesVariables(hostname)) return { skip: t('providerVariables') }

  let interval = intervalOf(check) ?? defaults.interval
  if (interval < MIN_INTERVAL_SECONDS) {
    warnings.push(
      t('intervalRaised', { name, field: 'interval', value: interval, min: MIN_INTERVAL_SECONDS }),
    )
    interval = MIN_INTERVAL_SECONDS
  }
  const maxResponseTime = asInt(check.maxResponseTime)
  const timeout =
    maxResponseTime !== null && maxResponseTime > 0
      ? Math.max(1, Math.ceil(maxResponseTime / 1000))
      : defaults.timeout
  const degraded = asInt(check.degradedResponseTime)

  const { assertions, dropped } =
    type === 'http' ? mapAssertions(request.assertions) : { assertions: [], dropped: 0 }
  const otherAssertions =
    type === 'http' ? 0 : (Array.isArray(request.assertions) ? request.assertions : []).length
  if (dropped + otherAssertions > 0) {
    warnings.push(t('assertionsDropped', { name, count: dropped + otherAssertions }))
  }
  if (
    asText(check.localSetupScript) ||
    asText(check.localTearDownScript) ||
    asKey(check.setupSnippetId) ||
    asKey(check.tearDownSnippetId)
  ) {
    warnings.push(t('scriptsDropped', { name }))
  }
  const headers = type === 'http' ? headersJson(request.headers) : null
  const body = sourceType === 'API' ? asText(request.body) : null
  if (usesVariables(headers) || usesVariables(body)) {
    warnings.push(t('variablesKept', { name }))
  }

  const method = asText(request.method)?.toUpperCase()
  const basicAuth = isRecord(request.basicAuth) ? request.basicAuth : null
  const basicUser = basicAuth ? asText(basicAuth.username) : null

  return {
    input: {
      ...defaults,
      name,
      type,
      active: asBool(check.activated) ?? true,
      upsideDown: asBool(check.shouldFail) ?? false,
      url,
      hostname,
      port: type === 'port' ? (asInt(request.port) ?? defaults.port) : defaults.port,
      interval,
      ...retriesOf(check, interval),
      timeout: Math.min(timeout, interval),
      degradedAfter:
        degraded !== null && degraded > 0 && degraded <= MAX_DEGRADED_AFTER_MS ? degraded : null,
      method:
        sourceType === 'API' && (HTTP_METHODS as readonly string[]).includes(method ?? '')
          ? (method as MonitorFormInput['method'])
          : defaults.method,
      body,
      httpBodyEncoding:
        BODY_ENCODINGS[String(request.bodyType ?? '').toUpperCase()] ?? defaults.httpBodyEncoding,
      headers,
      maxRedirects: asBool(request.followRedirects) === false ? 0 : defaults.maxRedirects,
      ignoreTls: asBool(request.skipSSL) ?? false,
      assertions,
      authMethod: basicUser ? 'basic' : defaults.authMethod,
      basicAuthUser: basicUser,
      basicAuthPass: basicUser && basicAuth ? asText(basicAuth.password) : null,
    },
  }
}

export const checklyProvider: ImportProvider<ChecklySnapshot> = {
  label: 'Checkly',

  async fetch(
    credentials: Credentials,
    resources: ReadonlySet<ImportResource>,
    fetchImpl: FetchLike,
  ) {
    const apiKey = credentials.apiKey?.trim()
    const accountId = credentials.accountId?.trim()
    if (!apiKey || !accountId || !ACCOUNT_ID.test(accountId)) {
      throw new ProviderError('credentials')
    }
    if (!resources.has('monitors')) return { checks: [] }
    const client = providerClient(fetchImpl, CHECKLY_API, {
      authorization: `Bearer ${apiKey}`,
      'x-checkly-account': accountId,
    })
    return { checks: await list(client, '/checks') }
  },

  plan(snapshot, resources, t) {
    const plan: ImportPlan = emptyPlan('checkly')
    if (!resources.has('monitors')) return plan
    for (const check of snapshot.checks) {
      const name =
        asText(check.name) ?? t('unnamed', { kind: 'monitor', id: String(check.id ?? '?') })
      const mapped = mapCheck(check, name, plan.warnings, t)
      if ('skip' in mapped) {
        plan.skipped.monitors.push({ name, reason: mapped.skip })
        continue
      }
      const parsed = monitorFormSchema.safeParse(mapped.input)
      if (!parsed.success) {
        plan.skipped.monitors.push({
          name,
          reason: t('invalidMonitor', { issues: issueList(parsed.error.issues) }),
        })
        continue
      }
      plan.monitors.push({
        key: `check:${String(check.id)}`,
        data: parsed.data,
        parentKey: null,
        notificationKeys: [],
        pushToken: null,
      })
    }
    return plan
  },
}
