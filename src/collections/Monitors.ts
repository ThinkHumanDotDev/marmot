import { randomBytes } from 'node:crypto'
import type { CollectionConfig, Field, Where } from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { attachDefaultNotifications } from './Notifications'
import { childLogger } from '@/lib/logger'
import { relationId } from '@/server/realtime/serialize'

import { HEARTBEAT_STATUSES } from './Heartbeats'

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
] as const

export const HTTP_TYPES = ['http', 'keyword', 'json-query']

/** Types whose target names a domain (URL or hostname), i.e. domain expiry can be looked up. */
export const DOMAIN_TYPES = [...HTTP_TYPES, 'port', 'ping', 'dns']

const isHttpType = (data: { type?: string } | undefined) =>
  Boolean(data?.type && HTTP_TYPES.includes(data.type))

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
    ],
    afterChange: [
      async ({ doc, req }) => {
        if (req.context?.skipEngineSync) return doc
        try {
          const { syncMonitor, removeMonitorSchedule, engineHooksEnabled } =
            await import('@/server/engine/scheduler')
          if (!engineHooksEnabled()) return doc
          if (doc.active) {
            await syncMonitor(doc)
          } else {
            await removeMonitorSchedule(doc.id)
          }
          // Live dashboards: `updateMonitorIntoList` delta to the organization room.
          const organizationId = relationId(doc.organization)
          if (organizationId) {
            const { emitMonitorUpdated } = await import('@/server/realtime/emitter')
            emitMonitorUpdated(organizationId, doc)
          }
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
      async ({ doc }) => {
        try {
          const { removeMonitorSchedule, engineHooksEnabled } =
            await import('@/server/engine/scheduler')
          if (!engineHooksEnabled()) return doc
          await removeMonitorSchedule(doc.id)
          const organizationId = relationId(doc.organization)
          if (organizationId) {
            const { emitMonitorDeleted } = await import('@/server/realtime/emitter')
            emitMonitorDeleted(organizationId, doc.id)
          }
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
      admin: { condition: (data) => isHttpType(data), placeholder: 'https://' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'hostname',
          type: 'text',
          admin: {
            condition: (data) => ['port', 'ping', 'dns'].includes(data?.type),
          },
        },
        {
          name: 'port',
          type: 'number',
          min: 1,
          max: 65535,
          admin: {
            condition: (data) => ['port', 'dns'].includes(data?.type),
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
      admin: { condition: (data) => isHttpType(data), initCollapsed: true },
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
            condition: (data) => isHttpType(data),
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
        condition: (data) => isHttpType(data),
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
      admin: { condition: (data) => data?.type === 'keyword', initCollapsed: false },
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
      admin: { condition: (data) => data?.type === 'json-query', initCollapsed: false },
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
      admin: { condition: (data) => isHttpType(data), initCollapsed: true },
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

    statusGroup,
  ],
}
