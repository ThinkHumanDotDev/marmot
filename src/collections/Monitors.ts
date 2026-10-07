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
import { MONITOR_TARGET_FIELDS, monitorTargetProblem } from '@/server/security/monitor-targets'
import { outboundGuardActive } from '@/server/security/outbound-guard'

import { HEARTBEAT_STATUSES } from './Heartbeats'
import { relId } from './shared'
import { adminGroup, adminT } from '@/i18n/admin'
import { userErrorText } from '@/server/request-locale'

const log = childLogger('monitors')

/**
 * Monitor types shipped with Marmot. Keep in sync with `src/server/monitor-types/*`.
 * The engine looks types up at runtime (`getMonitorType`), this list only drives the admin select.
 */
export const MONITOR_TYPES = [
  { label: 'HTTP(s)', value: 'http' },
  { label: adminT('marmot:labels:httpKeyword'), value: 'keyword' },
  { label: adminT('marmot:labels:httpJsonQuery'), value: 'json-query' },
  { label: adminT('marmot:labels:tcpPort'), value: 'port' },
  { label: 'Ping', value: 'ping' },
  { label: 'DNS', value: 'dns' },
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
      name: 'lastPushAt',
      type: 'date',
      admin: {
        date: { pickerAppearance: 'dayAndTime' },
        description: adminT('marmot:monitors:lastPushAtDescription'),
      },
    },
  ],
}

/** Restrict a relationship picker to documents of the monitor's organization. */
const sameOrganization = ({ data }: { data?: { organization?: unknown } }): Where | boolean =>
  data?.organization ? { organization: { equals: relId(data.organization) } } : true

/**
 * Tags, notification channels, the proxy and the Docker host must belong to the monitor's
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
        errors: [{ message: userErrorText(req, 'monitorForeignReference'), path: check.path }],
      })
    }
  }
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
      enforceOutboundPolicy,
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
          'monitor-incidents',
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
      name: 'weight',
      type: 'number',
      defaultValue: 2000,
      admin: { position: 'sidebar', description: adminT('marmot:monitors:weightDescription') },
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
        description: adminT('marmot:monitors:proxyDescription'),
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
          admin: { condition: typeIn(HOST_TYPES) },
        },
        {
          name: 'port',
          type: 'number',
          min: 1,
          max: 65535,
          admin: {
            condition: typeIn(PORT_TYPES),
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
      name: 'upsideDown',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: adminT('marmot:monitors:upsideDownDescription') },
    },

    // ---- HTTP -----------------------------------------------------------------------------------
    {
      type: 'collapsible',
      label: adminT('marmot:labels:httpOptions'),
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
            condition: typeIn(HTTP_TYPES),
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
    {
      name: 'certInfo',
      type: 'json',
      admin: {
        readOnly: true,
        condition: typeIn(HTTP_TYPES),
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
      admin: { condition: (data) => data?.type === 'dns' },
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
          admin: { description: adminT('marmot:monitors:sftpPathDescription') },
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
