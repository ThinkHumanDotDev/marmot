/**
 * Uptime Kuma backup JSON → import plan.
 *
 * Format (Uptime Kuma 1.x `Settings → Backup → Export`, `src/components/settings/Backup.vue`):
 *
 *   { version: "1.23.x",
 *     notificationList: [{ id, name, active, isDefault, config: "<JSON string>" }],
 *     monitorList: [<Monitor.toJSON()>, …] }
 *
 * The monitor objects are `Monitor.toJSON()` from `server/model/monitor.js` (snake_case columns
 * such as `accepted_statuscodes`, `maxretries`, `basic_auth_user` mixed with camelCase getters);
 * `notificationIDList` is `{ "<notificationId>": true }` and `tags` carries the tag assignments.
 * The import semantics (notifications first, de-duplicated by name; monitors created with their
 * notification links; tags matched by name) follow the removed `uploadBackup` socket handler of
 * `server/server.js` in Uptime Kuma 1.23 (MIT, Louis Lam). See THIRD_PARTY_NOTICES.md.
 *
 * Uptime Kuma 2.x no longer ships the backup feature, but it still exports the same monitor shape
 * through its socket API, so hand-made dumps of `monitorList` + `notificationList` work too.
 */
import {
  AUTH_METHODS,
  BODY_ENCODINGS,
  defaultMonitorValues,
  DNS_RECORD_TYPES,
  HTTP_METHODS,
  isValidStatusCodeRange,
  JSON_PATH_OPERATORS,
  MIN_INTERVAL_SECONDS,
  MONITOR_TYPE_NAMES,
  monitorFormSchema,
  OAUTH_AUTH_METHODS,
  type MonitorFormInput,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
import { NotificationConfigError, validateNotificationConfig } from '@/server/notifications/send'

import { mapKumaNotificationConfig } from './kuma-notifications'
import {
  asBool,
  asInt,
  asKey,
  asNumber,
  asString,
  asText,
  emptyPlan,
  ImportFormatError,
  isRecord,
  type ImportPlan,
  type PlannedMonitor,
  type PlannedNotification,
} from './types'

/** Monitor types that have the same name and semantics in Marmot. */
const SUPPORTED_TYPES = new Set<string>(MONITOR_TYPE_NAMES)

/** Human-readable names for Kuma monitor types Marmot does not have (for the report). */
const UNSUPPORTED_TYPE_LABELS: Record<string, string> = {
  'real-browser': 'HTTP(s) - Browser Engine',
  docker: 'Docker Container',
  steam: 'Steam Game Server',
  gamedig: 'GameDig',
  mqtt: 'MQTT',
  kafkaproducer: 'Kafka Producer',
  'kafka-producer': 'Kafka Producer',
  sqlserver: 'Microsoft SQL Server',
  postgres: 'PostgreSQL',
  mysql: 'MySQL/MariaDB',
  mongodb: 'MongoDB',
  radius: 'Radius',
  redis: 'Redis',
  'grpc-keyword': 'gRPC(s) - Keyword',
  'tailscale-ping': 'Tailscale Ping',
  snmp: 'SNMP',
  rabbitmq: 'RabbitMQ',
  smtp: 'SMTP',
  'websocket-upgrade': 'WebSocket Upgrade',
}

const oneOf = <T extends readonly string[]>(options: T, value: unknown): T[number] | undefined => {
  const s = asString(value)
  return s !== null && (options as readonly string[]).includes(s) ? (s as T[number]) : undefined
}

const issueList = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ')

/** Kuma `authMethod`: `null`/`""` means none. */
function mapAuthMethod(value: unknown): (typeof AUTH_METHODS)[number] | undefined {
  const s = asText(value)
  if (s === null) return 'none'
  return oneOf(AUTH_METHODS, s)
}

/**
 * Maps one `Monitor.toJSON()` object onto `monitorFormSchema` input. Returns `null` when the
 * monitor type does not exist in Marmot; schema violations are reported by the caller.
 */
function mapKumaMonitor(
  raw: Record<string, unknown>,
  warnings: string[],
): { input: MonitorFormInput; type: MonitorTypeName } | { skip: string } {
  const name = asText(raw.name) ?? `monitor #${asKey(raw.id) ?? '?'}`
  const kumaType = asText(raw.type) ?? 'http'
  if (!SUPPORTED_TYPES.has(kumaType)) {
    const label = UNSUPPORTED_TYPE_LABELS[kumaType] ?? kumaType
    return { skip: `Monitor type "${label}" is not supported by Marmot yet` }
  }
  const type = kumaType as MonitorTypeName
  const defaults = defaultMonitorValues(type)

  const interval = asInt(raw.interval) ?? defaults.interval
  const retryInterval = asInt(raw.retryInterval) ?? defaults.retryInterval
  const clamp = (field: 'interval' | 'retryInterval', value: number): number => {
    if (value >= MIN_INTERVAL_SECONDS) return value
    warnings.push(
      `"${name}": ${field} raised from ${value}s to the minimum of ${MIN_INTERVAL_SECONDS}s`,
    )
    return MIN_INTERVAL_SECONDS
  }

  const acceptedRaw = Array.isArray(raw.accepted_statuscodes)
    ? raw.accepted_statuscodes.map(asString).filter((s): s is string => s !== null)
    : null
  let acceptedStatusCodes = acceptedRaw ?? defaults.acceptedStatusCodes
  const invalidCodes = acceptedStatusCodes.filter((code) => !isValidStatusCodeRange(code))
  if (invalidCodes.length > 0) {
    warnings.push(`"${name}": ignored invalid accepted status codes ${invalidCodes.join(', ')}`)
    acceptedStatusCodes = acceptedStatusCodes.filter(isValidStatusCodeRange)
    if (acceptedStatusCodes.length === 0) acceptedStatusCodes = defaults.acceptedStatusCodes
  }

  const authMethod = mapAuthMethod(raw.authMethod)
  if (authMethod === undefined) {
    warnings.push(
      `"${name}": authentication method "${String(raw.authMethod)}" is not supported; set to none`,
    )
  }

  const input: MonitorFormInput = {
    ...defaults,
    name,
    type,
    description: asText(raw.description),
    parent: null,
    weight: asInt(raw.weight) ?? defaults.weight,
    active: asBool(raw.active) ?? true,

    url: asText(raw.url),
    hostname: asText(raw.hostname),
    port: asInt(raw.port) ?? defaults.port,

    interval: clamp('interval', interval),
    retryInterval: clamp('retryInterval', retryInterval),
    maxRetries: asInt(raw.maxretries) ?? defaults.maxRetries,
    resendInterval: asInt(raw.resendInterval) ?? defaults.resendInterval,
    timeout: asNumber(raw.timeout) ?? defaults.timeout,
    upsideDown: asBool(raw.upsideDown) ?? false,

    method: oneOf(HTTP_METHODS, raw.method) ?? defaults.method,
    httpBodyEncoding: oneOf(BODY_ENCODINGS, raw.httpBodyEncoding) ?? defaults.httpBodyEncoding,
    maxRedirects: asInt(raw.maxredirects) ?? defaults.maxRedirects,
    body: asText(raw.body),
    headers: asText(raw.headers),
    acceptedStatusCodes,
    ignoreTls: asBool(raw.ignoreTls) ?? false,
    expiryNotification: asBool(raw.expiryNotification) ?? false,
    domainExpiryNotification: asBool(raw.domainExpiryNotification) ?? false,

    keyword: asText(raw.keyword),
    invertKeyword: asBool(raw.invertKeyword) ?? false,
    jsonPath: asText(raw.jsonPath),
    jsonPathOperator: oneOf(JSON_PATH_OPERATORS, raw.jsonPathOperator) ?? defaults.jsonPathOperator,
    expectedValue: asString(raw.expectedValue),

    authMethod: authMethod ?? 'none',
    basicAuthUser: asText(raw.basic_auth_user),
    basicAuthPass: asText(raw.basic_auth_pass),
    authDomain: asText(raw.authDomain),
    authWorkstation: asText(raw.authWorkstation),
    bearerToken: asText(raw.bearer_token),
    oauthTokenUrl: asText(raw.oauth_token_url),
    oauthClientId: asText(raw.oauth_client_id),
    oauthClientSecret: asText(raw.oauth_client_secret),
    oauthScopes: asText(raw.oauth_scopes),
    oauthAuthMethod: oneOf(OAUTH_AUTH_METHODS, raw.oauth_auth_method) ?? defaults.oauthAuthMethod,
    tlsCert: asText(raw.tlsCert),
    tlsKey: asText(raw.tlsKey),
    tlsCa: asText(raw.tlsCa),

    dnsResolveServer: asText(raw.dns_resolve_server) ?? defaults.dnsResolveServer,
    dnsResolveType: oneOf(DNS_RECORD_TYPES, raw.dns_resolve_type) ?? defaults.dnsResolveType,

    manualStatus: type === 'manual' ? 'up' : null,
  }

  return { input, type }
}

/** `notificationIDList: { "3": true, "5": false }` → `["3"]`. */
function notificationKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asKey).filter((k): k is string => k !== null)
  if (!isRecord(value)) return []
  return Object.entries(value)
    .filter(([, enabled]) => asBool(enabled) === true)
    .map(([id]) => id)
}

/** `config` is a JSON string in backups and an object in live socket payloads. */
function parseNotificationConfig(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Parses an Uptime Kuma backup into an import plan. Pure: no database access. Throws
 * `ImportFormatError` when the JSON is not a backup at all.
 */
export function parseUptimeKumaBackup(json: unknown): ImportPlan {
  if (
    !isRecord(json) ||
    (!Array.isArray(json.monitorList) && !Array.isArray(json.notificationList))
  ) {
    throw new ImportFormatError(
      'Not an Uptime Kuma backup: expected a JSON object with "monitorList" and "notificationList".',
    )
  }
  const plan = emptyPlan('uptime-kuma')
  const version = asText(json.version)
  if (version) plan.warnings.push(`Uptime Kuma backup version ${version}`)

  // ---- Notifications -------------------------------------------------------------------------
  const notificationList = Array.isArray(json.notificationList) ? json.notificationList : []
  const seenNotificationNames = new Set<string>()
  notificationList.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) return
    const config = parseNotificationConfig(entry.config)
    const name =
      asText(entry.name) ?? (config ? asText(config.name) : null) ?? `notification #${index + 1}`
    if (!config) {
      plan.skipped.notifications.push({ name, reason: 'Notification config is not valid JSON' })
      return
    }
    const kumaType = asText(config.type)
    if (!kumaType) {
      plan.skipped.notifications.push({ name, reason: 'Notification has no provider type' })
      return
    }
    const mapped = mapKumaNotificationConfig(kumaType, config)
    if (!mapped) {
      plan.skipped.notifications.push({
        name,
        reason: `Notification provider "${kumaType}" is not supported by Marmot`,
      })
      return
    }
    try {
      mapped.config = validateNotificationConfig(mapped.type, mapped.config)
    } catch (error) {
      const reason =
        error instanceof NotificationConfigError && error.issues.length
          ? `Invalid ${mapped.type} settings: ${error.issues
              .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
              .join('; ')}`
          : `Invalid ${mapped.type} settings`
      plan.skipped.notifications.push({ name, reason })
      return
    }
    if (seenNotificationNames.has(name)) {
      plan.skipped.notifications.push({
        name,
        reason: 'Another notification in the file has the same name',
      })
      return
    }
    seenNotificationNames.add(name)
    const key = asKey(entry.id) ?? `n${index + 1}`
    const planned: PlannedNotification = {
      key,
      name,
      type: mapped.type,
      config: mapped.config,
      isDefault:
        asBool(entry.isDefault) ?? asBool(entry.is_default) ?? asBool(config.isDefault) ?? false,
      active: asBool(entry.active) ?? true,
    }
    plan.notifications.push(planned)
  })

  // ---- Monitors (two passes: collect keys, then resolve parents) -------------------------------
  const monitorList = Array.isArray(json.monitorList) ? json.monitorList : []
  const parentKeys = new Map<string, string | null>()
  const tagNames = new Map<string, number>()

  monitorList.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) return
    const key = asKey(entry.id) ?? `m${index + 1}`
    const mapped = mapKumaMonitor(entry, plan.warnings)
    const displayName = asText(entry.name) ?? key
    if ('skip' in mapped) {
      plan.skipped.monitors.push({ name: displayName, reason: mapped.skip })
      return
    }
    const parsed = monitorFormSchema.safeParse(mapped.input)
    if (!parsed.success) {
      plan.skipped.monitors.push({
        name: displayName,
        reason: `Invalid monitor: ${issueList(parsed.error.issues)}`,
      })
      return
    }
    if (Array.isArray(entry.tags)) {
      for (const tag of entry.tags) {
        if (!isRecord(tag)) continue
        const tagName = asText(tag.name) ?? `tag #${asKey(tag.tag_id) ?? asKey(tag.id) ?? '?'}`
        tagNames.set(tagName, (tagNames.get(tagName) ?? 0) + 1)
      }
    }
    const pushToken = mapped.type === 'push' ? asText(entry.pushToken) : null
    const planned: PlannedMonitor = {
      key,
      data: parsed.data,
      parentKey: asKey(entry.parent),
      notificationKeys: notificationKeys(entry.notificationIDList),
      pushToken,
    }
    parentKeys.set(key, planned.parentKey)
    plan.monitors.push(planned)
  })

  // Parents must be imported groups; anything else becomes a top-level monitor.
  const groupKeys = new Set(plan.monitors.filter((m) => m.data.type === 'group').map((m) => m.key))
  for (const monitor of plan.monitors) {
    if (monitor.parentKey !== null && !groupKeys.has(monitor.parentKey)) {
      plan.warnings.push(
        `"${monitor.data.name}": parent group #${monitor.parentKey} was not imported; the monitor is placed at the top level`,
      )
      monitor.parentKey = null
    }
  }
  // Notification links to skipped channels are dropped silently per link but reported once.
  const notificationKeySet = new Set(plan.notifications.map((n) => n.key))
  let droppedLinks = 0
  for (const monitor of plan.monitors) {
    const kept = monitor.notificationKeys.filter((k) => notificationKeySet.has(k))
    droppedLinks += monitor.notificationKeys.length - kept.length
    monitor.notificationKeys = kept
  }
  if (droppedLinks > 0) {
    plan.warnings.push(
      `${droppedLinks} monitor → notification link${droppedLinks === 1 ? '' : 's'} dropped because the notification was not imported`,
    )
  }

  // ---- Tags: not supported until the tags collection exists (#21) ----------------------------
  if (Array.isArray(json.tags)) {
    for (const tag of json.tags) {
      if (!isRecord(tag)) continue
      const tagName = asText(tag.name)
      if (tagName && !tagNames.has(tagName)) tagNames.set(tagName, 0)
    }
  }
  for (const [tagName, count] of tagNames) {
    plan.skipped.tags.push({
      name: tagName,
      reason:
        count > 0
          ? `Tags are not supported yet (${count} monitor assignment${count === 1 ? '' : 's'} skipped)`
          : 'Tags are not supported yet',
    })
  }
  if (tagNames.size > 0) {
    plan.warnings.push(
      `Skipped ${tagNames.size} tag${tagNames.size === 1 ? '' : 's'}: tags are not supported yet`,
    )
  }

  return plan
}
