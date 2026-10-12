import { randomBytes } from 'node:crypto'
import {
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { attachDefaultNotifications } from './Notifications'
import { childLogger } from '@/lib/logger'
import type { Monitor } from '@/payload-types'
import {
  enforceEntitlementOnCreate,
  enforceMinIntervalOnChange,
} from '@/server/billing/entitlements'
import { MONITOR_TARGET_FIELDS, monitorTargetProblem } from '@/server/security/monitor-targets'
import { SSH_TUNNEL_MONITOR_TYPES, supportsSshTunnel } from '@/lib/ssh-tunnels'
import { outboundGuardActive } from '@/server/security/outbound-guard'

import { supportsDegradedThreshold } from '@/lib/monitor-degraded'
import {
  DEFAULT_GROUP_AGGREGATION,
  DEFAULT_GROUP_WEIGHT,
  GROUP_AGGREGATION_MODES,
  GROUP_LATENCY_MODES,
  GROUP_QUORUM_UNITS,
  MAX_GROUP_QUORUM,
  MAX_GROUP_WEIGHT,
} from '@/lib/group-aggregation'
import {
  PROMETHEUS_AGGREGATES,
  PROMETHEUS_OPERATORS,
  PROMETHEUS_QUERY_MAX_LENGTH,
  type PrometheusFallbackStatus,
} from '@/lib/prometheus'
import {
  ASSERTION_COMPARATORS,
  ASSERTION_KINDS,
  assertionProblems,
  normalizeAssertions,
} from '@/lib/validation/assertions'

import { HEARTBEAT_STATUSES } from './Heartbeats'
import {
  MAX_REMINDERS_LIMIT,
  MAX_SUCCESS_THRESHOLD,
  REMINDER_BACKOFFS,
} from '@/lib/reminder-backoff'
import { relId } from './shared'
import { PUSH_EMAIL_KEYWORD_MAX_LENGTH, type PushEmailUnmatched } from '@/lib/push-email'
import { isValidCronPattern, MAX_PUSH_SECONDS, PUSH_SCHEDULE_TYPES } from '@/lib/push-schedule'
import { isValidTimezone, SAME_AS_SERVER } from '@/lib/validation/maintenance'
import {
  GLOBALPING_DEFAULT_PACKETS,
  GLOBALPING_DEFAULT_PROBES,
  GLOBALPING_IP_VERSIONS,
  GLOBALPING_MAX_PACKETS,
  GLOBALPING_MAX_PROBES,
  GLOBALPING_MEASUREMENTS,
  GLOBALPING_PROTOCOL_VALUES,
  GLOBALPING_SUCCESS_RULES,
} from '@/lib/validation/globalping'
import { STATUS_PAGE_PROVIDERS } from '@/lib/validation/status-page-monitor'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  DEFAULT_QUORUM,
  isRemoteMonitor,
  MAX_MONITOR_LOCATIONS,
  QUORUM_MODES,
  monitorLocationIds,
  probeSupportsType,
} from '@/lib/probe-locations'
import { getTranslator } from '@/i18n/translator'
import { userErrorText, userLocale } from '@/server/request-locale'

const log = childLogger('monitors')

/**
 * Monitor types shipped with Marmot. Keep in sync with `src/server/monitor-types/*`.
 * The engine looks types up at runtime (`getMonitorType`), this list only drives the admin select.
 */
export const MONITOR_TYPES = [
  { label: 'HTTP(s)', value: 'http' },
  { label: adminT('marmot:labels:httpKeyword'), value: 'keyword' },
  { label: adminT('marmot:labels:httpJsonQuery'), value: 'json-query' },
  { label: adminT('marmot:labels:prometheusQuery'), value: 'prometheus' },
  { label: adminT('marmot:labels:tcpPort'), value: 'port' },
  { label: 'Ping', value: 'ping' },
  { label: 'DNS', value: 'dns' },
  { label: 'Globalping', value: 'globalping' },
  { label: adminT('marmot:labels:thirdPartyStatusPage'), value: 'status-page' },
  { label: adminT('marmot:labels:push'), value: 'push' },
  { label: adminT('marmot:labels:group'), value: 'group' },
  { label: adminT('marmot:labels:manual'), value: 'manual' },
  { label: adminT('marmot:labels:dockerContainer'), value: 'docker' },
  // Protocols
  { label: adminT('marmot:labels:grpcKeyword'), value: 'grpc-keyword' },
  { label: adminT('marmot:labels:websocketUpgrade'), value: 'websocket-upgrade' },
  { label: 'MQTT', value: 'mqtt' },
  { label: adminT('marmot:labels:kafkaProducerType'), value: 'kafka-producer' },
  { label: 'RabbitMQ', value: 'rabbitmq' },
  { label: 'SMTP', value: 'smtp' },
  { label: 'SNMP', value: 'snmp' },
  { label: 'NTP', value: 'ntp' },
  { label: 'SFTP', value: 'sftp' },
  { label: 'SSH', value: 'ssh' },
  { label: 'UDP', value: 'udp' },
  { label: adminT('marmot:labels:tlsHandshake'), value: 'tls' },
  { label: 'IMAP', value: 'imap' },
  { label: 'POP3', value: 'pop3' },
  { label: 'Radius', value: 'radius' },
  { label: adminT('marmot:labels:tailscalePing'), value: 'tailscale-ping' },
  { label: adminT('marmot:labels:realBrowser'), value: 'real-browser' },
  // Databases
  { label: 'MySQL/MariaDB', value: 'mysql' },
  { label: 'PostgreSQL', value: 'postgres' },
  { label: 'Microsoft SQL Server', value: 'sqlserver' },
  { label: 'MongoDB', value: 'mongodb' },
  { label: 'Redis', value: 'redis' },
  // Game servers
  { label: adminT('marmot:labels:steam'), value: 'steam' },
  { label: 'GameDig', value: 'gamedig' },
] as const

export const HTTP_TYPES = ['http', 'keyword', 'json-query']

const PROMETHEUS_STATUS_OPTIONS = [
  { label: adminT('marmot:labels:up'), value: 'up' },
  { label: adminT('marmot:labels:down'), value: 'down' },
  { label: adminT('marmot:labels:pending'), value: 'pending' },
] satisfies { label: unknown; value: PrometheusFallbackStatus }[]
/** Types whose target is `url` (HTTP types plus the WebSocket and browser checks). */
export const URL_TYPES = [...HTTP_TYPES, 'websocket-upgrade', 'real-browser', 'prometheus']
/** Types whose target is `hostname` (+ `port`). */
export const HOST_TYPES = [
  'port',
  'ping',
  'dns',
  'mqtt',
  'smtp',
  'snmp',
  'ntp',
  'sftp',
  'ssh',
  'udp',
  'tls',
  'imap',
  'pop3',
  'radius',
  'tailscale-ping',
  'steam',
  'gamedig',
]
export const PORT_TYPES = HOST_TYPES.filter((t) => t !== 'ping' && t !== 'tailscale-ping')
export const DATABASE_TYPES = ['mysql', 'postgres', 'sqlserver', 'mongodb', 'redis']
/** Types that evaluate a JSONata expression against their result. */
export const JSON_QUERY_TYPES = ['json-query', 'mongodb', 'snmp', 'mqtt']
export const KEYWORD_TYPES = ['keyword', 'grpc-keyword']

/** Types that record the server's TLS certificate (`certInfo`) and can warn before it expires. */
export const CERTIFICATE_TYPES = [...HTTP_TYPES, 'tls', 'imap', 'pop3']
/** Mail types configured with `smtpSecurity`. */
const MAIL_TYPES = ['smtp', 'imap', 'pop3']

/** Types whose target names a domain (URL or hostname), i.e. domain expiry can be looked up. */
export const DOMAIN_TYPES = [...HTTP_TYPES, 'port', 'ping', 'dns']

type TypeData = { type?: string; globalpingMeasurement?: string | null } | undefined
const typeIn = (list: string[]) => (data: TypeData) =>
  Boolean(data?.type && list.includes(data.type))

/** Globalping monitors (#142) take `url` for HTTP measurements and `hostname` otherwise. */
const isGlobalping = (data: TypeData, measurement?: string) =>
  data?.type === 'globalping' &&
  (measurement === undefined || (data.globalpingMeasurement ?? 'http') === measurement)
const globalpingHost = (data: TypeData) => isGlobalping(data) && !isGlobalping(data, 'http')

const isDomainType = (data: { type?: string } | undefined) =>
  Boolean(data?.type && DOMAIN_TYPES.includes(data.type))

/**
 * Lightweight status cache, maintained by the worker after every check so list views, groups and
 * the push check never have to query `heartbeats`. The worker updates it with
 * `context: { skipEngineSync: true }` so the afterChange hook does not re-register the scheduler.
 */
const statusGroup: Field = {
  name: 'status',
  type: 'group',
  admin: {
    readOnly: true,
    description: adminT('marmot:monitors:statusDescription'),
  },
  fields: [
    {
      name: 'lastStatus',
      type: 'select',
      options: HEARTBEAT_STATUSES.map((s) => ({ label: s, value: s })),
    },
    { name: 'lastCheckAt', type: 'date', admin: { date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'lastPing', type: 'number' },
    { name: 'lastMsg', type: 'text' },
    { name: 'retries', type: 'number', defaultValue: 0 },
    { name: 'downCount', type: 'number', defaultValue: 0 },
    {
      name: 'settledStatus',
      type: 'select',
      options: HEARTBEAT_STATUSES.map((s) => ({ label: s, value: s })),
      admin: { description: adminT('marmot:monitors:settledStatusDescription') },
    },
    {
      name: 'recoveries',
      type: 'number',
      defaultValue: 0,
      admin: { description: adminT('marmot:monitors:recoveriesDescription') },
    },
    {
      name: 'lastPushAt',
      type: 'date',
      admin: {
        date: { pickerAppearance: 'dayAndTime' },
        description: adminT('marmot:monitors:lastPushAtDescription'),
      },
    },
    {
      name: 'lastPushStatus',
      type: 'select',
      options: [
        { label: 'up', value: 'up' },
        { label: 'down', value: 'down' },
      ],
      admin: { description: adminT('marmot:monitors:lastPushStatusDescription') },
    },
    {
      name: 'pushRuns',
      type: 'json',
      admin: { description: adminT('marmot:monitors:pushRunsDescription') },
    },
    {
      name: 'cacheSeconds',
      type: 'number',
      admin: { description: adminT('marmot:monitors:cacheSecondsDescription') },
    },
  ],
}

/** Restrict a relationship picker to documents of the monitor's organization. */
const sameOrganization = ({ data }: { data?: { organization?: unknown } }): Where | boolean =>
  data?.organization ? { organization: { equals: relId(data.organization) } } : true

/**
 * Tags, notification channels, the proxy, the OTLP collector and the Docker host must belong to the monitor's
 * organization. `filterOptions` only guards the admin UI; this hook guards every API so a member
 * cannot attach another organization's channel, proxy (and its credentials) or Docker host to
 * their monitor.
 */
const validateOrgReferences: CollectionBeforeChangeHook<Monitor> = async ({
  data,
  originalDoc,
  req,
}) => {
  const organization = relId(data.organization ?? originalDoc?.organization)
  const checks: { collection: CollectionSlug; ids: (string | number)[]; path: string }[] = []

  if (Array.isArray(data.tags)) {
    const ids = data.tags.map((row) => relId(row?.tag)).filter((id) => id !== null)
    const unique = [...new Set(ids.map(String))]
    if (unique.length !== ids.length) {
      throw new ValidationError({
        collection: 'monitors',
        errors: [{ message: userErrorText(req, 'tagDuplicate'), path: 'tags' }],
      })
    }
    if (ids.length > 0) checks.push({ collection: 'tags', ids, path: 'tags' })
  }
  if (Array.isArray(data.notifications) && data.notifications.length > 0) {
    // Channels of another organization are refused; ids of deleted channels (MongoDB keeps them in
    // the array) are dropped so the monitor stays editable. Duplicates collapse to one link.
    const ids = [
      ...new Map(
        data.notifications
          .map((item) => relId(item))
          .filter((id) => id !== null)
          .map((id) => [String(id), id] as const),
      ).values(),
    ]
    const { docs } = await req.payload.find({
      collection: 'notifications',
      where: { id: { in: ids } },
      select: { organization: true },
      depth: 0,
      limit: ids.length,
      pagination: false,
      req,
      overrideAccess: true,
    })
    if (docs.some((doc) => String(relId(doc.organization)) !== String(organization))) {
      throw new ValidationError({
        collection: 'monitors',
        errors: [
          {
            message: userErrorText(req, 'monitorForeignReference'),
            path: 'notifications',
          },
        ],
      })
    }
    const existing = new Set(docs.map((doc) => String(doc.id)))
    data.notifications = ids.filter((id) => existing.has(String(id))) as Monitor['notifications']
  }
  const proxy = relId(data.proxy)
  if (proxy !== null) checks.push({ collection: 'proxies', ids: [proxy], path: 'proxy' })
  const sshTunnel = relId(data.sshTunnel)
  if (sshTunnel !== null) {
    checks.push({ collection: 'ssh-tunnels', ids: [sshTunnel], path: 'sshTunnel' })
  }
  const otlpCollector = relId(data.otlpCollector)
  if (otlpCollector !== null) {
    checks.push({ collection: 'otel-collectors', ids: [otlpCollector], path: 'otlpCollector' })
  }
  const dockerHost = relId(data.dockerHost)
  if (dockerHost !== null) {
    checks.push({ collection: 'docker-hosts', ids: [dockerHost], path: 'dockerHost' })
  }
  if (Array.isArray(data.locations)) {
    const ids = monitorLocationIds(data)
    if (ids.length > 0) checks.push({ collection: 'locations', ids, path: 'locations' })
  }

  for (const check of checks) {
    const { docs } = await req.payload.find({
      collection: check.collection,
      where: { id: { in: check.ids } },
      select: { organization: true },
      depth: 0,
      limit: check.ids.length,
      pagination: false,
      req,
      overrideAccess: true,
    })
    const ok =
      docs.length === check.ids.length &&
      docs.every(
        (doc) =>
          String(relId((doc as { organization?: unknown }).organization)) === String(organization),
      )
    if (!ok) {
      throw new ValidationError({
        collection: 'monitors',
        errors: [{ message: userErrorText(req, 'monitorForeignReference'), path: check.path }],
      })
    }
  }
  return data
}

/**
 * Monitors-as-code keys (#116) are unique per organization. Checked here rather than with a unique
 * index: most monitors have no key, and MongoDB's unique indexes treat every missing key as the
 * same `null` value.
 */
const validateUniqueKey: CollectionBeforeChangeHook<Monitor> = async ({
  data,
  originalDoc,
  req,
}) => {
  const key = typeof data.key === 'string' ? data.key.trim() : data.key
  if (key === undefined) return data
  data.key = key || null
  if (!data.key || data.key === originalDoc?.key) return data
  const organization = relId(data.organization ?? originalDoc?.organization)
  const where: Where[] = [{ organization: { equals: organization } }, { key: { equals: data.key } }]
  if (originalDoc?.id !== undefined) where.push({ id: { not_equals: originalDoc.id } })
  const { totalDocs } = await req.payload.count({
    collection: 'monitors',
    where: { and: where },
    req,
    overrideAccess: true,
  })
  if (totalDocs > 0) {
    throw new ValidationError({
      collection: 'monitors',
      errors: [{ message: userErrorText(req, 'monitorKeyTaken', { key: data.key }), path: 'key' }],
    })
  }
  return data
}

/**
 * Probe locations (#91): at most `MAX_MONITOR_LOCATIONS` per monitor (several of them, plus the
 * local workers with `includeLocal`, are combined by quorum, #92), no duplicates, and only types a
 * probe can run (`PROBE_UNSUPPORTED_TYPES`).
 */
const validateLocations: CollectionBeforeChangeHook<Monitor> = ({ data, originalDoc, req }) => {
  if (Array.isArray(data.locations)) {
    const ids = monitorLocationIds(data)
    const unique = [...new Map(ids.map((id) => [String(id), id] as const)).values()]
    data.locations = unique as Monitor['locations']
  }
  const locations = data.locations !== undefined ? data.locations : originalDoc?.locations
  const ids = monitorLocationIds({ locations })
  if (ids.length === 0) return data
  const fail = (key: 'monitorTooManyLocations' | 'monitorTypeNotOnProbe') => {
    throw new ValidationError({
      collection: 'monitors',
      errors: [
        {
          message: userErrorText(req, key, { max: MAX_MONITOR_LOCATIONS }),
          path: 'locations',
        },
      ],
    })
  }
  if (ids.length > MAX_MONITOR_LOCATIONS) fail('monitorTooManyLocations')
  if (!probeSupportsType(data.type ?? originalDoc?.type)) fail('monitorTypeNotOnProbe')
  return data
}

/**
 * SSH tunnels (#160): only for the types that can use one (`SSH_TUNNEL_MONITOR_TYPES`; changing to
 * another type drops the tunnel), never together with a proxy, and only for monitors the local
 * workers check (probe agents do not open tunnels).
 */
const validateSshTunnel: CollectionBeforeChangeHook<Monitor> = ({ data, originalDoc, req }) => {
  const tunnel = relId(data.sshTunnel !== undefined ? data.sshTunnel : originalDoc?.sshTunnel)
  if (tunnel === null) return data
  const type = data.type ?? originalDoc?.type
  if (!supportsSshTunnel(type)) {
    data.sshTunnel = null
    return data
  }
  const fail = (key: 'monitorTunnelWithProxy' | 'monitorTunnelOnProbe') => {
    throw new ValidationError({
      collection: 'monitors',
      errors: [{ message: userErrorText(req, key), path: 'sshTunnel' }],
    })
  }
  const proxy = relId(data.proxy !== undefined ? data.proxy : originalDoc?.proxy)
  if (proxy !== null && HTTP_TYPES.includes(type ?? '')) fail('monitorTunnelWithProxy')
  const locations = data.locations !== undefined ? data.locations : originalDoc?.locations
  if (monitorLocationIds({ locations }).length > 0) fail('monitorTunnelOnProbe')
  return data
}

/**
 * Outbound address guard (`MONITOR_DENY_PRIVATE_ADDRESSES` & co.): refuse host-local types and
 * literally denied targets on save. Fast feedback only — names are vetted when the check connects.
 * Runs on create and when a target field changes, so status updates never trip over it.
 */
const enforceOutboundPolicy: CollectionBeforeChangeHook<Monitor> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  if (!outboundGuardActive()) return data
  // Probe-checked monitors connect from the probe's network, which its own MONITOR_DENY_* settings
  // govern; the workers still vet the targets at connect time if the location is removed.
  if (
    isRemoteMonitor({
      locations: data.locations ?? originalDoc?.locations,
      includeLocal: data.includeLocal ?? originalDoc?.includeLocal,
    })
  ) {
    return data
  }
  const touched =
    operation === 'create' ||
    MONITOR_TARGET_FIELDS.some(
      (field) =>
        data[field] !== undefined &&
        JSON.stringify(data[field] ?? null) !== JSON.stringify(originalDoc?.[field] ?? null),
    )
  if (!touched) return data
  const problem = await monitorTargetProblem({ ...originalDoc, ...data } as Monitor, req)
  if (problem) {
    throw new ValidationError({
      collection: 'monitors',
      errors: [{ message: problem.message, path: problem.path }],
    })
  }
  return data
}

export const Monitors: CollectionConfig = {
  slug: 'monitors',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('monitoring'),
    defaultColumns: ['name', 'type', 'active', 'status.lastStatus', 'interval'],
  },
  // Org-scoped RBAC: viewers read, members write (see `src/access/permissions.ts`).
  access: {
    read: orgScoped('monitor:read'),
    create: orgScoped('monitor:create'),
    update: orgScoped('monitor:update'),
    delete: orgScoped('monitor:delete'),
  },
  indexes: [{ fields: ['organization', 'active'] }, { fields: ['organization', 'key'] }],
  hooks: {
    beforeChange: [
      ({ data }) => {
        // Push monitors need a token the push endpoint can address them by.
        if (data?.type === 'push' && !data.pushToken) {
          data.pushToken = randomBytes(16).toString('hex')
        }
        return data
      },
      ({ data, originalDoc }) => {
        // Certificate transparency alerts (#143): turning them off forgets the baseline, so
        // turning them on again starts from that moment instead of announcing the gap.
        const enabled = data?.ctAlerts ?? originalDoc?.ctAlerts
        if (data && !enabled && (data.ctState || originalDoc?.ctState)) data.ctState = null
        return data
      },
      // New monitors without explicit channels get the organization's default channels.
      attachDefaultNotifications,
      validateOrgReferences,
      validateUniqueKey,
      validateLocations,
      validateSshTunnel,
      enforceOutboundPolicy,
      // Plan limits (no-op unless BILLING_ENABLED).
      enforceEntitlementOnCreate('monitors'),
      enforceMinIntervalOnChange,
    ],
    afterChange: [
      async ({ doc, req }) => {
        if (req.context?.skipEngineSync) return doc
        try {
          const { syncMonitorAfterCommit, engineHooksEnabled } =
            await import('@/server/engine/scheduler')
          if (!engineHooksEnabled()) return doc
          // Deferred until the transaction commits: the worker must be able to read the monitor
          // when the scheduler fires its first job (see `syncMonitorAfterCommit`).
          await syncMonitorAfterCommit(req, doc)
        } catch (err) {
          log.warn({ err, monitorId: doc.id }, 'failed to sync monitor schedule')
        }
        return doc
      },
    ],
    beforeDelete: [
      // Heartbeats and stat rows carry a required `monitor` relationship (NOT NULL on Postgres), so
      // they must go first; children of a group are detached rather than deleted.
      async ({ id, req }) => {
        const common = { req, overrideAccess: true, depth: 0 } as const
        await req.payload.delete({
          collection: 'heartbeats',
          where: { monitor: { equals: id } },
          ...common,
        })
        for (const collection of [
          'stat-minutely',
          'stat-hourly',
          'stat-daily',
          'notification-sent-history',
          'monitor-incidents',
          'push-events',
          'monitor-location-states',
          'stat-location-hourly',
        ] as const) {
          await req.payload.delete({ collection, where: { monitor: { equals: id } }, ...common })
        }
        await req.payload.update({
          collection: 'monitors',
          where: { parent: { equals: id } },
          data: { parent: null },
          context: { skipEngineSync: true },
          ...common,
        })
      },
    ],
    afterDelete: [
      async ({ doc, req }) => {
        try {
          const { removeMonitorAfterCommit, engineHooksEnabled } =
            await import('@/server/engine/scheduler')
          if (!engineHooksEnabled()) return doc
          await removeMonitorAfterCommit(req, doc)
        } catch (err) {
          log.warn({ err, monitorId: doc.id }, 'failed to remove monitor schedule')
        }
        return doc
      },
    ],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      index: true,
      required: true,
      admin: { position: 'sidebar' },
    },
    {
      type: 'row',
      fields: [
        { name: 'name', type: 'text', required: true },
        {
          name: 'type',
          type: 'select',
          required: true,
          defaultValue: 'http',
          options: [...MONITOR_TYPES],
        },
      ],
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: { position: 'sidebar', description: adminT('marmot:monitors:activeDescription') },
    },
    {
      name: 'parent',
      type: 'relationship',
      relationTo: 'monitors',
      filterOptions: ({ id }): Where => {
        const where: Where[] = [{ type: { equals: 'group' } }]
        if (id) where.push({ id: { not_equals: id } })
        return { and: where }
      },
      admin: { position: 'sidebar', description: adminT('marmot:monitors:parentDescription') },
    },
    {
      name: 'key',
      type: 'text',
      maxLength: 128,
      admin: { position: 'sidebar', description: adminT('marmot:monitors:keyDescription') },
    },
    {
      name: 'publicName',
      type: 'text',
      maxLength: 150,
      admin: { description: adminT('marmot:monitors:publicNameDescription') },
    },
    { name: 'description', type: 'textarea' },
    {
      name: 'tags',
      type: 'array',
      admin: { description: adminT('marmot:monitors:tagsDescription') },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'tag',
              type: 'relationship',
              relationTo: 'tags',
              required: true,
              filterOptions: sameOrganization,
            },
            { name: 'value', type: 'text', maxLength: 200 },
          ],
        },
      ],
    },
    {
      name: 'notifications',
      type: 'relationship',
      relationTo: 'notifications',
      hasMany: true,
      filterOptions: ({ data }): Where | boolean =>
        data?.organization ? { organization: { equals: data.organization } } : true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:monitors:notificationsDescription'),
      },
    },
    {
      // OpenTelemetry metrics export (#99): on by default, so the organization's default collector
      // receives every monitor's checks; off opts this monitor out.
      name: 'otlpExport',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:monitors:otlpExportDescription'),
      },
    },
    {
      // Collector of this monitor; empty = the organization's default collector.
      name: 'otlpCollector',
      type: 'relationship',
      relationTo: 'otel-collectors',
      filterOptions: sameOrganization,
      admin: {
        position: 'sidebar',
        condition: (data) => data?.otlpExport !== false,
        description: adminT('marmot:monitors:otlpCollectorDescription'),
      },
    },
    {
      // Probe locations that check this monitor (#91). Empty: the local worker pool.
      name: 'locations',
      type: 'relationship',
      relationTo: 'locations',
      hasMany: true,
      filterOptions: sameOrganization,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:monitors:locationsDescription'),
      },
    },
    {
      // Multi-location checks (#92): the local worker pool checks the monitor too.
      name: 'includeLocal',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:monitors:includeLocalDescription'),
      },
    },
    {
      // How many of the monitor's locations must agree before its status changes (#92).
      name: 'quorum',
      type: 'select',
      defaultValue: DEFAULT_QUORUM,
      options: QUORUM_MODES.map((value) => ({
        label: adminT(`marmot:monitors:quorum_${value}`),
        value,
      })),
      admin: {
        position: 'sidebar',
        description: adminT('marmot:monitors:quorumDescription'),
      },
    },
    {
      name: 'weight',
      type: 'number',
      defaultValue: 2000,
      admin: { position: 'sidebar', description: adminT('marmot:monitors:weightDescription') },
    },

    // ---- Group aggregation (#144) ---------------------------------------------------------------
    {
      // How a group monitor turns its children's status into its own (`src/lib/group-aggregation.ts`).
      // Existing groups get the default, `worst`, which is the behaviour before #144.
      name: 'aggregation',
      type: 'select',
      defaultValue: DEFAULT_GROUP_AGGREGATION,
      options: GROUP_AGGREGATION_MODES.map((value) => ({
        label: adminT(`marmot:monitors:aggregation_${value}`),
        value,
      })),
      admin: {
        condition: (data) => data?.type === 'group',
        description: adminT('marmot:monitors:aggregationDescription'),
      },
    },
    {
      name: 'aggregationQuorum',
      type: 'number',
      min: 1,
      max: MAX_GROUP_QUORUM,
      admin: {
        condition: (data) => data?.type === 'group' && data?.aggregation === 'quorum',
        description: adminT('marmot:monitors:aggregationQuorumDescription'),
      },
    },
    {
      name: 'aggregationQuorumUnit',
      type: 'select',
      defaultValue: 'count',
      options: GROUP_QUORUM_UNITS.map((value) => ({
        label: adminT(`marmot:monitors:aggregationQuorumUnit_${value}`),
        value,
      })),
      admin: {
        condition: (data) => data?.type === 'group' && data?.aggregation === 'quorum',
      },
    },
    {
      name: 'aggregationLatency',
      type: 'select',
      defaultValue: 'none',
      options: GROUP_LATENCY_MODES.map((value) => ({
        label: adminT(`marmot:monitors:aggregationLatency_${value}`),
        value,
      })),
      admin: {
        condition: (data) => data?.type === 'group',
        description: adminT('marmot:monitors:aggregationLatencyDescription'),
      },
    },
    {
      // Weight of this monitor inside a `weighted` parent group; relative, normalised by the group.
      name: 'groupWeight',
      type: 'number',
      min: 0,
      max: MAX_GROUP_WEIGHT,
      defaultValue: DEFAULT_GROUP_WEIGHT,
      admin: {
        condition: (data) => Boolean(data?.parent),
        description: adminT('marmot:monitors:groupWeightDescription'),
      },
    },

    // ---- Target ---------------------------------------------------------------------------------
    {
      name: 'url',
      type: 'text',
      admin: {
        condition: (data) =>
          typeIn(URL_TYPES)(data) || isGlobalping(data, 'http') || data?.type === 'status-page',
        placeholder: 'https://',
      },
    },
    {
      name: 'proxy',
      type: 'relationship',
      relationTo: 'proxies',
      filterOptions: sameOrganization,
      admin: {
        condition: typeIn([...HTTP_TYPES, 'prometheus']),
        description: adminT('marmot:monitors:proxyDescription'),
      },
    },
    {
      name: 'sshTunnel',
      type: 'relationship',
      relationTo: 'ssh-tunnels',
      filterOptions: sameOrganization,
      admin: {
        condition: typeIn([...SSH_TUNNEL_MONITOR_TYPES]),
        description: adminT('marmot:monitors:sshTunnelDescription'),
      },
    },
    {
      type: 'row',
      admin: { condition: (data) => data?.type === 'docker' },
      fields: [
        {
          name: 'dockerHost',
          type: 'relationship',
          relationTo: 'docker-hosts',
          filterOptions: sameOrganization,
        },
        {
          name: 'dockerContainer',
          type: 'text',
          maxLength: 255,
          admin: { description: adminT('marmot:monitors:dockerContainerDescription') },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'hostname',
          type: 'text',
          admin: { condition: (data) => typeIn(HOST_TYPES)(data) || globalpingHost(data) },
        },
        {
          name: 'port',
          type: 'number',
          min: 1,
          max: 65535,
          admin: {
            condition: (data) => typeIn(PORT_TYPES)(data) || globalpingHost(data),
            description: adminT('marmot:monitors:portDescription'),
          },
        },
      ],
    },

    // ---- Timing ---------------------------------------------------------------------------------
    {
      type: 'row',
      fields: [
        {
          name: 'interval',
          type: 'number',
          required: true,
          defaultValue: 60,
          min: 1,
          admin: { description: adminT('marmot:monitors:intervalDescription') },
        },
        {
          name: 'retryInterval',
          type: 'number',
          required: true,
          defaultValue: 60,
          min: 1,
          admin: { description: adminT('marmot:monitors:retryIntervalDescription') },
        },
        {
          name: 'maxRetries',
          type: 'number',
          required: true,
          defaultValue: 0,
          min: 0,
          admin: { description: adminT('marmot:monitors:maxRetriesDescription') },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'resendInterval',
          type: 'number',
          required: true,
          defaultValue: 0,
          min: 0,
          admin: { description: adminT('marmot:monitors:resendIntervalDescription') },
        },
        {
          name: 'timeout',
          type: 'number',
          required: true,
          defaultValue: 48,
          min: 0,
          admin: { description: adminT('marmot:monitors:timeoutDescription') },
        },
      ],
    },
    {
      name: 'degradedAfter',
      type: 'number',
      min: 0,
      admin: {
        condition: (data) => supportsDegradedThreshold(data?.type),
        description: adminT('marmot:monitors:degradedAfterDescription'),
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'successThreshold',
          type: 'number',
          defaultValue: 1,
          min: 1,
          max: MAX_SUCCESS_THRESHOLD,
          admin: { description: adminT('marmot:monitors:successThresholdDescription') },
        },
        {
          name: 'reminderBackoff',
          type: 'select',
          defaultValue: 'none',
          options: REMINDER_BACKOFFS.map((value) => ({
            label: adminT(`marmot:monitors:reminderBackoff_${value}`),
            value,
          })),
          admin: { description: adminT('marmot:monitors:reminderBackoffDescription') },
        },
        {
          name: 'maxReminders',
          type: 'number',
          defaultValue: 0,
          min: 0,
          max: MAX_REMINDERS_LIMIT,
          admin: { description: adminT('marmot:monitors:maxRemindersDescription') },
        },
      ],
    },
    {
      name: 'upsideDown',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: adminT('marmot:monitors:upsideDownDescription') },
    },

    // ---- HTTP -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: adminT('marmot:labels:httpOptions'),
      admin: {
        condition: (data) => typeIn(URL_TYPES)(data) || isGlobalping(data, 'http'),
        initCollapsed: true,
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'method',
              type: 'select',
              defaultValue: 'GET',
              options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
            },
            {
              name: 'httpBodyEncoding',
              type: 'select',
              defaultValue: 'json',
              options: [
                { label: 'JSON', value: 'json' },
                { label: adminT('marmot:labels:formBody'), value: 'form' },
                { label: 'XML', value: 'xml' },
              ],
            },
            { name: 'maxRedirects', type: 'number', defaultValue: 10, min: 0 },
          ],
        },
        { name: 'body', type: 'textarea' },
        {
          name: 'headers',
          type: 'textarea',
          admin: { description: adminT('marmot:monitors:headersDescription') },
        },
        {
          name: 'acceptedStatusCodes',
          type: 'text',
          hasMany: true,
          defaultValue: ['200-299'],
          admin: { description: adminT('marmot:monitors:acceptedStatusCodesDescription') },
        },
        { name: 'ignoreTls', type: 'checkbox', defaultValue: false },
      ],
    },

    // ---- Expiry notifications (Uptime Kuma field names) --------------------------------------
    {
      type: 'row',
      fields: [
        {
          name: 'expiryNotification',
          type: 'checkbox',
          defaultValue: false,
          admin: {
            condition: typeIn(CERTIFICATE_TYPES),
            description: adminT('marmot:monitors:expiryNotificationDescription'),
          },
        },
        {
          name: 'domainExpiryNotification',
          type: 'checkbox',
          defaultValue: false,
          admin: {
            condition: (data) => isDomainType(data),
            description: adminT('marmot:monitors:domainExpiryNotificationDescription'),
          },
        },
      ],
    },
    // ---- Certificate transparency alerts (#143, src/server/jobs/ct-alerts.ts) -----------------
    {
      type: 'row',
      fields: [
        {
          name: 'ctAlerts',
          type: 'checkbox',
          defaultValue: false,
          admin: {
            condition: (data) => isDomainType(data),
            description: adminT('marmot:monitors:ctAlertsDescription'),
          },
        },
        {
          name: 'ctIncludeSubdomains',
          type: 'checkbox',
          defaultValue: false,
          admin: {
            condition: (data) => isDomainType(data) && Boolean(data?.ctAlerts),
            description: adminT('marmot:monitors:ctIncludeSubdomainsDescription'),
          },
        },
      ],
    },
    {
      name: 'ctExpectedIssuers',
      type: 'text',
      hasMany: true,
      maxRows: 20,
      admin: {
        condition: (data) => isDomainType(data) && Boolean(data?.ctAlerts),
        description: adminT('marmot:monitors:ctExpectedIssuersDescription'),
      },
    },
    {
      name: 'ctState',
      type: 'json',
      admin: {
        readOnly: true,
        condition: (data) => isDomainType(data) && Boolean(data?.ctAlerts),
        description: adminT('marmot:monitors:ctStateDescription'),
      },
    },
    {
      name: 'certInfo',
      type: 'json',
      admin: {
        readOnly: true,
        condition: typeIn(CERTIFICATE_TYPES),
        description: adminT('marmot:monitors:certInfoDescription'),
      },
    },
    {
      name: 'domainExpiry',
      type: 'json',
      admin: {
        readOnly: true,
        condition: (data) => isDomainType(data),
        description: adminT('marmot:monitors:domainExpiryDescription'),
      },
    },
    {
      type: 'collapsible',
      label: adminT('marmot:labels:keyword'),
      admin: { condition: typeIn(KEYWORD_TYPES), initCollapsed: false },
      fields: [
        { name: 'keyword', type: 'text' },
        {
          name: 'invertKeyword',
          type: 'checkbox',
          defaultValue: false,
          admin: { description: adminT('marmot:monitors:invertKeywordDescription') },
        },
      ],
    },
    {
      type: 'collapsible',
      label: adminT('marmot:labels:jsonQuery'),
      admin: { condition: typeIn(JSON_QUERY_TYPES), initCollapsed: false },
      fields: [
        {
          name: 'jsonPath',
          type: 'text',
          admin: { description: adminT('marmot:monitors:jsonPathDescription') },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'jsonPathOperator',
              type: 'select',
              defaultValue: '==',
              options: ['==', '!=', '<', '>', '<=', '>=', 'contains'],
            },
            { name: 'expectedValue', type: 'text' },
          ],
        },
      ],
    },

    {
      // Assertions (#96): rows evaluated by the worker after the request / lookup, all must pass.
      // Evaluated by `src/server/monitor-types/assertions.ts`; rules in `src/lib/validation/assertions.ts`.
      name: 'assertions',
      type: 'array',
      label: adminT('marmot:labels:assertions'),
      admin: {
        condition: typeIn([...HTTP_TYPES, 'dns']),
        initCollapsed: true,
        description: adminT('marmot:monitors:assertionsDescription'),
      },
      validate: (
        value: unknown,
        { data, req }: { data?: Partial<Monitor>; req: { user?: unknown } },
      ) => {
        const problems = assertionProblems(normalizeAssertions(value), data?.type)
        if (problems.length === 0) return true
        const first = problems[0]
        const t = getTranslator(userLocale(req.user))
        const message = t(`monitors.validation.${first.key}`, first.values)
        return first.index === null
          ? message
          : t('monitors.validation.assertionRow', { row: first.index + 1, message })
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'kind',
              type: 'select',
              required: true,
              options: ASSERTION_KINDS.map((kind) => ({ label: kind, value: kind })),
            },
            {
              name: 'target',
              type: 'text',
              maxLength: 1000,
              admin: { description: adminT('marmot:monitors:assertionTargetDescription') },
            },
            {
              name: 'comparator',
              type: 'select',
              required: true,
              options: ASSERTION_COMPARATORS.map((op) => ({ label: op, value: op })),
            },
            { name: 'value', type: 'text', maxLength: 2000 },
          ],
        },
      ],
    },

    // ---- Authentication -------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: adminT('marmot:labels:authentication'),
      admin: { condition: typeIn(URL_TYPES), initCollapsed: true },
      fields: [
        {
          name: 'authMethod',
          type: 'select',
          defaultValue: 'none',
          options: [
            { label: adminT('marmot:labels:none'), value: 'none' },
            { label: 'HTTP Basic', value: 'basic' },
            { label: adminT('marmot:labels:bearerToken'), value: 'bearer' },
            { label: adminT('marmot:labels:oauth2ClientCredentials'), value: 'oauth2-cc' },
            { label: 'NTLM', value: 'ntlm' },
            { label: 'mTLS', value: 'mtls' },
          ],
        },
        {
          type: 'row',
          admin: { condition: (data) => ['basic', 'ntlm'].includes(data?.authMethod) },
          fields: [
            { name: 'basicAuthUser', type: 'text' },
            { name: 'basicAuthPass', type: 'text' },
          ],
        },
        {
          type: 'row',
          admin: { condition: (data) => data?.authMethod === 'ntlm' },
          fields: [
            { name: 'authDomain', type: 'text' },
            { name: 'authWorkstation', type: 'text' },
          ],
        },
        {
          name: 'bearerToken',
          type: 'text',
          admin: { condition: (data) => data?.authMethod === 'bearer' },
        },
        {
          type: 'collapsible',
          label: 'OAuth2',
          admin: { condition: (data) => data?.authMethod === 'oauth2-cc' },
          fields: [
            { name: 'oauthTokenUrl', type: 'text' },
            {
              type: 'row',
              fields: [
                { name: 'oauthClientId', type: 'text' },
                { name: 'oauthClientSecret', type: 'text' },
              ],
            },
            { name: 'oauthScopes', type: 'text' },
            {
              name: 'oauthAuthMethod',
              type: 'select',
              defaultValue: 'client_secret_basic',
              options: ['client_secret_basic', 'client_secret_post'],
            },
          ],
        },
        {
          type: 'collapsible',
          label: 'mTLS',
          admin: { condition: (data) => data?.authMethod === 'mtls' },
          fields: [
            { name: 'tlsCert', type: 'textarea' },
            { name: 'tlsKey', type: 'textarea' },
            { name: 'tlsCa', type: 'textarea' },
          ],
        },
      ],
    },

    // ---- DNS ------------------------------------------------------------------------------------
    {
      type: 'row',
      admin: { condition: (data) => data?.type === 'dns' || isGlobalping(data, 'dns') },
      fields: [
        {
          name: 'dnsResolveServer',
          type: 'text',
          defaultValue: '1.1.1.1',
          admin: { description: adminT('marmot:monitors:dnsResolveServerDescription') },
        },
        {
          name: 'dnsResolveType',
          type: 'select',
          defaultValue: 'A',
          options: ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'],
        },
      ],
    },

    // ---- Globalping (#142) ----------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'Globalping',
      admin: { condition: (data) => data?.type === 'globalping', initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'globalpingMeasurement',
              type: 'select',
              defaultValue: 'http',
              options: [...GLOBALPING_MEASUREMENTS],
            },
            {
              name: 'globalpingProtocol',
              type: 'select',
              options: [...GLOBALPING_PROTOCOL_VALUES],
              admin: { description: adminT('marmot:monitors:globalpingProtocolDescription') },
            },
            {
              name: 'globalpingIpVersion',
              type: 'select',
              options: GLOBALPING_IP_VERSIONS.map((value) => ({ label: `IPv${value}`, value })),
            },
          ],
        },
        {
          name: 'globalpingLocations',
          type: 'textarea',
          admin: { description: adminT('marmot:monitors:globalpingLocationsDescription') },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'globalpingProbes',
              type: 'number',
              defaultValue: GLOBALPING_DEFAULT_PROBES,
              min: 1,
              max: GLOBALPING_MAX_PROBES,
            },
            {
              name: 'globalpingSuccessRule',
              type: 'select',
              defaultValue: 'all',
              options: [...GLOBALPING_SUCCESS_RULES],
              admin: { description: adminT('marmot:monitors:globalpingSuccessRuleDescription') },
            },
            {
              name: 'globalpingMinSuccess',
              type: 'number',
              min: 1,
              max: GLOBALPING_MAX_PROBES,
              admin: { condition: (data) => data?.globalpingSuccessRule === 'atLeast' },
            },
            {
              name: 'globalpingPackets',
              type: 'number',
              defaultValue: GLOBALPING_DEFAULT_PACKETS,
              min: 1,
              max: GLOBALPING_MAX_PACKETS,
              admin: { condition: (data) => isGlobalping(data, 'ping') },
            },
          ],
        },
      ],
    },

    // ---- Third-party status page (#125) ----------------------------------------------------------
    {
      type: 'row',
      admin: { condition: (data) => data?.type === 'status-page' },
      fields: [
        {
          name: 'statusPageProvider',
          type: 'select',
          defaultValue: 'auto',
          options: STATUS_PAGE_PROVIDERS.map((value) => ({ label: value, value })),
          admin: { description: adminT('marmot:monitors:statusPageProviderDescription') },
        },
        {
          name: 'statusPageComponents',
          type: 'json',
          admin: { description: adminT('marmot:monitors:statusPageComponentsDescription') },
        },
      ],
    },

    // ---- Push -----------------------------------------------------------------------------------
    {
      name: 'pushToken',
      type: 'text',
      index: true,
      admin: {
        condition: (data) => data?.type === 'push',
        description: adminT('marmot:monitors:pushTokenDescription'),
      },
    },
    {
      type: 'collapsible',
      label: adminT('marmot:labels:pushSchedule'),
      admin: { condition: (data) => data?.type === 'push', initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'pushSchedule',
              type: 'select',
              defaultValue: 'interval',
              options: [
                { label: adminT('marmot:labels:pushScheduleInterval'), value: 'interval' },
                { label: adminT('marmot:labels:pushScheduleCron'), value: 'cron' },
              ] satisfies { label: unknown; value: (typeof PUSH_SCHEDULE_TYPES)[number] }[],
              admin: { description: adminT('marmot:monitors:pushScheduleDescription') },
            },
            {
              name: 'pushCron',
              type: 'text',
              maxLength: 200,
              validate: (
                value: string | null | undefined,
                { siblingData }: { siblingData: Partial<Monitor> },
              ) =>
                siblingData?.type !== 'push' ||
                siblingData?.pushSchedule !== 'cron' ||
                isValidCronPattern(value) ||
                'Invalid cron expression',
              admin: {
                condition: (data) => data?.pushSchedule === 'cron',
                placeholder: '0 2 * * *',
                description: adminT('marmot:monitors:pushCronDescription'),
              },
            },
            {
              name: 'pushTimezone',
              type: 'text',
              defaultValue: SAME_AS_SERVER,
              maxLength: 100,
              validate: (value: string | null | undefined) =>
                !value || isValidTimezone(value) || 'Unknown time zone',
              admin: {
                condition: (data) => data?.pushSchedule === 'cron',
                description: adminT('marmot:monitors:pushTimezoneDescription'),
              },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'pushGrace',
              type: 'number',
              min: 0,
              max: MAX_PUSH_SECONDS,
              admin: { description: adminT('marmot:monitors:pushGraceDescription') },
            },
            {
              name: 'pushMaxDuration',
              type: 'number',
              min: 1,
              max: MAX_PUSH_SECONDS,
              admin: { description: adminT('marmot:monitors:pushMaxDurationDescription') },
            },
          ],
        },
      ],
    },

    {
      // Ping-by-email (#135): rules for mail sent to `<pushToken>@INBOUND_EMAIL_DOMAIN`.
      type: 'collapsible',
      label: adminT('marmot:labels:pushEmail'),
      admin: { condition: (data) => data?.type === 'push', initCollapsed: true },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'pushEmailFailureKeyword',
              type: 'text',
              maxLength: PUSH_EMAIL_KEYWORD_MAX_LENGTH,
              admin: { description: adminT('marmot:monitors:pushEmailFailureKeywordDescription') },
            },
            {
              name: 'pushEmailSuccessKeyword',
              type: 'text',
              maxLength: PUSH_EMAIL_KEYWORD_MAX_LENGTH,
              admin: { description: adminT('marmot:monitors:pushEmailSuccessKeywordDescription') },
            },
            {
              name: 'pushEmailStartKeyword',
              type: 'text',
              maxLength: PUSH_EMAIL_KEYWORD_MAX_LENGTH,
              admin: { description: adminT('marmot:monitors:pushEmailStartKeywordDescription') },
            },
          ],
        },
        {
          name: 'pushEmailUnmatched',
          type: 'select',
          defaultValue: 'ignore',
          options: [
            { label: adminT('marmot:labels:pushEmailUnmatchedIgnore'), value: 'ignore' },
            { label: adminT('marmot:labels:pushEmailUnmatchedFail'), value: 'fail' },
          ] satisfies { label: unknown; value: PushEmailUnmatched }[],
          admin: { description: adminT('marmot:monitors:pushEmailUnmatchedDescription') },
        },
      ],
    },

    // ---- Manual ---------------------------------------------------------------------------------
    {
      name: 'manualStatus',
      type: 'select',
      options: [
        { label: adminT('marmot:labels:up'), value: 'up' },
        { label: adminT('marmot:labels:down'), value: 'down' },
        { label: adminT('marmot:labels:pending'), value: 'pending' },
      ],
      admin: { condition: (data) => data?.type === 'manual' },
    },

    // ---- Databases (mysql, postgres, sqlserver, mongodb, redis) ---------------------------------
    {
      type: 'collapsible',
      label: adminT('marmot:labels:database'),
      admin: { condition: typeIn(DATABASE_TYPES), initCollapsed: false },
      fields: [
        {
          name: 'databaseConnectionString',
          type: 'text',
          admin: {
            description: adminT('marmot:monitors:databaseConnectionStringDescription'),
          },
        },
        {
          name: 'databaseQuery',
          type: 'textarea',
          admin: {
            condition: typeIn(['mysql', 'postgres', 'sqlserver', 'mongodb']),
            description: adminT('marmot:monitors:databaseQueryDescription'),
          },
        },
      ],
    },

    // ---- MQTT -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'MQTT',
      admin: { condition: (data) => data?.type === 'mqtt', initCollapsed: false },
      fields: [
        { name: 'mqttTopic', type: 'text' },
        {
          type: 'row',
          fields: [
            { name: 'mqttUsername', type: 'text' },
            { name: 'mqttPassword', type: 'text' },
          ],
        },
        {
          name: 'mqttCheckType',
          type: 'select',
          defaultValue: 'keyword',
          options: [
            { label: adminT('marmot:labels:keyword'), value: 'keyword' },
            { label: adminT('marmot:labels:jsonQuery'), value: 'json-query' },
          ],
        },
        {
          name: 'mqttSuccessMessage',
          type: 'text',
          admin: { description: adminT('marmot:monitors:mqttSuccessMessageDescription') },
        },
      ],
    },

    // ---- Kafka producer -------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: adminT('marmot:labels:kafkaProducer'),
      admin: { condition: (data) => data?.type === 'kafka-producer', initCollapsed: false },
      fields: [
        {
          name: 'kafkaProducerBrokers',
          type: 'text',
          hasMany: true,
          admin: { description: adminT('marmot:monitors:kafkaProducerBrokersDescription') },
        },
        { name: 'kafkaProducerTopic', type: 'text' },
        { name: 'kafkaProducerMessage', type: 'textarea' },
        {
          type: 'row',
          fields: [
            { name: 'kafkaProducerSsl', type: 'checkbox', defaultValue: false },
            {
              name: 'kafkaProducerAllowAutoTopicCreation',
              type: 'checkbox',
              defaultValue: false,
            },
          ],
        },
        {
          name: 'kafkaProducerSaslOptions',
          type: 'textarea',
          admin: {
            description: adminT('marmot:monitors:kafkaProducerSaslOptionsDescription'),
          },
        },
      ],
    },

    // ---- gRPC -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'gRPC',
      admin: { condition: (data) => data?.type === 'grpc-keyword', initCollapsed: false },
      fields: [
        { name: 'grpcUrl', type: 'text', admin: { placeholder: 'host:443' } },
        {
          type: 'row',
          fields: [
            { name: 'grpcServiceName', type: 'text' },
            { name: 'grpcMethod', type: 'text' },
            { name: 'grpcEnableTls', type: 'checkbox', defaultValue: false },
          ],
        },
        {
          name: 'grpcProtobuf',
          type: 'textarea',
          admin: { description: adminT('marmot:monitors:grpcProtobufDescription') },
        },
        {
          name: 'grpcBody',
          type: 'textarea',
          admin: { description: adminT('marmot:monitors:grpcBodyDescription') },
        },
        {
          name: 'grpcMetadata',
          type: 'textarea',
          admin: { description: adminT('marmot:monitors:grpcMetadataDescription') },
        },
      ],
    },

    // ---- RADIUS ---------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'RADIUS',
      admin: { condition: (data) => data?.type === 'radius', initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'radiusUsername', type: 'text' },
            { name: 'radiusPassword', type: 'text' },
            { name: 'radiusSecret', type: 'text' },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'radiusCalledStationId', type: 'text' },
            { name: 'radiusCallingStationId', type: 'text' },
          ],
        },
      ],
    },

    // ---- SNMP -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'SNMP',
      admin: { condition: (data) => data?.type === 'snmp', initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'snmpOid', type: 'text', admin: { placeholder: '1.3.6.1.2.1.1.1.0' } },
            {
              name: 'snmpVersion',
              type: 'select',
              defaultValue: '2c',
              options: [
                { label: 'SNMPv1', value: '1' },
                { label: 'SNMPv2c', value: '2c' },
              ],
            },
            { name: 'snmpCommunity', type: 'text', defaultValue: 'public' },
          ],
        },
      ],
    },

    // ---- Prometheus query (#140) ---------------------------------------------------------------
    {
      type: 'collapsible',
      label: adminT('marmot:labels:prometheusQuery'),
      admin: { condition: (data) => data?.type === 'prometheus', initCollapsed: false },
      fields: [
        {
          name: 'prometheusQuery',
          type: 'textarea',
          maxLength: PROMETHEUS_QUERY_MAX_LENGTH,
          admin: { description: adminT('marmot:monitors:prometheusQueryDescription') },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'prometheusDownOperator',
              type: 'select',
              defaultValue: '>',
              options: [...PROMETHEUS_OPERATORS],
              admin: { description: adminT('marmot:monitors:prometheusDownDescription') },
            },
            { name: 'prometheusDownThreshold', type: 'number' },
            {
              name: 'prometheusDegradedOperator',
              type: 'select',
              options: [...PROMETHEUS_OPERATORS],
              admin: { description: adminT('marmot:monitors:prometheusDegradedDescription') },
            },
            { name: 'prometheusDegradedThreshold', type: 'number' },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'prometheusAggregate',
              type: 'select',
              defaultValue: 'worst',
              options: [...PROMETHEUS_AGGREGATES],
              admin: { description: adminT('marmot:monitors:prometheusAggregateDescription') },
            },
            {
              name: 'prometheusNoDataStatus',
              type: 'select',
              defaultValue: 'down',
              options: PROMETHEUS_STATUS_OPTIONS,
              admin: { description: adminT('marmot:monitors:prometheusNoDataStatusDescription') },
            },
            {
              name: 'prometheusErrorStatus',
              type: 'select',
              defaultValue: 'down',
              options: PROMETHEUS_STATUS_OPTIONS,
              admin: { description: adminT('marmot:monitors:prometheusErrorStatusDescription') },
            },
          ],
        },
      ],
    },

    // ---- SMTP -----------------------------------------------------------------------------------
    {
      name: 'smtpSecurity',
      type: 'select',
      defaultValue: 'opportunistic',
      options: [
        { label: adminT('marmot:labels:starttlsOpportunistic'), value: 'opportunistic' },
        { label: adminT('marmot:labels:starttlsRequired'), value: 'starttls' },
        { label: adminT('marmot:labels:smtps'), value: 'secure' },
        { label: adminT('marmot:labels:starttlsIgnore'), value: 'nostarttls' },
      ],
      admin: {
        condition: typeIn(MAIL_TYPES),
        description: adminT('marmot:monitors:mailSecurityDescription'),
      },
    },
    {
      type: 'collapsible',
      label: adminT('marmot:labels:mailLogin'),
      admin: { condition: typeIn(['imap', 'pop3']), initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'mailUsername',
              type: 'text',
              admin: { description: adminT('marmot:monitors:mailUsernameDescription') },
            },
            { name: 'mailPassword', type: 'text' },
          ],
        },
      ],
    },

    // ---- UDP ------------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'UDP',
      admin: { condition: (data) => data?.type === 'udp', initCollapsed: false },
      fields: [
        {
          name: 'udpPayload',
          type: 'textarea',
          admin: { description: adminT('marmot:monitors:udpPayloadDescription') },
        },
        {
          type: 'row',
          fields: [
            {
              name: 'udpPayloadEncoding',
              type: 'select',
              defaultValue: 'text',
              options: [
                { label: adminT('marmot:labels:text'), value: 'text' },
                { label: adminT('marmot:labels:hex'), value: 'hex' },
              ],
            },
            {
              name: 'udpResponseMatch',
              type: 'select',
              defaultValue: 'none',
              options: [
                { label: adminT('marmot:labels:udpNoResponse'), value: 'none' },
                { label: adminT('marmot:labels:udpAnyResponse'), value: 'any' },
                { label: adminT('marmot:labels:keyword'), value: 'keyword' },
                { label: adminT('marmot:labels:regex'), value: 'regex' },
              ],
              admin: { description: adminT('marmot:monitors:udpResponseMatchDescription') },
            },
          ],
        },
        {
          name: 'udpResponsePattern',
          type: 'text',
          admin: {
            condition: (data) => ['keyword', 'regex'].includes(data?.udpResponseMatch),
            description: adminT('marmot:monitors:udpResponsePatternDescription'),
          },
        },
      ],
    },

    // ---- TLS handshake --------------------------------------------------------------------------
    {
      type: 'row',
      admin: { condition: (data) => data?.type === 'tls' },
      fields: [
        {
          name: 'tlsServername',
          type: 'text',
          admin: { description: adminT('marmot:monitors:tlsServernameDescription') },
        },
        {
          name: 'tlsAlpn',
          type: 'text',
          admin: { description: adminT('marmot:monitors:tlsAlpnDescription') },
        },
      ],
    },

    // ---- SFTP -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'SSH / SFTP',
      admin: { condition: typeIn(['sftp', 'ssh']), initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'sshUsername',
              type: 'text',
              admin: { description: adminT('marmot:monitors:sshUsernameDescription') },
            },
            {
              name: 'sshAuthMethod',
              type: 'select',
              defaultValue: 'password',
              options: [
                { label: adminT('marmot:labels:password'), value: 'password' },
                { label: adminT('marmot:labels:privateKey'), value: 'privateKey' },
              ],
            },
          ],
        },
        {
          name: 'sshPassword',
          type: 'text',
          admin: { condition: (data) => data?.sshAuthMethod !== 'privateKey' },
        },
        {
          name: 'sshPrivateKey',
          type: 'textarea',
          admin: { condition: (data) => data?.sshAuthMethod === 'privateKey' },
        },
        {
          name: 'sshPassphrase',
          type: 'text',
          admin: { condition: (data) => data?.sshAuthMethod === 'privateKey' },
        },
        {
          name: 'sftpPath',
          type: 'text',
          admin: {
            condition: (data) => data?.type === 'sftp',
            description: adminT('marmot:monitors:sftpPathDescription'),
          },
        },
        {
          name: 'sshCommand',
          type: 'textarea',
          admin: {
            condition: (data) => data?.type === 'ssh',
            description: adminT('marmot:monitors:sshCommandDescription'),
          },
        },
        {
          type: 'row',
          admin: { condition: (data) => data?.type === 'ssh' },
          fields: [
            {
              name: 'sshExpectedExitCode',
              type: 'number',
              defaultValue: 0,
              admin: { description: adminT('marmot:monitors:sshExpectedExitCodeDescription') },
            },
            {
              name: 'sshExpectedOutput',
              type: 'text',
              admin: { description: adminT('marmot:monitors:sshExpectedOutputDescription') },
            },
          ],
        },
      ],
    },

    // ---- RabbitMQ -------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'RabbitMQ',
      admin: { condition: (data) => data?.type === 'rabbitmq', initCollapsed: false },
      fields: [
        {
          name: 'rabbitmqNodes',
          type: 'text',
          hasMany: true,
          admin: { description: adminT('marmot:monitors:rabbitmqNodesDescription') },
        },
        {
          type: 'row',
          fields: [
            { name: 'rabbitmqUsername', type: 'text' },
            { name: 'rabbitmqPassword', type: 'text' },
          ],
        },
      ],
    },

    // ---- WebSocket ------------------------------------------------------------------------------
    {
      type: 'row',
      admin: { condition: (data) => data?.type === 'websocket-upgrade' },
      fields: [
        {
          name: 'wsSubprotocol',
          type: 'text',
          admin: { description: adminT('marmot:monitors:wsSubprotocolDescription') },
        },
        {
          name: 'wsIgnoreSecWebsocketAcceptHeader',
          type: 'checkbox',
          defaultValue: false,
          admin: {
            description: adminT('marmot:monitors:wsIgnoreSecWebsocketAcceptHeaderDescription'),
          },
        },
      ],
    },

    // ---- Game servers ---------------------------------------------------------------------------
    {
      type: 'row',
      admin: { condition: (data) => data?.type === 'gamedig' },
      fields: [
        {
          name: 'game',
          type: 'text',
          admin: { description: adminT('marmot:monitors:gameDescription') },
        },
        {
          name: 'gamedigGivenPortOnly',
          type: 'checkbox',
          defaultValue: true,
          admin: { description: adminT('marmot:monitors:gamedigGivenPortOnlyDescription') },
        },
      ],
    },

    // ---- Real browser ---------------------------------------------------------------------------
    {
      name: 'remoteBrowser',
      type: 'text',
      admin: {
        condition: (data) => data?.type === 'real-browser',
        placeholder: 'ws://browserless:3000',
        description: adminT('marmot:monitors:remoteBrowserDescription'),
      },
    },

    statusGroup,
  ],
}
