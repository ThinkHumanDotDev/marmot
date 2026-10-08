import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionConfig,
  FieldAccess,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { OTEL_NAME_MAX_LENGTH } from '@/lib/otel'
import type { OtelCollector } from '@/payload-types'
import { translateError } from '@/server/errors'
import { otelEndpointProblem } from '@/server/otel/endpoint'
import { invalidateOtelCollectors } from '@/server/otel/resolve'
import { userLocale } from '@/server/request-locale'

import { detachMonitorRelation, relId } from './shared'

/** Written by the server only (`overrideAccess: true` bypasses field access). */
const serverOnly: FieldAccess = () => false

/** Only one default collector per organization (like the default proxy). */
const keepSingleDefault: CollectionAfterChangeHook<OtelCollector> = async ({ doc, req }) => {
  if (!doc.default || req.context?.skipOtelDefault) return doc
  const organization = relId(doc.organization)
  if (organization === null) return doc
  await req.payload.update({
    collection: 'otel-collectors',
    where: {
      and: [
        { organization: { equals: organization } },
        { default: { equals: true } },
        { id: { not_equals: doc.id } },
      ],
    },
    data: { default: false },
    depth: 0,
    req,
    overrideAccess: true,
    context: { skipOtelDefault: true },
  })
  return doc
}

/** This process forgets its cached collectors at once; other processes within the cache TTL. */
const forgetCached: CollectionAfterChangeHook<OtelCollector> = ({ doc }) => {
  invalidateOtelCollectors()
  return doc
}
const forgetDeleted: CollectionAfterDeleteHook<OtelCollector> = ({ doc }) => {
  invalidateOtelCollectors()
  return doc
}

/**
 * OpenTelemetry metrics collectors of an organization (#99, `otel-collector:read` to pick one for a
 * monitor, `otel-collector:manage` to change them; admins by default). The worker pushes every
 * check's metrics to the monitor's collector, or to the organization's `default` one, as OTLP/HTTP
 * JSON (`src/server/otel/`).
 *
 * `headers` (API keys and tokens of the backend) are sealed at rest with a key derived from
 * `PAYLOAD_SECRET` and never readable through the API; `headerNames` lists what is set. The routes
 * under `/api/orgs/:orgId/otel-collectors` write them (`src/server/otel/manage.ts`).
 */
export const OtelCollectors: CollectionConfig = {
  slug: 'otel-collectors',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('monitoring'),
    defaultColumns: ['name', 'endpoint', 'organization', 'active', 'default', 'lastExportAt'],
    description: adminT('marmot:otelCollectors:description'),
  },
  access: {
    read: orgScoped('otel-collector:read'),
    create: orgScoped('otel-collector:manage'),
    update: orgScoped('otel-collector:manage'),
    delete: orgScoped('otel-collector:manage'),
  },
  hooks: {
    afterChange: [keepSingleDefault, forgetCached],
    afterDelete: [forgetDeleted],
    beforeDelete: [detachMonitorRelation('otlpCollector')],
  },
  indexes: [{ fields: ['organization', 'default'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: OTEL_NAME_MAX_LENGTH },
    {
      name: 'endpoint',
      type: 'text',
      required: true,
      admin: { description: adminT('marmot:otelCollectors:endpointDescription') },
      validate: (
        value: unknown,
        { req, previousValue }: { req: { user?: unknown }; previousValue?: unknown },
      ) => {
        // Only new URLs are checked: bookkeeping writes of a collector saved before the outbound
        // guard was turned on must not fail (the export refuses the address anyway).
        if (previousValue !== undefined && value === previousValue) return true
        const problem = otelEndpointProblem(value)
        return problem ? translateError(userLocale(req.user), problem.key, problem.values) : true
      },
    },
    {
      // Sealed JSON object of header name → value (`src/server/otel/headers.ts`).
      name: 'headers',
      type: 'text',
      access: { read: serverOnly, create: serverOnly, update: serverOnly },
      admin: { hidden: true },
    },
    {
      name: 'headerNames',
      type: 'json',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true },
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:otelCollectors:activeDescription'),
      },
    },
    {
      name: 'default',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:otelCollectors:defaultDescription'),
      },
    },
    {
      name: 'lastExportAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'lastError',
      type: 'text',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
  timestamps: true,
}
