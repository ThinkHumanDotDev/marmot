/**
 * Monitor form schema, shared by the create/edit form (client) and the mutation route handlers
 * (server). Mirrors the `monitors` collection fields (`src/collections/Monitors.ts`) and adds the
 * per-type requirements Uptime Kuma enforces in `EditMonitor.vue`.
 *
 * Keep this module free of server-only imports: it is bundled into client components.
 */
import { z } from 'zod'

import type { Messages } from '@/i18n/messages'
import { DOCKER_CONTAINER_PATTERN } from '@/lib/monitor-resources'
import { isValidCronPattern, MAX_PUSH_SECONDS, PUSH_SCHEDULE_TYPES } from '@/lib/push-schedule'
import { isValidTimezone, SAME_AS_SERVER } from '@/lib/validation/maintenance'

/** Key of a validation message under `monitors.validation` in the catalogues. */
export type MonitorValidationKey = keyof Messages['monitors']['validation']

/** Resolves a validation message (a next-intl translator scoped to `monitors.validation`). */
export type MonitorValidationMessage = (
  key: MonitorValidationKey,
  values?: Record<string, string | number>,
) => string

export const MONITOR_TYPE_NAMES = [
  // General
  'http',
  'keyword',
  'json-query',
  'port',
  'ping',
  'dns',
  'real-browser',
  // Passive
  'push',
  'manual',
  'docker',
  // Special
  'group',
  // Protocols
  'grpc-keyword',
  'websocket-upgrade',
  'mqtt',
  'kafka-producer',
  'rabbitmq',
  'smtp',
  'snmp',
  'ntp',
  'sftp',
  'radius',
  'tailscale-ping',
  // Databases
  'mysql',
  'postgres',
  'sqlserver',
  'mongodb',
  'redis',
  // Game servers
  'steam',
  'gamedig',
] as const
export type MonitorTypeName = (typeof MONITOR_TYPE_NAMES)[number]

/** Types that perform a plain HTTP request (method, body, status codes, auth). */
export const HTTP_MONITOR_TYPES: readonly MonitorTypeName[] = ['http', 'keyword', 'json-query']
/** Types whose target is `url` (HTTP types plus WebSocket and browser checks). */
export const URL_MONITOR_TYPES: readonly MonitorTypeName[] = [
  ...HTTP_MONITOR_TYPES,
  'websocket-upgrade',
  'real-browser',
]
/** Types whose target is `hostname` (and usually `port`). */
export const HOST_MONITOR_TYPES: readonly MonitorTypeName[] = [
  'port',
  'ping',
  'dns',
  'mqtt',
  'smtp',
  'snmp',
  'ntp',
  'sftp',
  'radius',
  'tailscale-ping',
  'steam',
  'gamedig',
]
/** Host types that also take a port. */
export const PORT_MONITOR_TYPES: readonly MonitorTypeName[] = HOST_MONITOR_TYPES.filter(
  (t) => t !== 'ping' && t !== 'tailscale-ping',
)
/** Types configured with a driver connection string. */
export const DATABASE_MONITOR_TYPES: readonly MonitorTypeName[] = [
  'mysql',
  'postgres',
  'sqlserver',
  'mongodb',
  'redis',
]
/** Types that look for `keyword` in a response. */
export const KEYWORD_MONITOR_TYPES: readonly MonitorTypeName[] = ['keyword', 'grpc-keyword']
/** Types that can evaluate a JSONata expression over their result. */
export const JSON_QUERY_MONITOR_TYPES: readonly MonitorTypeName[] = [
  'json-query',
  'mongodb',
  'snmp',
  'mqtt',
]

/** Default `port` for the host types that have a well-known one. */
export const DEFAULT_PORTS: Partial<Record<MonitorTypeName, number>> = {
  dns: 53,
  mqtt: 1883,
  smtp: 25,
  snmp: 161,
  ntp: 123,
  sftp: 22,
  radius: 1812,
  steam: 27015,
}

const includes = (list: readonly MonitorTypeName[], type: string | undefined | null): boolean =>
  Boolean(type && (list as readonly string[]).includes(type))

export const isHttpMonitorType = (type: string | undefined | null): boolean =>
  includes(HTTP_MONITOR_TYPES, type)
export const isUrlMonitorType = (type: string | undefined | null): boolean =>
  includes(URL_MONITOR_TYPES, type)
export const isHostMonitorType = (type: string | undefined | null): boolean =>
  includes(HOST_MONITOR_TYPES, type)
export const isPortMonitorType = (type: string | undefined | null): boolean =>
  includes(PORT_MONITOR_TYPES, type)
export const isDatabaseMonitorType = (type: string | undefined | null): boolean =>
  includes(DATABASE_MONITOR_TYPES, type)
export const isKeywordMonitorType = (type: string | undefined | null): boolean =>
  includes(KEYWORD_MONITOR_TYPES, type)

export type MonitorTypeGroup = 'general' | 'passive' | 'specific' | 'database' | 'game' | 'special'

export interface MonitorTypeOption {
  name: MonitorTypeName
  label: string
  description: string
}

/**
 * Type selector groups. Labels match the registered monitor types in `src/server/monitor-types/*`;
 * the form prefers the registry's labels when the page passes them.
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
      {
        name: 'real-browser',
        label: 'HTTP(s) - Browser Engine (Chrome/Chromium)',
        description:
          'Loads the page in a real Chromium through a remote Playwright browser; UP on a 2xx/3xx navigation.',
      },
      { name: 'port', label: 'TCP Port', description: 'UP when a TCP connection succeeds.' },
      { name: 'ping', label: 'Ping', description: 'UP when the host answers ICMP echo requests.' },
      { name: 'dns', label: 'DNS', description: 'UP when the resolver returns a record.' },
      {
        name: 'docker',
        label: 'Docker Container',
        description: 'UP when the container is running (and healthy, if it has a health check).',
      },
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
  specific: {
    label: 'Protocols',
    types: [
      {
        name: 'grpc-keyword',
        label: 'gRPC(s) - Keyword',
        description: 'Calls a unary gRPC method and looks for a keyword in the response.',
      },
      {
        name: 'websocket-upgrade',
        label: 'WebSocket Upgrade',
        description: 'Opens a WebSocket and judges the close code (default 1000).',
      },
      {
        name: 'mqtt',
        label: 'MQTT',
        description: 'Subscribes to a topic and checks the first message received.',
      },
      {
        name: 'kafka-producer',
        label: 'Kafka Producer',
        description: 'Produces a message to a topic; UP when the brokers acknowledge it.',
      },
      {
        name: 'rabbitmq',
        label: 'RabbitMQ',
        description: 'Queries the management API health check of each node.',
      },
      {
        name: 'smtp',
        label: 'SMTP',
        description: 'Connects to a mail server and verifies the handshake.',
      },
      {
        name: 'snmp',
        label: 'SNMP',
        description: 'Reads an OID over SNMP v1/v2c and optionally compares its value.',
      },
      {
        name: 'ntp',
        label: 'NTP',
        description: 'Queries a time server and checks stratum, offset and dispersion.',
      },
      {
        name: 'sftp',
        label: 'SFTP',
        description: 'Logs in over SFTP and optionally checks that a path exists.',
      },
      {
        name: 'radius',
        label: 'Radius',
        description: 'Sends an Access-Request; UP unless the server rejects it.',
      },
      {
        name: 'tailscale-ping',
        label: 'Tailscale Ping',
        description: 'Runs `tailscale ping` on the worker host.',
      },
    ],
  },
  database: {
    label: 'Databases',
    types: [
      {
        name: 'mysql',
        label: 'MySQL/MariaDB',
        description: 'Connects and runs a query (default SELECT 1).',
      },
      {
        name: 'postgres',
        label: 'PostgreSQL',
        description: 'Connects and runs a query (default SELECT 1).',
      },
      {
        name: 'sqlserver',
        label: 'Microsoft SQL Server',
        description: 'Connects and runs a query (default SELECT 1).',
      },
      {
        name: 'mongodb',
        label: 'MongoDB',
        description: 'Connects and runs a command (default ping), optionally checking the result.',
      },
      { name: 'redis', label: 'Redis', description: 'Connects and sends PING.' },
    ],
  },
  game: {
    label: 'Game servers',
    types: [
      {
        name: 'steam',
        label: 'Steam Game Server',
        description: 'Looks the server up in the Steam master list (needs a Steam API key).',
      },
      {
        name: 'gamedig',
        label: 'GameDig',
        description: 'Queries a game server with the GameDig protocol library.',
      },
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
      {
        name: 'docker',
        label: 'Docker Container',
        description: 'UP while a container on a Docker host is running (and healthy).',
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
export const MQTT_CHECK_TYPES = ['keyword', 'json-query'] as const
export const SNMP_VERSIONS = ['1', '2c'] as const
export const SMTP_SECURITY_MODES = ['opportunistic', 'starttls', 'secure', 'nostarttls'] as const
export const SSH_AUTH_METHODS = ['password', 'privateKey'] as const

/** Uptime Kuma's UI minimum for `interval` and `retryInterval`. */
export const MIN_INTERVAL_SECONDS = 20
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60 * 365

/** HTTP status codes (`200`, `200-299`) and WebSocket close codes (`1000`, `4000-4999`). */
const STATUS_CODE_PATTERN = /^([1-5]\d{2}|[1-4]\d{3})(-([1-5]\d{2}|[1-4]\d{3}))?$/

/** Accepts `200`, `200-299`, `304`, `1000`; the ranges must be ascending. */
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

/** Is `value` empty or a JSON object (not an array)? */
export const isJsonObjectText = (value: string | null | undefined): boolean => {
  if (!value || !value.trim()) return true
  try {
    const parsed: unknown = JSON.parse(value)
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
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

/** `monitors.tags` row: a tag of the organization plus an optional value (`env: prod`). */
const tagRow = z.object({
  tag: z.union([z.string().min(1), z.number().int().positive()]),
  value: optionalText(200),
})

const nonNegativeInt = (max = 1_000_000) => z.number().int().min(0).max(max)

/** List of non-empty strings (brokers, nodes); blanks are dropped. */
const textList = (max = 500) =>
  z
    .array(z.string().trim().max(max))
    .nullish()
    .transform((list) => (list ?? []).filter((v) => v.length > 0))

/**
 * Builds the schema with validation messages from `message`: the form passes its translator so
 * errors appear in the user's language; the route handlers and imports use the English
 * `monitorFormSchema` from `./monitor-schema` (kept apart so the catalogue stays out of the client).
 */
export function createMonitorFormSchema(message: MonitorValidationMessage) {
  return z
    .object({
      name: z.string().trim().min(1, message('nameRequired')).max(150),
      type: z.enum(MONITOR_TYPE_NAMES),
      /** Name on status pages (and, later, subscriber messages) instead of `name`. */
      publicName: optionalText(150),
      description: optionalText(5000),
      parent: relationId,
      weight: nonNegativeInt().default(2000),
      active: z.boolean().default(true),
      tags: z.array(tagRow).max(50).default([]),
      /** Notification channels alerted on important beats (`monitors.notifications`). */
      notifications: z
        .array(z.union([z.string().min(1), z.number().int().positive()]))
        .max(100)
        .default([]),

      // Target
      url: optionalText(2048),
      hostname: optionalText(253),
      port: z.number().int().min(1).max(65535).nullish(),

      // Timing
      interval: z
        .number()
        .int()
        .min(MIN_INTERVAL_SECONDS, message('intervalMin', { min: MIN_INTERVAL_SECONDS }))
        .max(MAX_INTERVAL_SECONDS),
      retryInterval: z
        .number()
        .int()
        .min(MIN_INTERVAL_SECONDS, message('intervalMin', { min: MIN_INTERVAL_SECONDS }))
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
          message: message('statusCodes'),
        }),
      ignoreTls: z.boolean().default(false),
      expiryNotification: z.boolean().default(false),
      proxy: relationId,
      domainExpiryNotification: z.boolean().default(false),

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

      // Push schedule
      pushSchedule: z.enum(PUSH_SCHEDULE_TYPES).default('interval'),
      pushCron: optionalText(200),
      pushTimezone: z
        .string()
        .trim()
        .max(100)
        .nullish()
        .transform((v) => v || SAME_AS_SERVER)
        .refine(isValidTimezone, message('timezoneInvalid')),
      pushGrace: z.number().int().min(0).max(MAX_PUSH_SECONDS).nullish().default(null),
      pushMaxDuration: z.number().int().min(1).max(MAX_PUSH_SECONDS).nullish().default(null),

      // Manual
      manualStatus: z.enum(MANUAL_STATUSES).nullish(),

      // Docker
      dockerHost: relationId,
      dockerContainer: optionalText(255),

      // Databases
      databaseConnectionString: optionalText(2048),
      databaseQuery: optionalText(20_000),

      // MQTT
      mqttTopic: optionalText(1000),
      mqttUsername: optionalText(500),
      mqttPassword: optionalText(500),
      mqttCheckType: z.enum(MQTT_CHECK_TYPES).default('keyword'),
      mqttSuccessMessage: optionalText(2000),

      // Kafka producer
      kafkaProducerBrokers: textList(),
      kafkaProducerTopic: optionalText(500),
      kafkaProducerMessage: optionalText(20_000),
      kafkaProducerSsl: z.boolean().default(false),
      kafkaProducerAllowAutoTopicCreation: z.boolean().default(false),
      kafkaProducerSaslOptions: optionalText(5000),

      // gRPC
      grpcUrl: optionalText(2048),
      grpcProtobuf: optionalText(100_000),
      grpcServiceName: optionalText(500),
      grpcMethod: optionalText(500),
      grpcEnableTls: z.boolean().default(false),
      grpcBody: optionalText(100_000),
      grpcMetadata: optionalText(20_000),

      // RADIUS
      radiusUsername: optionalText(500),
      radiusPassword: optionalText(500),
      radiusSecret: optionalText(500),
      radiusCalledStationId: optionalText(500),
      radiusCallingStationId: optionalText(500),

      // SNMP
      snmpOid: optionalText(500),
      snmpVersion: z.enum(SNMP_VERSIONS).default('2c'),
      snmpCommunity: optionalText(500),

      // SMTP
      smtpSecurity: z.enum(SMTP_SECURITY_MODES).default('opportunistic'),

      // SFTP
      sshUsername: optionalText(500),
      sshAuthMethod: z.enum(SSH_AUTH_METHODS).default('password'),
      sshPassword: optionalText(500),
      sshPrivateKey: optionalText(20_000),
      sshPassphrase: optionalText(500),
      sftpPath: optionalText(2048),

      // RabbitMQ
      rabbitmqNodes: textList(2048),
      rabbitmqUsername: optionalText(500),
      rabbitmqPassword: optionalText(500),

      // WebSocket
      wsSubprotocol: optionalText(500),
      wsIgnoreSecWebsocketAcceptHeader: z.boolean().default(false),

      // Game servers
      game: optionalText(100),
      gamedigGivenPortOnly: z.boolean().default(true),

      // Real browser
      remoteBrowser: optionalText(2048),
    })
    .superRefine((values, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message })
      const { type } = values

      // Credentials for every URL type (HTTP, WebSocket, browser)
      const checkAuth = () => {
        switch (values.authMethod) {
          case 'basic':
          case 'ntlm':
            if (!values.basicAuthUser) issue('basicAuthUser', message('usernameRequired'))
            break
          case 'bearer':
            if (!values.bearerToken) issue('bearerToken', message('tokenRequired'))
            break
          case 'oauth2-cc':
            if (!values.oauthTokenUrl) issue('oauthTokenUrl', message('tokenUrlRequired'))
            if (!values.oauthClientId) issue('oauthClientId', message('clientIdRequired'))
            if (!values.oauthClientSecret)
              issue('oauthClientSecret', message('clientSecretRequired'))
            break
          case 'mtls':
            if (!values.tlsCert) issue('tlsCert', message('clientCertificateRequired'))
            if (!values.tlsKey) issue('tlsKey', message('privateKeyRequired'))
            break
        }
      }
      const checkHeaders = () => {
        if (values.headers && !parseHeadersJson(values.headers)) {
          issue('headers', message('headersJson', { example: '{"X-Token": "abc"}' }))
        }
      }

      if (isHttpMonitorType(type)) {
        if (!values.url) issue('url', message('urlRequired'))
        else if (!/^https?:\/\/\S+$/i.test(values.url)) issue('url', message('httpUrl'))
        checkHeaders()
        if (values.httpBodyEncoding === 'json' && values.body) {
          try {
            JSON.parse(values.body)
          } catch {
            issue('body', message('bodyJson'))
          }
        }
        if (values.acceptedStatusCodes.length === 0) {
          issue('acceptedStatusCodes', message('statusCodeRequired'))
        }
        checkAuth()
      }

      if (type === 'real-browser') {
        if (!values.url) issue('url', message('urlRequired'))
        else if (!/^https?:\/\/\S+$/i.test(values.url)) issue('url', message('httpUrl'))
        if (!values.remoteBrowser) issue('remoteBrowser', message('remoteBrowserRequired'))
        else if (!/^wss?:\/\/\S+$/i.test(values.remoteBrowser)) {
          issue('remoteBrowser', message('remoteBrowserUrl'))
        }
      }

      if (type === 'websocket-upgrade') {
        if (!values.url) issue('url', message('urlRequired'))
        else if (!/^wss?:\/\/\S+$/i.test(values.url)) issue('url', message('wsUrl'))
        checkHeaders()
        if (values.acceptedStatusCodes.length === 0) {
          issue('acceptedStatusCodes', message('closeCodeRequired'))
        }
        if (values.authMethod === 'oauth2-cc' || values.authMethod === 'ntlm') {
          issue('authMethod', message('wsAuthMethod'))
        } else {
          checkAuth()
        }
      }

      if (isKeywordMonitorType(type) && !values.keyword)
        issue('keyword', message('keywordRequired'))
      if (type === 'json-query' || (type === 'mqtt' && values.mqttCheckType === 'json-query')) {
        if (!values.jsonPath) issue('jsonPath', message('jsonQueryRequired'))
        if (values.expectedValue === null) issue('expectedValue', message('expectedValueRequired'))
      }

      if (isHostMonitorType(type) && !values.hostname) {
        issue('hostname', message('hostnameRequired'))
      }
      const portRequired = type === 'port' || type === 'steam' || type === 'gamedig'
      if (portRequired && (values.port === null || values.port === undefined)) {
        issue('port', message('portRequired'))
      }
      if (type === 'dns' && !values.dnsResolveType) {
        issue('dnsResolveType', message('recordTypeRequired'))
      }
      if (type === 'push' && values.pushSchedule === 'cron') {
        if (!values.pushCron) issue('pushCron', message('cronRequired'))
        else if (!isValidCronPattern(values.pushCron)) issue('pushCron', message('cronInvalid'))
      }
      if (type === 'manual' && !values.manualStatus) {
        issue('manualStatus', message('manualStatusRequired'))
      }
      if (values.type === 'docker') {
        if (values.dockerHost === null) issue('dockerHost', message('dockerHostRequired'))
        if (!values.dockerContainer) issue('dockerContainer', message('containerRequired'))
        else if (!DOCKER_CONTAINER_PATTERN.test(values.dockerContainer)) {
          issue('dockerContainer', message('containerInvalid'))
        }
      }
      const tagIds = values.tags.map((row) => String(row.tag))
      if (new Set(tagIds).size !== tagIds.length) issue('tags', message('tagsUnique'))
      const channelIds = values.notifications.map(String)
      if (new Set(channelIds).size !== channelIds.length) {
        issue('notifications', message('channelsUnique'))
      }

      if (isDatabaseMonitorType(type)) {
        const conn = values.databaseConnectionString
        const schemes: Partial<Record<MonitorTypeName, [RegExp, string]>> = {
          mysql: [/^mysql:\/\//i, 'mysql://user:password@host:3306/database'],
          postgres: [/^postgres(ql)?:\/\//i, 'postgres://user:password@host:5432/database'],
          mongodb: [/^mongodb(\+srv)?:\/\//i, 'mongodb://user:password@host:27017/database'],
          redis: [/^rediss?:\/\//i, 'redis://user:password@host:6379'],
        }
        if (!conn) issue('databaseConnectionString', message('connectionStringRequired'))
        else {
          const expected = schemes[type]
          if (expected && !expected[0].test(conn)) {
            issue(
              'databaseConnectionString',
              message('connectionStringScheme', { example: expected[1] }),
            )
          }
        }
        if (type === 'mongodb' && !isJsonObjectText(values.databaseQuery)) {
          issue('databaseQuery', message('mongoCommandJson', { example: '{"ping": 1}' }))
        }
      }

      if (type === 'mqtt' && !values.mqttTopic) issue('mqttTopic', message('topicRequired'))

      if (type === 'kafka-producer') {
        if (values.kafkaProducerBrokers.length === 0) {
          issue('kafkaProducerBrokers', message('brokerRequired'))
        }
        if (!values.kafkaProducerTopic) issue('kafkaProducerTopic', message('topicRequired'))
        if (!isJsonObjectText(values.kafkaProducerSaslOptions)) {
          issue('kafkaProducerSaslOptions', message('saslJson'))
        }
      }

      if (type === 'grpc-keyword') {
        if (!values.grpcUrl) issue('grpcUrl', message('grpcUrlRequired'))
        if (!values.grpcProtobuf) issue('grpcProtobuf', message('protoRequired'))
        if (!values.grpcServiceName) issue('grpcServiceName', message('serviceNameRequired'))
        if (!values.grpcMethod) issue('grpcMethod', message('methodRequired'))
        if (!isJsonObjectText(values.grpcBody)) issue('grpcBody', message('grpcBodyJson'))
        if (!isJsonObjectText(values.grpcMetadata)) {
          issue('grpcMetadata', message('grpcMetadataJson'))
        }
      }

      if (type === 'radius') {
        if (!values.radiusUsername) issue('radiusUsername', message('usernameRequired'))
        if (!values.radiusSecret) issue('radiusSecret', message('sharedSecretRequired'))
      }

      if (type === 'snmp') {
        if (!values.snmpOid) issue('snmpOid', message('oidRequired'))
        if (!values.snmpCommunity) issue('snmpCommunity', message('communityRequired'))
      }

      if (type === 'sftp') {
        if (!values.sshUsername) issue('sshUsername', message('usernameRequired'))
        if (values.sshAuthMethod === 'privateKey' && !values.sshPrivateKey) {
          issue('sshPrivateKey', message('sshPrivateKeyRequired'))
        }
      }

      if (type === 'rabbitmq') {
        if (values.rabbitmqNodes.length === 0) issue('rabbitmqNodes', message('nodeRequired'))
        else if (values.rabbitmqNodes.some((node) => !/^https?:\/\/\S+$/i.test(node))) {
          issue('rabbitmqNodes', message('nodeUrl'))
        }
        if (!values.rabbitmqUsername) issue('rabbitmqUsername', message('usernameRequired'))
      }

      if (type === 'gamedig' && !values.game) issue('game', message('gameRequired'))
    })
}

/** Validated form values (what the route handlers receive). */
export type MonitorFormValues = z.output<ReturnType<typeof createMonitorFormSchema>>
/** Raw form values before coercion/defaults (what react-hook-form holds). */
export type MonitorFormInput = z.input<ReturnType<typeof createMonitorFormSchema>>

/** Connection string placeholder per database type (also the form's starting value). */
export const DATABASE_CONNECTION_PLACEHOLDERS: Record<string, string> = {
  mysql: 'mysql://user:password@host:3306/database',
  postgres: 'postgres://user:password@host:5432/database',
  sqlserver: 'Server=host,1433;Database=database;User Id=user;Password=password;Encrypt=true',
  mongodb: 'mongodb://user:password@host:27017/database',
  redis: 'redis://user:password@host:6379',
}

/** Starting value of `url` for the URL-based types. */
export function defaultUrl(type: MonitorTypeName): string | null {
  if (type === 'websocket-upgrade') return 'wss://'
  if (isHttpMonitorType(type) || type === 'real-browser') return 'https://'
  return null
}

/** Defaults for a fresh monitor of `type` (Uptime Kuma defaults). */
export function defaultMonitorValues(type: MonitorTypeName = 'http'): MonitorFormValues {
  return {
    name: '',
    type,
    publicName: null,
    description: null,
    parent: null,
    weight: 2000,
    active: true,
    tags: [],
    notifications: [],
    url: defaultUrl(type),
    hostname: null,
    port: DEFAULT_PORTS[type] ?? null,
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
    acceptedStatusCodes: type === 'websocket-upgrade' ? ['1000'] : ['200-299'],
    ignoreTls: false,
    expiryNotification: false,
    proxy: null,
    domainExpiryNotification: false,
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
    pushSchedule: 'interval',
    pushCron: null,
    pushTimezone: SAME_AS_SERVER,
    pushGrace: null,
    pushMaxDuration: null,
    manualStatus: type === 'manual' ? 'up' : null,
    dockerHost: null,
    dockerContainer: null,
    databaseConnectionString: null,
    databaseQuery: null,
    mqttTopic: null,
    mqttUsername: null,
    mqttPassword: null,
    mqttCheckType: 'keyword',
    mqttSuccessMessage: null,
    kafkaProducerBrokers: [],
    kafkaProducerTopic: null,
    kafkaProducerMessage: null,
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
    kafkaProducerSaslOptions: null,
    grpcUrl: null,
    grpcProtobuf: null,
    grpcServiceName: null,
    grpcMethod: null,
    grpcEnableTls: false,
    grpcBody: null,
    grpcMetadata: null,
    radiusUsername: null,
    radiusPassword: null,
    radiusSecret: null,
    radiusCalledStationId: null,
    radiusCallingStationId: null,
    snmpOid: null,
    snmpVersion: '2c',
    snmpCommunity: type === 'snmp' ? 'public' : null,
    smtpSecurity: 'opportunistic',
    sshUsername: null,
    sshAuthMethod: 'password',
    sshPassword: null,
    sshPrivateKey: null,
    sshPassphrase: null,
    sftpPath: null,
    rabbitmqNodes: [],
    rabbitmqUsername: null,
    rabbitmqPassword: null,
    wsSubprotocol: null,
    wsIgnoreSecWebsocketAcceptHeader: false,
    game: null,
    gamedigGivenPortOnly: true,
    remoteBrowser: null,
  }
}

/** Monitor document fields the form edits, in the shape `defaultMonitorValues` returns. */
export type MonitorLike = Partial<Record<keyof MonitorFormValues, unknown>> & {
  parent?: unknown
}

const toId = (value: unknown): string | number | null =>
  value && typeof value === 'object' && 'id' in value
    ? ((value as { id: string | number }).id ?? null)
    : ((value as string | number | null | undefined) ?? null)

/**
 * Maps a stored monitor document to form values (relationships collapsed to ids, nulls kept so
 * the form is fully controlled).
 */
export function monitorToFormValues(doc: MonitorLike): MonitorFormValues {
  const type = MONITOR_TYPE_NAMES.includes(doc.type as MonitorTypeName)
    ? (doc.type as MonitorTypeName)
    : 'http'
  const base = defaultMonitorValues(type)
  const relations = {
    parent: toId(doc.parent),
    proxy: toId(doc.proxy),
    dockerHost: toId(doc.dockerHost),
  }
  const tags = Array.isArray(doc.tags)
    ? (doc.tags as { tag?: unknown; value?: string | null }[]).flatMap((row) => {
        const tag = toId(row?.tag)
        return tag === null ? [] : [{ tag, value: row.value ?? null }]
      })
    : []

  const notifications = Array.isArray(doc.notifications)
    ? (doc.notifications as unknown[]).flatMap((item) => {
        const id = toId(item)
        return id === null ? [] : [id]
      })
    : []

  const out: Record<string, unknown> = { ...base, ...relations, tags, notifications }
  for (const key of Object.keys(base) as (keyof MonitorFormValues)[]) {
    if (key in relations || key === 'tags' || key === 'notifications') continue
    const value = doc[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out as MonitorFormValues
}

export type DurationUnit = 'day' | 'hour' | 'minute' | 'second'

const englishDurationUnit = (unit: DurationUnit, count: number): string =>
  `${count} ${unit}${count === 1 ? '' : 's'}`

/**
 * Seconds → "1 minute 30 seconds" style hint shown under interval inputs. `unit` renders one
 * part; the form passes its translator (`common.duration`), the default is English.
 */
export function humanDuration(
  totalSeconds: number | string | null | undefined,
  unit: (unit: DurationUnit, count: number) => string = englishDurationUnit,
): string {
  const seconds = Number(totalSeconds)
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const units: [number, DurationUnit][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ]
  const parts: string[] = []
  let rest = Math.round(seconds)
  for (const [size, name] of units) {
    const n = Math.floor(rest / size)
    if (n > 0) {
      parts.push(unit(name, n))
      rest -= n * size
    }
  }
  return parts.length ? parts.join(' ') : unit('second', 0)
}
