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
import { enforceEntitlementOnCreate } from '@/server/billing/entitlements'

import { HEARTBEAT_STATUSES } from './Heartbeats'
import { relId } from './shared'

const log = childLogger('monitors')

/**
 * Monitor types shipped with Marmot. Keep in sync with `src/server/monitor-types/*`.
 * The engine looks types up at runtime (`getMonitorType`), this list only drives the admin select.
 */
export const MONITOR_TYPES = [
  { label: 'HTTP(s)', value: 'http' },
  { label: 'HTTP(s) - Keyword', value: 'keyword' },
  { label: 'HTTP(s) - Json Query', value: 'json-query' },
  { label: 'TCP Port', value: 'port' },
  { label: 'Ping', value: 'ping' },
  { label: 'DNS', value: 'dns' },
  { label: 'Push', value: 'push' },
  { label: 'Group', value: 'group' },
  { label: 'Manual', value: 'manual' },
  { label: 'Docker Container', value: 'docker' },
  // Protocols
  { label: 'gRPC(s) - Keyword', value: 'grpc-keyword' },
  { label: 'WebSocket Upgrade', value: 'websocket-upgrade' },
  { label: 'MQTT', value: 'mqtt' },
  { label: 'Kafka Producer', value: 'kafka-producer' },
  { label: 'RabbitMQ', value: 'rabbitmq' },
  { label: 'SMTP', value: 'smtp' },
  { label: 'SNMP', value: 'snmp' },
  { label: 'NTP', value: 'ntp' },
  { label: 'SFTP', value: 'sftp' },
  { label: 'Radius', value: 'radius' },
  { label: 'Tailscale Ping', value: 'tailscale-ping' },
  { label: 'HTTP(s) - Browser Engine (Chrome/Chromium)', value: 'real-browser' },
  // Databases
  { label: 'MySQL/MariaDB', value: 'mysql' },
  { label: 'PostgreSQL', value: 'postgres' },
  { label: 'Microsoft SQL Server', value: 'sqlserver' },
  { label: 'MongoDB', value: 'mongodb' },
  { label: 'Redis', value: 'redis' },
  // Game servers
  { label: 'Steam Game Server', value: 'steam' },
  { label: 'GameDig', value: 'gamedig' },
] as const

export const HTTP_TYPES = ['http', 'keyword', 'json-query']
/** Types whose target is `url` (HTTP types plus the WebSocket and browser checks). */
export const URL_TYPES = [...HTTP_TYPES, 'websocket-upgrade', 'real-browser']
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

/** Types whose target names a domain (URL or hostname), i.e. domain expiry can be looked up. */
export const DOMAIN_TYPES = [...HTTP_TYPES, 'port', 'ping', 'dns']

type TypeData = { type?: string } | undefined
const typeIn = (list: string[]) => (data: TypeData) =>
  Boolean(data?.type && list.includes(data.type))

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
    description: 'Maintained by the worker. Mirrors the latest heartbeat.',
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
      name: 'lastPushAt',
      type: 'date',
      admin: {
        date: { pickerAppearance: 'dayAndTime' },
        description: 'Push monitors: time of the last call to the push endpoint.',
      },
    },
  ],
}

/** Restrict a relationship picker to documents of the monitor's organization. */
const sameOrganization = ({ data }: { data?: { organization?: unknown } }): Where | boolean =>
  data?.organization ? { organization: { equals: relId(data.organization) } } : true

/**
 * Tags, the proxy and the Docker host must belong to the monitor's organization. `filterOptions`
 * only guards the admin UI; this hook guards every API so a member cannot attach another
 * organization's proxy (and its credentials) or Docker host to their monitor.
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
        errors: [{ message: 'Each tag may only be added once.', path: 'tags' }],
      })
    }
    if (ids.length > 0) checks.push({ collection: 'tags', ids, path: 'tags' })
  }
  const proxy = relId(data.proxy)
  if (proxy !== null) checks.push({ collection: 'proxies', ids: [proxy], path: 'proxy' })
  const dockerHost = relId(data.dockerHost)
  if (dockerHost !== null) {
    checks.push({ collection: 'docker-hosts', ids: [dockerHost], path: 'dockerHost' })
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
        errors: [
          { message: 'Must belong to the same organization as the monitor.', path: check.path },
        ],
      })
    }
  }
  return data
}

export const Monitors: CollectionConfig = {
  slug: 'monitors',
  admin: {
    useAsTitle: 'name',
    group: 'Monitoring',
    defaultColumns: ['name', 'type', 'active', 'status.lastStatus', 'interval'],
  },
  // Org-scoped RBAC: viewers read, members write (see `src/access/permissions.ts`).
  access: {
    read: orgScoped('monitor:read'),
    create: orgScoped('monitor:create'),
    update: orgScoped('monitor:update'),
    delete: orgScoped('monitor:delete'),
  },
  indexes: [{ fields: ['organization', 'active'] }],
  hooks: {
    beforeChange: [
      ({ data }) => {
        // Push monitors need a token the push endpoint can address them by.
        if (data?.type === 'push' && !data.pushToken) {
          data.pushToken = randomBytes(16).toString('hex')
        }
        return data
      },
      // New monitors without explicit channels get the organization's default channels.
      attachDefaultNotifications,
      validateOrgReferences,
      // Plan limits (no-op unless BILLING_ENABLED).
      enforceEntitlementOnCreate('monitors'),
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
      admin: { position: 'sidebar', description: 'Paused monitors are not checked.' },
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
      admin: { position: 'sidebar', description: 'Group this monitor belongs to.' },
    },
    { name: 'description', type: 'textarea' },
    {
      name: 'tags',
      type: 'array',
      admin: { description: 'Tags (optionally with a value, e.g. env: prod) shown as chips.' },
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
        description: 'Channels alerted when this monitor changes status.',
      },
    },
    {
      name: 'weight',
      type: 'number',
      defaultValue: 2000,
      admin: { position: 'sidebar', description: 'Sort order on status pages.' },
    },

    // ---- Target ---------------------------------------------------------------------------------
    {
      name: 'url',
      type: 'text',
      admin: { condition: typeIn(URL_TYPES), placeholder: 'https://' },
    },
    {
      name: 'proxy',
      type: 'relationship',
      relationTo: 'proxies',
      filterOptions: sameOrganization,
      admin: {
        condition: typeIn(HTTP_TYPES),
        description: 'Send the request through this proxy (inactive proxies are skipped).',
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
          admin: { description: 'Container name or id.' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'hostname',
          type: 'text',
          admin: { condition: typeIn(HOST_TYPES) },
        },
        {
          name: 'port',
          type: 'number',
          min: 1,
          max: 65535,
          admin: {
            condition: typeIn(PORT_TYPES),
            description: 'DNS monitors: port of the resolver (default 53).',
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
          admin: { description: 'Seconds between checks (UI minimum 20).' },
        },
        {
          name: 'retryInterval',
          type: 'number',
          required: true,
          defaultValue: 60,
          min: 1,
          admin: { description: 'Seconds between checks while pending (retrying).' },
        },
        {
          name: 'maxRetries',
          type: 'number',
          required: true,
          defaultValue: 0,
          min: 0,
          admin: { description: 'Retries before the monitor is marked DOWN.' },
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
          admin: { description: 'Re-notify every N consecutive DOWN beats (0 = never).' },
        },
        {
          name: 'timeout',
          type: 'number',
          required: true,
          defaultValue: 48,
          min: 0,
          admin: { description: 'Request timeout in seconds (0 = 80% of the interval).' },
        },
      ],
    },
    {
      name: 'upsideDown',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'Flip status: a failed check counts as UP and vice versa.' },
    },

    // ---- HTTP -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'HTTP options',
      admin: { condition: typeIn(URL_TYPES), initCollapsed: true },
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
                { label: 'Form (x-www-form-urlencoded)', value: 'form' },
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
          admin: { description: 'JSON object of extra request headers.' },
        },
        {
          name: 'acceptedStatusCodes',
          type: 'text',
          hasMany: true,
          defaultValue: ['200-299'],
          admin: { description: 'Status codes or ranges counted as UP, e.g. 200-299, 304.' },
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
            condition: typeIn(HTTP_TYPES),
            description: 'Notify before the TLS certificate expires (tlsExpiryNotifyDays).',
          },
        },
        {
          name: 'domainExpiryNotification',
          type: 'checkbox',
          defaultValue: false,
          admin: {
            condition: (data) => isDomainType(data),
            description: 'Notify before the domain registration expires (domainExpiryNotifyDays).',
          },
        },
      ],
    },
    {
      name: 'certInfo',
      type: 'json',
      admin: {
        readOnly: true,
        condition: typeIn(HTTP_TYPES),
        description: 'Maintained by the worker: TLS certificate seen by the last HTTPS check.',
      },
    },
    {
      name: 'domainExpiry',
      type: 'json',
      admin: {
        readOnly: true,
        condition: (data) => isDomainType(data),
        description: 'Maintained by the worker: cached RDAP domain expiry lookup.',
      },
    },
    {
      type: 'collapsible',
      label: 'Keyword',
      admin: { condition: typeIn(KEYWORD_TYPES), initCollapsed: false },
      fields: [
        { name: 'keyword', type: 'text' },
        {
          name: 'invertKeyword',
          type: 'checkbox',
          defaultValue: false,
          admin: { description: 'UP when the keyword is absent.' },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'JSON query',
      admin: { condition: typeIn(JSON_QUERY_TYPES), initCollapsed: false },
      fields: [
        {
          name: 'jsonPath',
          type: 'text',
          admin: { description: 'JSONata expression, e.g. `$.status` or `data[0].ok`.' },
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

    // ---- Authentication -------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'Authentication',
      admin: { condition: typeIn(URL_TYPES), initCollapsed: true },
      fields: [
        {
          name: 'authMethod',
          type: 'select',
          defaultValue: 'none',
          options: [
            { label: 'None', value: 'none' },
            { label: 'HTTP Basic', value: 'basic' },
            { label: 'Bearer token', value: 'bearer' },
            { label: 'OAuth2 client credentials', value: 'oauth2-cc' },
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
      admin: { condition: (data) => data?.type === 'dns' },
      fields: [
        {
          name: 'dnsResolveServer',
          type: 'text',
          defaultValue: '1.1.1.1',
          admin: { description: 'Comma-separated resolver IPs or hostnames.' },
        },
        {
          name: 'dnsResolveType',
          type: 'select',
          defaultValue: 'A',
          options: ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'],
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
        description: 'Generated automatically. Call /api/push/<token> to report a heartbeat.',
      },
    },

    // ---- Manual ---------------------------------------------------------------------------------
    {
      name: 'manualStatus',
      type: 'select',
      options: [
        { label: 'Up', value: 'up' },
        { label: 'Down', value: 'down' },
        { label: 'Pending', value: 'pending' },
      ],
      admin: { condition: (data) => data?.type === 'manual' },
    },

    // ---- Databases (mysql, postgres, sqlserver, mongodb, redis) ---------------------------------
    {
      type: 'collapsible',
      label: 'Database',
      admin: { condition: typeIn(DATABASE_TYPES), initCollapsed: false },
      fields: [
        {
          name: 'databaseConnectionString',
          type: 'text',
          admin: {
            description:
              'Driver connection string, e.g. postgres://user:pass@host:5432/db, mysql://…, mongodb://…, redis://….',
          },
        },
        {
          name: 'databaseQuery',
          type: 'textarea',
          admin: {
            condition: typeIn(['mysql', 'postgres', 'sqlserver', 'mongodb']),
            description:
              'SQL statement to run (default SELECT 1). MongoDB: JSON command document (default {"ping": 1}).',
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
            { label: 'Keyword', value: 'keyword' },
            { label: 'JSON query', value: 'json-query' },
          ],
        },
        {
          name: 'mqttSuccessMessage',
          type: 'text',
          admin: { description: 'Keyword mode: the received message must contain this text.' },
        },
      ],
    },

    // ---- Kafka producer -------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'Kafka producer',
      admin: { condition: (data) => data?.type === 'kafka-producer', initCollapsed: false },
      fields: [
        {
          name: 'kafkaProducerBrokers',
          type: 'text',
          hasMany: true,
          admin: { description: 'Broker addresses, e.g. kafka1:9092.' },
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
            description:
              'JSON object with mechanism (plain, scram-sha-256, scram-sha-512) and username/password.',
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
          admin: { description: 'Proto definition of the service.' },
        },
        { name: 'grpcBody', type: 'textarea', admin: { description: 'JSON request body.' } },
        {
          name: 'grpcMetadata',
          type: 'textarea',
          admin: { description: 'JSON object of request metadata.' },
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

    // ---- SMTP -----------------------------------------------------------------------------------
    {
      name: 'smtpSecurity',
      type: 'select',
      defaultValue: 'opportunistic',
      options: [
        { label: 'STARTTLS if offered', value: 'opportunistic' },
        { label: 'Require STARTTLS', value: 'starttls' },
        { label: 'SMTPS (implicit TLS)', value: 'secure' },
        { label: 'Ignore STARTTLS', value: 'nostarttls' },
      ],
      admin: { condition: (data) => data?.type === 'smtp' },
    },

    // ---- SFTP -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: 'SFTP',
      admin: { condition: (data) => data?.type === 'sftp', initCollapsed: false },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'sshUsername', type: 'text' },
            {
              name: 'sshAuthMethod',
              type: 'select',
              defaultValue: 'password',
              options: [
                { label: 'Password', value: 'password' },
                { label: 'Private key', value: 'privateKey' },
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
          admin: { description: 'Optional remote path that must exist.' },
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
          admin: { description: 'Management API base URLs, e.g. https://node1:15672.' },
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
          admin: { description: 'Comma-separated Sec-WebSocket-Protocol values.' },
        },
        {
          name: 'wsIgnoreSecWebsocketAcceptHeader',
          type: 'checkbox',
          defaultValue: false,
          admin: { description: 'Accept non-compliant servers that omit Sec-WebSocket-Accept.' },
        },
      ],
    },

    // ---- Game servers ---------------------------------------------------------------------------
    {
      type: 'row',
      admin: { condition: (data) => data?.type === 'gamedig' },
      fields: [
        { name: 'game', type: 'text', admin: { description: 'GameDig game id, e.g. minecraft.' } },
        {
          name: 'gamedigGivenPortOnly',
          type: 'checkbox',
          defaultValue: true,
          admin: { description: 'Do not probe the other ports a game commonly uses.' },
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
        description: 'Playwright-compatible remote browser websocket URL.',
      },
    },

    statusGroup,
  ],
}
