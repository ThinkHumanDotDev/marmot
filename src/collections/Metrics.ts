import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionConfig,
  FieldAccess,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  DEFAULT_METRIC_VIEW,
  METRIC_AGGREGATIONS,
  METRIC_DESCRIPTION_MAX_LENGTH,
  METRIC_MAX_DECIMALS,
  METRIC_NAME_MAX_LENGTH,
  METRIC_SOURCES,
  METRIC_SUFFIX_MAX_LENGTH,
  METRIC_VIEWS,
} from '@/lib/metrics'
import type { Metric } from '@/payload-types'
import { apiError } from '@/server/errors'

import { relId } from './shared'

/** Written by the server only (`overrideAccess: true` bypasses field access). */
const serverOnly: FieldAccess = () => false

const idList = (value: unknown): (string | number)[] =>
  Array.isArray(value) ? value.map(relId).filter((id): id is string | number => id !== null) : []

/**
 * A metric's monitor and status pages must belong to its organization, and a monitor-backed metric
 * needs a monitor. Runs for every write, so neither the API nor the admin panel can link a metric
 * to another organization's resources.
 */
const checkRelations: CollectionBeforeChangeHook<Metric> = async ({ data, originalDoc, req }) => {
  const organization = relId(data.organization ?? originalDoc?.organization)
  if (organization === null) return data
  const source = data.source ?? originalDoc?.source ?? 'push'
  const monitor = relId(data.monitor === undefined ? originalDoc?.monitor : data.monitor)

  if (source === 'monitor') {
    if (monitor === null) throw apiError('metricMonitorRequired', 400)
    const found = await req.payload.find({
      collection: 'monitors',
      where: { and: [{ id: { equals: monitor } }, { organization: { equals: organization } }] },
      limit: 1,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      req,
      select: { name: true },
    })
    if (found.docs.length === 0) throw apiError('metricMonitorRequired', 400)
  } else if (data.monitor !== undefined) {
    data.monitor = null
  }

  if (data.statusPages !== undefined) {
    const pages = [...new Set(idList(data.statusPages).map(String))]
    if (pages.length > 0) {
      const found = await req.payload.find({
        collection: 'status-pages',
        where: { and: [{ id: { in: pages } }, { organization: { equals: organization } }] },
        limit: pages.length,
        depth: 0,
        pagination: false,
        overrideAccess: true,
        req,
        select: { slug: true },
      })
      if (found.docs.length !== pages.length) throw apiError('metricStatusPagesInvalid', 400)
      data.statusPages = found.docs.map((doc) => doc.id) as Metric['statusPages']
    } else {
      data.statusPages = []
    }
  }
  return data
}

/** A deleted metric takes its rollups with it (no hooks run on `metric-stats`). */
const deleteStats: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.db.deleteMany({
    collection: 'metric-stats',
    where: { metric: { equals: id } },
    req,
  })
}

/**
 * Custom metrics of an organization (#155): business figures such as an error rate or a queue
 * backlog, published on status pages. Values are either pushed
 * (`POST /api/orgs/:orgId/metrics/:id/points`, `metric:push`) or read from a monitor's recorded
 * value (Prometheus query monitors). Pushed points are folded straight into `metric-stats` rollups;
 * no raw points are stored.
 *
 * A metric appears on a status page only when it is `visible` and the page is one of its
 * `statusPages` (`src/server/metrics/public.ts`).
 */
export const Metrics: CollectionConfig = {
  slug: 'metrics',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('monitoring'),
    defaultColumns: ['name', 'source', 'aggregation', 'organization', 'visible', 'lastPushAt'],
    description: adminT('marmot:metrics:description'),
  },
  access: {
    read: orgScoped('metric:read'),
    create: orgScoped('metric:create'),
    update: orgScoped('metric:update'),
    delete: orgScoped('metric:delete'),
  },
  hooks: { beforeChange: [checkRelations], beforeDelete: [deleteStats] },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'name', type: 'text', required: true, maxLength: METRIC_NAME_MAX_LENGTH },
    { name: 'description', type: 'textarea', maxLength: METRIC_DESCRIPTION_MAX_LENGTH },
    {
      name: 'suffix',
      type: 'text',
      maxLength: METRIC_SUFFIX_MAX_LENGTH,
      admin: { description: adminT('marmot:metrics:suffixDescription') },
    },
    {
      name: 'decimals',
      type: 'number',
      required: true,
      defaultValue: 0,
      min: 0,
      max: METRIC_MAX_DECIMALS,
    },
    {
      name: 'aggregation',
      type: 'select',
      required: true,
      defaultValue: 'average',
      options: [...METRIC_AGGREGATIONS],
      admin: { description: adminT('marmot:metrics:aggregationDescription') },
    },
    {
      name: 'defaultView',
      type: 'select',
      required: true,
      defaultValue: DEFAULT_METRIC_VIEW,
      options: [...METRIC_VIEWS],
    },
    {
      name: 'thresholds',
      type: 'group',
      admin: { description: adminT('marmot:metrics:thresholdsDescription') },
      fields: [
        { name: 'warning', type: 'number' },
        { name: 'critical', type: 'number' },
      ],
    },
    {
      name: 'showThresholdState',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: adminT('marmot:metrics:showThresholdStateDescription') },
    },
    {
      name: 'source',
      type: 'select',
      required: true,
      defaultValue: 'push',
      options: [...METRIC_SOURCES],
      admin: { position: 'sidebar', description: adminT('marmot:metrics:sourceDescription') },
    },
    {
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
      index: true,
      maxDepth: 0,
      admin: {
        position: 'sidebar',
        condition: (data) => data?.source === 'monitor',
      },
    },
    {
      name: 'visible',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: { position: 'sidebar', description: adminT('marmot:metrics:visibleDescription') },
    },
    {
      name: 'statusPages',
      type: 'relationship',
      relationTo: 'status-pages',
      hasMany: true,
      maxDepth: 0,
      admin: { position: 'sidebar' },
    },
    { name: 'order', type: 'number', defaultValue: 0, admin: { position: 'sidebar' } },
    {
      name: 'lastValue',
      type: 'number',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'lastPushAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
  timestamps: true,
}
