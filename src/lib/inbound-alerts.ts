/**
 * Inbound alert integrations (#152): the pure rules shared by the ingestion endpoint, the inbound
 * email path, the collections and the settings UI. Nothing here touches the database, the network
 * or the clock.
 *
 * An integration receives alerts from an external system (Prometheus Alertmanager, Grafana alerting,
 * any JSON sender, or email) at `POST /api/inbound/<token>` or `<token>@INBOUND_EMAIL_DOMAIN`. Each
 * payload is parsed into normalised alerts (`InboundAlert`): a dedup key, `firing` or `resolved`, a
 * title and the fields rules can match (labels, annotations, tags, top-level JSON values, or the
 * subject and body of a message). The first rule that matches an alert decides what happens.
 */

export const INTEGRATION_FORMATS = ['alertmanager', 'grafana', 'generic'] as const
export type IntegrationFormat = (typeof INTEGRATION_FORMATS)[number]

export const isIntegrationFormat = (value: unknown): value is IntegrationFormat =>
  typeof value === 'string' && (INTEGRATION_FORMATS as readonly string[]).includes(value)

export const ALERT_STATUSES = ['firing', 'resolved'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export const RULE_MATCH_OPERATORS = ['equals', 'contains', 'regex'] as const
export type RuleMatchOperator = (typeof RULE_MATCH_OPERATORS)[number]

/** What a matching rule does with the incident side: nothing, a draft (declared) incident, or a public one. */
export const RULE_INCIDENT_MODES = ['none', 'draft', 'publish'] as const
export type RuleIncidentMode = (typeof RULE_INCIDENT_MODES)[number]

/** Impacts a rule may set on a component (never `operational`: that is what resolving restores). */
export const RULE_IMPACTS = ['degraded_performance', 'partial_outage', 'major_outage'] as const
export type RuleImpact = (typeof RULE_IMPACTS)[number]

export const INTEGRATION_EVENT_SOURCES = ['webhook', 'email'] as const
export type IntegrationEventSource = (typeof INTEGRATION_EVENT_SOURCES)[number]

/** What happened to one alert of a payload (the event log's `results[].outcome`). */
export const ALERT_OUTCOMES = [
  'opened',
  'resolved',
  'duplicate',
  'unmatched',
  'unknown',
  'error',
] as const
export type AlertOutcome = (typeof ALERT_OUTCOMES)[number]

/** Token scheme: `mi` + 40 lowercase hex characters (safe in URLs and as an email local part). */
export const INTEGRATION_TOKEN_PATTERN = /^mi[0-9a-f]{40}$/
export const isIntegrationToken = (value: string): boolean => INTEGRATION_TOKEN_PATTERN.test(value)
/** Characters of the token kept in clear (`tokenPrefix`) so people can tell integrations apart. */
export const INTEGRATION_TOKEN_PREFIX_LENGTH = 10

/** Alerts read from one payload; the rest is ignored (and counted in the event log). */
export const MAX_ALERTS_PER_PAYLOAD = 100
export const ALERT_TITLE_MAX_LENGTH = 200
export const ALERT_DESCRIPTION_MAX_LENGTH = 2_000
export const ALERT_DEDUP_KEY_MAX_LENGTH = 200
export const ALERT_FIELD_MAX_LENGTH = 500
export const ALERT_FIELDS_MAX = 50
export const RULE_PATTERN_MAX_LENGTH = 200
export const MAX_RULES = 50
/** Characters of the (redacted) payload kept in the event log. */
export const EVENT_PAYLOAD_MAX_LENGTH = 16_000
/** Event log rows kept per integration. */
export const EVENTS_PER_INTEGRATION = 100

export const DEFAULT_GENERIC_MAPPING = {
  alertsPath: '',
  titlePath: 'title',
  statusPath: 'status',
  severityPath: 'severity',
  dedupKeyPath: 'id',
  descriptionPath: 'message',
  resolvedValues: 'resolved,ok,recovered,closed,inactive',
} as const

export interface GenericMapping {
  /** Path of an array of alerts; empty = the payload is one alert (or a top-level array). */
  alertsPath?: string | null
  titlePath?: string | null
  statusPath?: string | null
  severityPath?: string | null
  dedupKeyPath?: string | null
  descriptionPath?: string | null
  /** Comma-separated status values meaning "resolved" (case-insensitive). */
  resolvedValues?: string | null
}

export interface InboundAlert {
  dedupKey: string
  status: AlertStatus
  title: string
  description: string | null
  severity: string | null
  /** Values rules can match, by name (labels, annotations, tags, JSON fields, email parts). */
  fields: Record<string, string>
}

export interface ParsedPayload {
  alerts: InboundAlert[]
  /** Alerts beyond `MAX_ALERTS_PER_PAYLOAD`, dropped. */
  dropped: number
}

export interface InboundRule {
  id?: string | null
  name?: string | null
  enabled?: boolean | null
  /** Field to match; blank matches the title and the description. */
  matchField?: string | null
  matchOperator?: RuleMatchOperator | null
  /** Blank matches every alert. */
  matchValue?: string | null
}

export interface InboundEmailMessage {
  subject?: string | null
  text?: string | null
  from?: string | null
}

const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const scalar = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * Value at `path` in `value`: dot-separated keys with optional `[n]` indexes and an optional `$.`
 * prefix (a JSONPath subset: `$.alert.labels.service`, `items[0].id`). Blank paths return `undefined`.
 */
export function valueAtPath(value: unknown, path: string | null | undefined): unknown {
  const trimmed = path?.trim().replace(/^\$\.?/, '') ?? ''
  if (!trimmed) return undefined
  let current: unknown = value
  for (const part of trimmed.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part)
    if (!match) return undefined
    if (match[1]) {
      if (!isRecord(current)) return undefined
      current = current[match[1]]
    }
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined
      current = current[Number(index[1])]
    }
  }
  return current
}

/** FNV-1a (64-bit, hex): a short, stable key for alerts that carry none. Not a security hash. */
export function stableHash(input: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

function addFields(target: Record<string, string>, source: unknown, prefix = ''): void {
  if (!isRecord(source)) return
  for (const [key, raw] of Object.entries(source)) {
    if (Object.keys(target).length >= ALERT_FIELDS_MAX) return
    const value = scalar(raw)
    if (value !== null) target[`${prefix}${key}`] = cut(value, ALERT_FIELD_MAX_LENGTH)
  }
}

function makeAlert(input: {
  dedupKey: string | null
  status: AlertStatus
  title: string | null
  description?: string | null
  severity?: string | null
  fields: Record<string, string>
}): InboundAlert {
  const title = cut(input.title?.replace(/\s+/g, ' ').trim() || 'Alert', ALERT_TITLE_MAX_LENGTH)
  const fields = { ...input.fields }
  const key = input.dedupKey?.trim() || stableHash(JSON.stringify(Object.entries(fields).sort()))
  return {
    dedupKey: cut(key, ALERT_DEDUP_KEY_MAX_LENGTH),
    status: input.status,
    title,
    description: input.description?.trim()
      ? cut(input.description.trim(), ALERT_DESCRIPTION_MAX_LENGTH)
      : null,
    severity: input.severity?.trim() ? cut(input.severity.trim(), 50) : null,
    fields,
  }
}

function capped(alerts: InboundAlert[]): ParsedPayload {
  return {
    alerts: alerts.slice(0, MAX_ALERTS_PER_PAYLOAD),
    dropped: Math.max(0, alerts.length - MAX_ALERTS_PER_PAYLOAD),
  }
}

/**
 * Prometheus Alertmanager webhook (`version: "4"`), also sent by Grafana unified alerting: one
 * alert per `alerts[]` entry, keyed by its `fingerprint` (else its labels). Labels and annotations
 * are matchable fields, `annotations.summary` (else `alertname`) is the title.
 */
function parseAlertmanagerAlerts(body: Record<string, unknown>): InboundAlert[] {
  const alerts = Array.isArray(body.alerts) ? body.alerts : []
  const groupStatus = scalar(body.status)
  return alerts.filter(isRecord).map((entry) => {
    const labels = isRecord(entry.labels) ? entry.labels : {}
    const annotations = isRecord(entry.annotations) ? entry.annotations : {}
    const fields: Record<string, string> = {}
    addFields(fields, labels)
    addFields(fields, annotations)
    const status = (scalar(entry.status) ?? groupStatus) === 'resolved' ? 'resolved' : 'firing'
    const labelKey = Object.entries(labels)
      .map(([key, value]) => `${key}=${scalar(value) ?? ''}`)
      .sort()
      .join(',')
    return makeAlert({
      dedupKey: scalar(entry.fingerprint) || (labelKey ? stableHash(labelKey) : null),
      status,
      title:
        scalar(annotations.summary) ??
        scalar(annotations.title) ??
        scalar(labels.alertname) ??
        scalar(body.title),
      description: scalar(annotations.description) ?? scalar(annotations.message),
      severity: scalar(labels.severity),
      fields,
    })
  })
}

/**
 * Grafana alerting: unified alerting posts the Alertmanager shape (plus `title`/`state`); legacy
 * dashboard alerts post `{ ruleId, ruleName, state: alerting|ok|no_data|paused, message, tags }`.
 */
function parseGrafana(body: Record<string, unknown>): InboundAlert[] {
  if (Array.isArray(body.alerts)) return parseAlertmanagerAlerts(body)
  const fields: Record<string, string> = {}
  addFields(fields, body.tags)
  for (const key of ['ruleName', 'ruleId', 'state', 'dashboardId', 'panelId', 'orgId']) {
    const value = scalar(body[key])
    if (value !== null) fields[key] = cut(value, ALERT_FIELD_MAX_LENGTH)
  }
  const state = scalar(body.state)?.toLowerCase()
  return [
    makeAlert({
      dedupKey: scalar(body.ruleId) ?? scalar(body.ruleName),
      status: state === 'ok' || state === 'paused' ? 'resolved' : 'firing',
      title: scalar(body.ruleName) ?? scalar(body.title),
      description: scalar(body.message),
      severity: null,
      fields,
    }),
  ]
}

const resolvedSet = (values: string | null | undefined): Set<string> =>
  new Set(
    (values ?? DEFAULT_GENERIC_MAPPING.resolvedValues)
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )

const mappingPath = (mapping: GenericMapping, key: keyof GenericMapping): string => {
  const value = mapping[key]
  return value === null || value === undefined ? DEFAULT_GENERIC_MAPPING[key] : value
}

/** Any JSON: the mapping's paths name the title, status, severity, dedup key and description. */
function parseGeneric(body: unknown, mapping: GenericMapping): InboundAlert[] {
  const listPath = mappingPath(mapping, 'alertsPath')
  const listed = listPath ? valueAtPath(body, listPath) : body
  const entries = Array.isArray(listed) ? listed : [listed]
  const resolved = resolvedSet(mapping.resolvedValues)
  return entries.filter(isRecord).map((entry) => {
    const fields: Record<string, string> = {}
    addFields(fields, entry)
    for (const [key, value] of Object.entries(entry)) {
      if (isRecord(value)) addFields(fields, value, `${key}.`)
    }
    const statusValue = scalar(valueAtPath(entry, mappingPath(mapping, 'statusPath')))
    return makeAlert({
      dedupKey: scalar(valueAtPath(entry, mappingPath(mapping, 'dedupKeyPath'))),
      status: statusValue && resolved.has(statusValue.trim().toLowerCase()) ? 'resolved' : 'firing',
      title: scalar(valueAtPath(entry, mappingPath(mapping, 'titlePath'))),
      description: scalar(valueAtPath(entry, mappingPath(mapping, 'descriptionPath'))),
      severity: scalar(valueAtPath(entry, mappingPath(mapping, 'severityPath'))),
      fields,
    })
  })
}

/** Parse a JSON webhook body in `format`. Throws on a body that is not a JSON object or array. */
export function parseInboundPayload(
  format: IntegrationFormat,
  body: unknown,
  mapping: GenericMapping = {},
): ParsedPayload {
  if (format === 'generic') {
    if (!isRecord(body) && !Array.isArray(body)) throw new Error('payload must be JSON')
    return capped(parseGeneric(body, mapping))
  }
  if (!isRecord(body)) throw new Error('payload must be a JSON object')
  return capped(format === 'grafana' ? parseGrafana(body) : parseAlertmanagerAlerts(body))
}

/** Default word that marks a message as the recovery of an alert. */
export const DEFAULT_EMAIL_RESOLVED_KEYWORD = 'resolved'

/**
 * The subject without status markers (`[FIRING:2]`, `[RESOLVED]`, `Re:`, `Fwd:`) and the resolved
 * keyword, so the alert and its recovery share a dedup key.
 */
export function emailAlertTitle(subject: string, resolvedKeyword: string): string {
  let title = subject.replace(/\s+/g, ' ').trim()
  for (;;) {
    const next = title
      .replace(/^(re|fw|fwd)\s*:\s*/i, '')
      .replace(/^\[[^\]]{0,40}\]\s*/, '')
      .trim()
    if (next === title) break
    title = next
  }
  const keyword = resolvedKeyword.trim()
  if (keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    title = title
      .replace(new RegExp(`^\\W*${escaped}\\W*`, 'i'), '')
      .replace(new RegExp(`\\W*${escaped}\\W*$`, 'i'), '')
      .trim()
  }
  return title || subject.trim()
}

/**
 * One alert from an email: the subject is the title, `resolvedKeyword` in the subject marks the
 * recovery, and the cleaned subject is the dedup key. Rules match `subject`, `from` and `body`.
 */
export function parseInboundEmail(
  mail: InboundEmailMessage,
  resolvedKeyword: string | null | undefined,
): InboundAlert {
  const keyword = resolvedKeyword?.trim() || DEFAULT_EMAIL_RESOLVED_KEYWORD
  const subject = mail.subject?.replace(/\s+/g, ' ').trim() || '(no subject)'
  const text = (mail.text ?? '').trim()
  const title = emailAlertTitle(subject, keyword)
  const resolved = subject.toLowerCase().includes(keyword.toLowerCase())
  return makeAlert({
    dedupKey: `email:${stableHash(title.toLowerCase())}`,
    status: resolved ? 'resolved' : 'firing',
    title,
    description: text || null,
    severity: null,
    fields: {
      subject: cut(subject, ALERT_FIELD_MAX_LENGTH),
      from: cut(mail.from ?? '', ALERT_FIELD_MAX_LENGTH),
      body: cut(text, ALERT_DESCRIPTION_MAX_LENGTH),
    },
  })
}

/** The regex of a rule, or `null` when it does not compile (or is too long). */
export function ruleRegex(pattern: string): RegExp | null {
  if (pattern.length > RULE_PATTERN_MAX_LENGTH) return null
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/** Whether `rule` matches `alert` (disabled rules never match). */
export function ruleMatches(rule: InboundRule, alert: InboundAlert): boolean {
  if (rule.enabled === false) return false
  const expected = rule.matchValue?.trim() ?? ''
  if (!expected) return true
  const field = rule.matchField?.trim()
  const haystacks = field
    ? field in alert.fields
      ? [alert.fields[field]]
      : field === 'title'
        ? [alert.title]
        : []
    : [alert.title, alert.description ?? '']
  const operator = rule.matchOperator ?? 'equals'
  if (operator === 'regex') {
    const regex = ruleRegex(expected)
    return regex !== null && haystacks.some((value) => regex.test(value.slice(0, 2_000)))
  }
  const needle = expected.toLowerCase()
  return haystacks.some((value) =>
    operator === 'contains'
      ? value.toLowerCase().includes(needle)
      : value.trim().toLowerCase() === needle,
  )
}

/** The first rule matching `alert`, or `undefined`. */
export const matchRule = <R extends InboundRule>(
  rules: readonly R[],
  alert: InboundAlert,
): R | undefined => rules.find((rule) => ruleMatches(rule, alert))

const SECRET_KEY =
  /secret|token|passw|api[-_]?key|authori[sz]ation|signature|cookie|session|credential|private/i

/** A copy of `value` with secret-looking keys replaced by `[redacted]` (for the event log). */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[…]'
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : redactSecrets(item, depth + 1),
      ]),
    )
  }
  return value
}

/** The redacted payload as stored in the event log (pretty JSON, cut at `EVENT_PAYLOAD_MAX_LENGTH`). */
export function eventPayloadText(value: unknown): string {
  const text =
    typeof value === 'string' ? value : (JSON.stringify(redactSecrets(value), null, 2) ?? '')
  return text.length > EVENT_PAYLOAD_MAX_LENGTH
    ? `${text.slice(0, EVENT_PAYLOAD_MAX_LENGTH)}…`
    : text
}

/** What the API and the UI show of an integration (never the token). */
export interface IntegrationRow {
  id: string
  name: string
  format: IntegrationFormat
  active: boolean
  tokenPrefix: string
  generic: GenericMapping
  emailResolvedKeyword: string
  rules: {
    id: string
    name: string
    enabled: boolean
    matchField: string
    matchOperator: RuleMatchOperator
    matchValue: string
    updateComponent: boolean
    statusPage: string | null
    component: string | null
    impact: RuleImpact
    incident: RuleIncidentMode
    severity: 'critical' | 'major' | 'minor'
    monitor: string | null
  }[]
  lastEventAt: string | null
  createdAt: string
}

export interface IntegrationEventRow {
  id: string
  receivedAt: string
  source: IntegrationEventSource
  alertCount: number
  droppedCount: number
  payload: string
  results: unknown
}

/** Status pages (with their components) and push monitors a rule can point at. */
export interface IntegrationChoices {
  statusPages: { id: string; title: string; components: { id: string; name: string }[] }[]
  pushMonitors: { id: string; name: string }[]
}
