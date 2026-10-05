/**
 * Monitor form schema, shared by the create/edit form (client) and the mutation route handlers
 * (server). Mirrors the `monitors` collection fields (`src/collections/Monitors.ts`) and adds the
 * per-type requirements Uptime Kuma enforces in `EditMonitor.vue`.
 *
 * Keep this module free of server-only imports: it is bundled into client components.
 */
import { z } from 'zod'

export const MONITOR_TYPE_NAMES = [
  'http',
  'keyword',
  'json-query',
  'port',
  'ping',
  'dns',
  'push',
  'group',
  'manual',
] as const
export type MonitorTypeName = (typeof MONITOR_TYPE_NAMES)[number]

export const HTTP_MONITOR_TYPES: readonly MonitorTypeName[] = ['http', 'keyword', 'json-query']
export const HOST_MONITOR_TYPES: readonly MonitorTypeName[] = ['port', 'ping', 'dns']

export const isHttpMonitorType = (type: string | undefined | null): boolean =>
  Boolean(type && (HTTP_MONITOR_TYPES as readonly string[]).includes(type))
export const isHostMonitorType = (type: string | undefined | null): boolean =>
  Boolean(type && (HOST_MONITOR_TYPES as readonly string[]).includes(type))

export type MonitorTypeGroup = 'general' | 'passive' | 'special'

export interface MonitorTypeOption {
  name: MonitorTypeName
  label: string
  description: string
}

/**
 * Type selector groups (General / Passive / Special). Labels match the registered monitor types in
 * `src/server/monitor-types/*`; the form prefers the registry's labels when the page passes them.
 */
export const MONITOR_TYPE_GROUPS: Record<
  MonitorTypeGroup,
  { label: string; types: MonitorTypeOption[] }
> = {
  general: {
    label: 'General',
    types: [
      { name: 'http', label: 'HTTP(s)', description: 'UP when the response status is accepted.' },
      {
        name: 'keyword',
        label: 'HTTP(s) - Keyword',
        description: 'UP when the response body contains (or lacks) a keyword.',
      },
      {
        name: 'json-query',
        label: 'HTTP(s) - Json Query',
        description: 'UP when a JSONata expression over the JSON response matches.',
      },
      { name: 'port', label: 'TCP Port', description: 'UP when a TCP connection succeeds.' },
      { name: 'ping', label: 'Ping', description: 'UP when the host answers ICMP echo requests.' },
      { name: 'dns', label: 'DNS', description: 'UP when the resolver returns a record.' },
    ],
  },
  passive: {
    label: 'Passive',
    types: [
      {
        name: 'push',
        label: 'Push',
        description: 'Your system calls a URL on a schedule; silence means DOWN.',
      },
      { name: 'manual', label: 'Manual', description: 'Status set by hand, never checked.' },
    ],
  },
  special: {
    label: 'Special',
    types: [
      {
        name: 'group',
        label: 'Group',
        description: 'Aggregates child monitors: DOWN when any child is down.',
      },
    ],
  },
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export const BODY_ENCODINGS = ['json', 'form', 'xml'] as const
export const AUTH_METHODS = ['none', 'basic', 'bearer', 'oauth2-cc', 'ntlm', 'mtls'] as const
export const OAUTH_AUTH_METHODS = ['client_secret_basic', 'client_secret_post'] as const
export const JSON_PATH_OPERATORS = ['==', '!=', '<', '>', '<=', '>=', 'contains'] as const
export const DNS_RECORD_TYPES = [
  'A',
  'AAAA',
  'CAA',
  'CNAME',
  'MX',
  'NS',
  'PTR',
  'SOA',
  'SRV',
  'TXT',
] as const
export const MANUAL_STATUSES = ['up', 'down', 'pending'] as const

/** Uptime Kuma's UI minimum for `interval` and `retryInterval`. */
export const MIN_INTERVAL_SECONDS = 20
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60 * 365

const STATUS_CODE_PATTERN = /^[1-5]\d{2}(-[1-5]\d{2})?$/

/** Accepts `200`, `200-299`, `304`; the ranges must be ascending. */
export const isValidStatusCodeRange = (value: string): boolean => {
  if (!STATUS_CODE_PATTERN.test(value)) return false
  const [from, to] = value.split('-').map(Number)
  return to === undefined || from <= to
}

/** `headers` is stored as text; it must be empty or a JSON object of string values. */
export const parseHeadersJson = (
  value: string | null | undefined,
): Record<string, string> | null => {
  if (!value || !value.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return null
    out[key] = String(raw)
  }
  return out
}

const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

const relationId = z
  .union([z.string().min(1), z.number().int().positive()])
  .nullish()
  .transform((v) => (v === undefined || v === '' ? null : v))

const nonNegativeInt = (max = 1_000_000) => z.number().int().min(0).max(max)

export const monitorFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(150),
    type: z.enum(MONITOR_TYPE_NAMES),
    description: optionalText(5000),
    parent: relationId,
    weight: nonNegativeInt().default(2000),
    active: z.boolean().default(true),

    // Target
    url: optionalText(2048),
    hostname: optionalText(253),
    port: z.number().int().min(1).max(65535).nullish(),

    // Timing
    interval: z
      .number()
      .int()
      .min(MIN_INTERVAL_SECONDS, `At least ${MIN_INTERVAL_SECONDS} seconds`)
      .max(MAX_INTERVAL_SECONDS),
    retryInterval: z
      .number()
      .int()
      .min(MIN_INTERVAL_SECONDS, `At least ${MIN_INTERVAL_SECONDS} seconds`)
      .max(MAX_INTERVAL_SECONDS),
    maxRetries: nonNegativeInt(1000),
    resendInterval: nonNegativeInt(100_000),
    timeout: z.number().min(0).max(MAX_INTERVAL_SECONDS),
    upsideDown: z.boolean().default(false),

    // HTTP
    method: z.enum(HTTP_METHODS).default('GET'),
    httpBodyEncoding: z.enum(BODY_ENCODINGS).default('json'),
    maxRedirects: nonNegativeInt(100).default(10),
    body: optionalText(100_000),
    headers: optionalText(20_000),
    acceptedStatusCodes: z
      .array(z.string().trim().min(1))
      .default(['200-299'])
      .refine((codes) => codes.every(isValidStatusCodeRange), {
        message: 'Use status codes or ranges such as 200-299 or 304',
      }),
    ignoreTls: z.boolean().default(false),
    expiryNotification: z.boolean().default(false),

    // Keyword / JSON query
    keyword: optionalText(1000),
    invertKeyword: z.boolean().default(false),
    jsonPath: optionalText(2000),
    jsonPathOperator: z.enum(JSON_PATH_OPERATORS).default('=='),
    expectedValue: optionalText(2000),

    // Authentication
    authMethod: z.enum(AUTH_METHODS).default('none'),
    basicAuthUser: optionalText(500),
    basicAuthPass: optionalText(500),
    authDomain: optionalText(500),
    authWorkstation: optionalText(500),
    bearerToken: optionalText(5000),
    oauthTokenUrl: optionalText(2048),
    oauthClientId: optionalText(500),
    oauthClientSecret: optionalText(2000),
    oauthScopes: optionalText(2000),
    oauthAuthMethod: z.enum(OAUTH_AUTH_METHODS).default('client_secret_basic'),
    tlsCert: optionalText(20_000),
    tlsKey: optionalText(20_000),
    tlsCa: optionalText(20_000),

    // DNS
    dnsResolveServer: optionalText(500),
    dnsResolveType: z.enum(DNS_RECORD_TYPES).default('A'),

    // Manual
    manualStatus: z.enum(MANUAL_STATUSES).nullish(),
  })
  .superRefine((values, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message })

    if (isHttpMonitorType(values.type)) {
      if (!values.url) issue('url', 'URL is required')
      else if (!/^https?:\/\/\S+$/i.test(values.url)) issue('url', 'Enter an http(s) URL')
      if (values.headers && !parseHeadersJson(values.headers)) {
        issue('headers', 'Headers must be a JSON object, e.g. {"X-Token": "abc"}')
      }
      if (values.httpBodyEncoding === 'json' && values.body) {
        try {
          JSON.parse(values.body)
        } catch {
          issue('body', 'Body must be valid JSON for the JSON encoding')
        }
      }
      if (values.acceptedStatusCodes.length === 0) {
        issue('acceptedStatusCodes', 'Add at least one accepted status code')
      }
      switch (values.authMethod) {
        case 'basic':
        case 'ntlm':
          if (!values.basicAuthUser) issue('basicAuthUser', 'Username is required')
          break
        case 'bearer':
          if (!values.bearerToken) issue('bearerToken', 'Token is required')
          break
        case 'oauth2-cc':
          if (!values.oauthTokenUrl) issue('oauthTokenUrl', 'Token URL is required')
          if (!values.oauthClientId) issue('oauthClientId', 'Client ID is required')
          if (!values.oauthClientSecret) issue('oauthClientSecret', 'Client secret is required')
          break
        case 'mtls':
          if (!values.tlsCert) issue('tlsCert', 'Client certificate is required')
          if (!values.tlsKey) issue('tlsKey', 'Private key is required')
          break
      }
    }

    if (values.type === 'keyword' && !values.keyword) issue('keyword', 'Keyword is required')
    if (values.type === 'json-query') {
      if (!values.jsonPath) issue('jsonPath', 'JSON query is required')
      if (values.expectedValue === null) issue('expectedValue', 'Expected value is required')
    }

    if (isHostMonitorType(values.type) && !values.hostname) {
      issue('hostname', 'Hostname is required')
    }
    if (values.type === 'port' && (values.port === null || values.port === undefined)) {
      issue('port', 'Port is required')
    }
    if (values.type === 'dns' && !values.dnsResolveType) {
      issue('dnsResolveType', 'Record type is required')
    }
    if (values.type === 'manual' && !values.manualStatus) {
      issue('manualStatus', 'Choose the status to report')
    }
  })

/** Validated form values (what the route handlers receive). */
export type MonitorFormValues = z.output<typeof monitorFormSchema>
/** Raw form values before coercion/defaults (what react-hook-form holds). */
export type MonitorFormInput = z.input<typeof monitorFormSchema>

/** Defaults for a fresh monitor of `type` (Uptime Kuma defaults). */
export function defaultMonitorValues(type: MonitorTypeName = 'http'): MonitorFormValues {
  return {
    name: '',
    type,
    description: null,
    parent: null,
    weight: 2000,
    active: true,
    url: isHttpMonitorType(type) ? 'https://' : null,
    hostname: null,
    port: type === 'dns' ? 53 : null,
    interval: 60,
    retryInterval: 60,
    maxRetries: 0,
    resendInterval: 0,
    timeout: 48,
    upsideDown: false,
    method: 'GET',
    httpBodyEncoding: 'json',
    maxRedirects: 10,
    body: null,
    headers: null,
    acceptedStatusCodes: ['200-299'],
    ignoreTls: false,
    expiryNotification: false,
    keyword: null,
    invertKeyword: false,
    jsonPath: null,
    jsonPathOperator: '==',
    expectedValue: null,
    authMethod: 'none',
    basicAuthUser: null,
    basicAuthPass: null,
    authDomain: null,
    authWorkstation: null,
    bearerToken: null,
    oauthTokenUrl: null,
    oauthClientId: null,
    oauthClientSecret: null,
    oauthScopes: null,
    oauthAuthMethod: 'client_secret_basic',
    tlsCert: null,
    tlsKey: null,
    tlsCa: null,
    dnsResolveServer: type === 'dns' ? '1.1.1.1' : null,
    dnsResolveType: 'A',
    manualStatus: type === 'manual' ? 'up' : null,
  }
}

/** Monitor document fields the form edits, in the shape `defaultMonitorValues` returns. */
export type MonitorLike = Partial<Record<keyof MonitorFormValues, unknown>> & {
  parent?: unknown
}

/**
 * Maps a stored monitor document to form values (relationships collapsed to ids, nulls kept so
 * the form is fully controlled).
 */
export function monitorToFormValues(doc: MonitorLike): MonitorFormValues {
  const type = MONITOR_TYPE_NAMES.includes(doc.type as MonitorTypeName)
    ? (doc.type as MonitorTypeName)
    : 'http'
  const base = defaultMonitorValues(type)
  const parent =
    doc.parent && typeof doc.parent === 'object' && 'id' in doc.parent
      ? ((doc.parent as { id: string | number }).id ?? null)
      : ((doc.parent as string | number | null | undefined) ?? null)

  const out: Record<string, unknown> = { ...base, parent }
  for (const key of Object.keys(base) as (keyof MonitorFormValues)[]) {
    if (key === 'parent') continue
    const value = doc[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out as MonitorFormValues
}

/** Seconds → "1 minute 30 seconds" style hint shown under interval inputs. */
export function humanDuration(totalSeconds: number | string | null | undefined): string {
  const seconds = Number(totalSeconds)
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ]
  const parts: string[] = []
  let rest = Math.round(seconds)
  for (const [size, label] of units) {
    const n = Math.floor(rest / size)
    if (n > 0) {
      parts.push(`${n} ${label}${n === 1 ? '' : 's'}`)
      rest -= n * size
    }
  }
  return parts.length ? parts.join(' ') : '0 seconds'
}
