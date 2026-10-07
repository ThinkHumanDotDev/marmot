import {
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type PayloadRequest,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import { COMPONENT_IMPACTS, INCIDENT_STATUSES, isComponentImpact } from '@/lib/incident-timeline'
import { TEMPLATE_KINDS, TEMPLATE_MAX_DURATION_MINUTES } from '@/lib/templates'
import type { ErrorKey } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'

import type { StatusPage, Template } from '@/payload-types'

import { pageComponentIds } from './Incidents'
import { relId } from './shared'

type ComponentRow = NonNullable<Template['components']>[number]

const invalid = (req: PayloadRequest, key: ErrorKey, path: string): never => {
  throw new ValidationError({
    collection: 'templates',
    errors: [{ message: userErrorText(req, key), path }],
  })
}

/**
 * Keeps a template consistent:
 * - the status page (optional) must belong to the template's organization;
 * - default components must be components of that page, once each, with a valid impact. Components
 *   stored earlier that the page no longer has are dropped instead of failing the save;
 * - fields that do not apply to the kind are cleared (maintenance has no status, impact or
 *   components; incidents have no duration).
 */
const normalize: CollectionBeforeChangeHook<Template> = async ({ data, originalDoc, req }) => {
  if (typeof data.name === 'string') data.name = data.name.trim()
  const kind = data.kind ?? originalDoc?.kind ?? 'incident'
  const organization = relId(data.organization ?? originalDoc?.organization)
  const statusPageId = relId(
    data.statusPage !== undefined ? data.statusPage : originalDoc?.statusPage,
  )

  let page: StatusPage | null = null
  if (statusPageId !== null) {
    page = await req.payload
      .findByID({
        collection: 'status-pages',
        id: statusPageId,
        depth: 0,
        req,
        overrideAccess: true,
      })
      .catch(() => null)
    if (!page || String(relId(page.organization)) !== String(organization)) {
      invalid(req, 'templateStatusPageInvalid', 'statusPage')
    }
  }

  if (kind === 'maintenance') {
    data.status = null
    data.impact = null
    data.components = []
    return data
  }
  data.duration = null

  const rows: ComponentRow[] = Array.isArray(data.components)
    ? data.components
    : (originalDoc?.components ?? [])
  const stored = new Set((originalDoc?.components ?? []).map((row) => String(row.component)))
  const known = page ? pageComponentIds(page) : new Set<string>()
  const seen = new Set<string>()
  const kept: ComponentRow[] = []
  for (const [index, row] of rows.entries()) {
    const component = row?.component ? String(row.component) : ''
    if (!known.has(component)) {
      if (stored.has(component)) continue
      invalid(req, 'templateComponentsInvalid', `components.${index}.component`)
    }
    if (seen.has(component)) invalid(req, 'templateComponentsInvalid', `components.${index}`)
    if (!isComponentImpact(row.impact)) {
      invalid(req, 'incidentImpactInvalid', `components.${index}.impact`)
    }
    seen.add(component)
    kept.push({ component, impact: row.impact })
  }
  data.components = kept
  return data
}

/**
 * `beforeDelete` of `status-pages`: templates bound to the page become organization-wide and lose
 * its components, so no dangling id is left behind on either database.
 */
export const detachTemplatesFromStatusPage: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.update({
    collection: 'templates',
    where: { statusPage: { equals: id } },
    data: { statusPage: null, components: [] },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

const impactOptions = COMPONENT_IMPACTS.map((impact) => ({ label: impact, value: impact }))
const notMaintenance = (data: Partial<Template>) => data?.kind !== 'maintenance'

/**
 * Incident and maintenance templates (#153): pre-approved wording the incident dialog, the update
 * composer and the maintenance form pre-fill from (`src/lib/templates.ts`). Everyone in the
 * organization reads them; members and above write them.
 */
export const Templates: CollectionConfig = {
  slug: 'templates',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('statusPages'),
    defaultColumns: ['name', 'kind', 'statusPage', 'organization'],
  },
  access: {
    read: orgScoped('template:read'),
    create: orgScoped('template:create'),
    update: orgScoped('template:update'),
    delete: orgScoped('template:delete'),
  },
  indexes: [{ fields: ['organization', 'name'], unique: true }],
  hooks: {
    beforeChange: [normalize],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    {
      type: 'row',
      fields: [
        { name: 'name', type: 'text', required: true, maxLength: 100 },
        {
          name: 'kind',
          type: 'select',
          required: true,
          defaultValue: 'incident',
          options: TEMPLATE_KINDS.map((kind) => ({ label: kind, value: kind })),
          admin: { description: adminT('marmot:templates:kindDescription') },
        },
      ],
    },
    { name: 'title', type: 'text', maxLength: 200 },
    {
      name: 'body',
      type: 'textarea',
      admin: { description: adminT('marmot:templates:bodyDescription') },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          options: INCIDENT_STATUSES.map((status) => ({ label: status, value: status })),
          admin: { condition: notMaintenance },
        },
        {
          name: 'impact',
          type: 'select',
          options: impactOptions,
          admin: {
            condition: notMaintenance,
            description: adminT('marmot:templates:impactDescription'),
          },
        },
        {
          name: 'duration',
          type: 'number',
          min: 1,
          max: TEMPLATE_MAX_DURATION_MINUTES,
          admin: {
            condition: (data) => data?.kind === 'maintenance',
            description: adminT('marmot:templates:durationDescription'),
          },
        },
      ],
    },
    {
      name: 'statusPage',
      type: 'relationship',
      relationTo: 'status-pages',
      index: true,
      filterOptions: ({ data }): Where | true => {
        const organization = relId((data as { organization?: unknown })?.organization)
        return organization === null ? true : { organization: { equals: organization } }
      },
      admin: { description: adminT('marmot:templates:statusPageDescription') },
    },
    {
      name: 'components',
      type: 'array',
      admin: {
        condition: notMaintenance,
        description: adminT('marmot:templates:componentsDescription'),
      },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'component', type: 'text', required: true },
            {
              name: 'impact',
              type: 'select',
              required: true,
              defaultValue: 'major_outage',
              options: impactOptions,
            },
          ],
        },
      ],
    },
  ],
  timestamps: true,
}
