import {
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'

import type { Incident, StatusPage } from '@/payload-types'
import { adminT } from '@/i18n/admin'
import { COMPONENT_IMPACTS } from '@/lib/status-page-components'

export const INCIDENT_STYLES = ['info', 'warning', 'danger', 'primary'] as const
export type IncidentStyle = (typeof INCIDENT_STYLES)[number]

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/**
 * The incident's `organization` is derived from its status page (so it can never point at a page
 * of another organization), and resolving an incident stamps `resolvedAt` / unpins it.
 */
const deriveFromStatusPage: CollectionBeforeChangeHook<Incident> = async ({
  data,
  originalDoc,
  req,
}) => {
  const statusPageId = relId(data.statusPage ?? originalDoc?.statusPage)
  if (statusPageId === null) {
    throw new ValidationError({
      collection: 'incidents',
      errors: [{ message: 'An incident belongs to a status page.', path: 'statusPage' }],
    })
  }

  const affected = Array.isArray(data.affectedComponents) ? data.affectedComponents : []
  let page: StatusPage | null = null
  const loadPage = async () =>
    (page ??= await req.payload.findByID({
      collection: 'status-pages',
      id: statusPageId,
      depth: 0,
      req,
      overrideAccess: true,
    }))

  if (data.statusPage !== undefined || data.organization === undefined) {
    data.organization = relId((await loadPage()).organization) as Incident['organization']
  }

  // Every affected component must be a component (group row) of the incident's page.
  if (affected.length > 0) {
    const known = new Set<string>()
    for (const group of (await loadPage()).groups ?? []) {
      for (const row of group.monitors ?? []) if (row.id) known.add(String(row.id))
    }
    const ids = affected.map((row) => String(row?.component ?? ''))
    if (ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) {
      throw new ValidationError({
        collection: 'incidents',
        errors: [
          {
            message: 'Each affected component must be listed once and belong to the status page.',
            path: 'affectedComponents',
          },
        ],
      })
    }
  }

  const wasActive = originalDoc?.active ?? true
  const isActive = data.active ?? wasActive
  if (!isActive) {
    data.resolvedAt ??= originalDoc?.resolvedAt ?? new Date().toISOString()
    data.pinned = false
  } else if (wasActive === false && isActive) {
    data.resolvedAt = null
  }

  return data
}

/**
 * Incidents are announcements on a status page. Members with `status-page:*` manage them; the
 * public reads them through `GET /api/status-pages/:slug/public` (server side, `overrideAccess`),
 * so the collection itself is not readable anonymously.
 */
export const Incidents: CollectionConfig = {
  slug: 'incidents',
  admin: {
    useAsTitle: 'title',
    group: 'Status pages',
    defaultColumns: ['title', 'statusPage', 'style', 'pinned', 'active', 'createdAt'],
  },
  access: {
    read: orgScoped('status-page:read'),
    create: orgScoped('status-page:update'),
    update: orgScoped('status-page:update'),
    delete: orgScoped('status-page:update'),
  },
  hooks: {
    beforeChange: [deriveFromStatusPage],
  },
  indexes: [{ fields: ['statusPage', 'active', 'pinned'] }],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: {
        position: 'sidebar',
        description: adminT('marmot:incidents:organizationDescription'),
      },
    },
    {
      name: 'statusPage',
      type: 'relationship',
      relationTo: 'status-pages',
      required: true,
      index: true,
      filterOptions: ({ data }): Where | true => {
        const organization = relId((data as { organization?: unknown })?.organization)
        return organization === null ? true : { organization: { equals: organization } }
      },
    },
    { name: 'title', type: 'text', required: true },
    {
      name: 'content',
      type: 'textarea',
      admin: { description: adminT('marmot:incidents:contentDescription') },
    },
    {
      name: 'style',
      type: 'select',
      defaultValue: 'info',
      options: INCIDENT_STYLES.map((style) => ({ label: style, value: style })),
    },
    {
      type: 'row',
      fields: [
        {
          name: 'pinned',
          type: 'checkbox',
          defaultValue: true,
          admin: { description: adminT('marmot:incidents:pinnedDescription') },
        },
        {
          name: 'active',
          type: 'checkbox',
          defaultValue: true,
          index: true,
          admin: { description: adminT('marmot:incidents:activeDescription') },
        },
      ],
    },
    {
      // Components (status page group rows, by row id) this incident affects while active. A static
      // component's status comes only from these impacts and maintenance windows.
      name: 'affectedComponents',
      type: 'array',
      admin: { description: adminT('marmot:incidents:affectedComponentsDescription') },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'component',
              type: 'text',
              required: true,
              admin: { description: adminT('marmot:incidents:componentDescription') },
            },
            {
              name: 'impact',
              type: 'select',
              required: true,
              defaultValue: 'partial_outage',
              options: COMPONENT_IMPACTS.map((impact) => ({ label: impact, value: impact })),
            },
          ],
        },
      ],
    },
    {
      name: 'resolvedAt',
      type: 'date',
      admin: { date: { pickerAppearance: 'dayAndTime' }, readOnly: true },
    },
  ],
  timestamps: true,
}
