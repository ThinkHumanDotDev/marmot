import {
  ValidationError,
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type Field,
  type PayloadRequest,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminT } from '@/i18n/admin'
import {
  COMPONENT_IMPACTS,
  INCIDENT_STATUSES,
  LEGACY_INCIDENT_STYLES,
  deriveIncidentState,
  impactFromLegacyStyle,
  incidentTimeline,
  isComponentImpact,
  isIncidentStatus,
  legacyStyleFromImpact,
  legacyUpdate,
  sortUpdates,
  type ComponentImpact,
  type IncidentStatus,
  type TimelineUpdate,
} from '@/lib/incident-timeline'
import { emitIncidentUpdatePosted } from '@/server/status-pages/incident-events'

import type { Incident, StatusPage } from '@/payload-types'

type UpdateRow = NonNullable<Incident['updates']>[number]
type ImpactRow = NonNullable<UpdateRow['components']>[number]

/** `req.context` key: ids of updates synthesized from legacy incidents (not announced). */
const SILENT_UPDATES = 'incidentSilentUpdateIds'
/** `req.context` key: the status page loaded by `deriveFromStatusPage`. */
const STATUS_PAGE = 'incidentStatusPage'

/** Clock skew tolerated for client-supplied `postedAt` values. */
const FUTURE_TOLERANCE_MS = 60_000

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/** Same shape Payload uses for array row ids (24 hex chars), portable across adapters. */
const newRowId = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')

const invalid = (message: string, path: string): never => {
  throw new ValidationError({ collection: 'incidents', errors: [{ message, path }] })
}

function silentIds(req: PayloadRequest): Set<string> {
  const existing = req.context[SILENT_UPDATES]
  if (existing instanceof Set) return existing as Set<string>
  const created = new Set<string>()
  req.context[SILENT_UPDATES] = created
  return created
}

/** Monitor ids that are components of the status page. */
export function pageComponentIds(page: Pick<StatusPage, 'groups'>): Set<string> {
  const ids = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      const id = relId(row.monitor)
      if (id !== null) ids.add(String(id))
    }
  }
  return ids
}

const toTimeline = (rows: UpdateRow[]): TimelineUpdate[] =>
  rows.map((row) => ({
    id: row.id,
    status: row.status,
    message: row.message,
    postedAt: row.postedAt ?? '',
    editedAt: row.editedAt,
    components: (row.components ?? []).flatMap((c) => {
      const monitor = relId(c.monitor)
      return monitor === null ? [] : [{ monitor, impact: c.impact }]
    }),
  }))

/**
 * The incident's `organization` is derived from its status page (so it can never point at a page
 * of another organization). The page is kept in `req.context` for `buildTimeline`.
 */
const deriveFromStatusPage: CollectionBeforeChangeHook<Incident> = async ({
  data,
  originalDoc,
  req,
}) => {
  const statusPageId = relId(data.statusPage ?? originalDoc?.statusPage)
  if (statusPageId === null) {
    return invalid('An incident belongs to a status page.', 'statusPage')
  }

  const page = await req.payload.findByID({
    collection: 'status-pages',
    id: statusPageId,
    depth: 0,
    req,
    overrideAccess: true,
  })
  if (data.statusPage !== undefined || data.organization === undefined) {
    data.organization = relId(page.organization) as Incident['organization']
  }
  req.context[STATUS_PAGE] = page
  return data
}

/**
 * Normalises the update timeline and derives the incident's state from it (see
 * `src/lib/incident-timeline.ts`):
 *
 * - incidents without updates (created before the timeline, or by clients that only send
 *   `content`/`style`) get one update built from the legacy fields;
 * - posted updates are history: only their `message` may change later, which stamps `editedAt`;
 * - new updates get an id and `postedAt`, and may only name components of the page;
 * - setting `active` without sending `updates` posts a `resolved` (or `investigating`) update;
 * - `status`, `impact`, `active`, `resolvedAt`, `affectedMonitors` and the legacy `style` are derived,
 *   and resolving unpins.
 */
const buildTimeline: CollectionBeforeChangeHook<Incident> = ({
  data,
  originalDoc: storedDoc,
  operation,
  req,
}) => {
  // On update Payload passes the stored document merged with the request data; on create
  // `originalDoc` is an empty object.
  const originalDoc = operation === 'update' ? storedDoc : undefined
  const now = new Date().toISOString()
  const original = originalDoc?.updates ?? []
  const originalById = new Map(original.map((row) => [String(row.id), row]))
  const silent = silentIds(req)

  const synthesized = new Set<string>()
  let rows: UpdateRow[] = Array.isArray(data.updates) ? [...data.updates] : [...original]

  // Incidents stored before the timeline existed (no updates) gain one update built from their
  // legacy fields on their next write; so do new incidents from clients that only send
  // `content`/`style`.
  if (original.length === 0 && (originalDoc || rows.length === 0)) {
    const source = originalDoc ?? { ...data, createdAt: data.createdAt ?? now }
    const legacy = legacyUpdate({
      content: data.content ?? source.content,
      active: source.active,
      createdAt: source.createdAt,
      resolvedAt: source.resolvedAt,
      updatedAt: source.updatedAt,
    })
    const id = newRowId()
    synthesized.add(id)
    if (originalDoc) silent.add(id)
    rows = [{ ...legacy, id, components: [] }, ...rows]
    if (!isComponentImpact(data.impact)) {
      data.impact = impactFromLegacyStyle(data.style ?? originalDoc?.style)
    }
  }

  const page = req.context[STATUS_PAGE] as StatusPage | undefined
  const components = page ? pageComponentIds(page) : new Set<string>()
  const seenIds = new Set<string>()

  rows = rows.map((row, index): UpdateRow => {
    const path = `updates.${index}`
    const previous = row.id ? originalById.get(String(row.id)) : undefined
    if (previous && !seenIds.has(String(previous.id))) {
      // Posted updates are history: keep everything but the text.
      const message = row.message ?? previous.message ?? ''
      const edited = message !== (previous.message ?? '')
      seenIds.add(String(previous.id))
      return { ...previous, message, editedAt: edited ? now : (previous.editedAt ?? null) }
    }

    if (!isIncidentStatus(row.status)) invalid('Choose a valid update status.', `${path}.status`)
    const postedAt = row.postedAt ? new Date(row.postedAt) : new Date(now)
    if (Number.isNaN(postedAt.getTime())) invalid('Enter a valid date.', `${path}.postedAt`)
    if (postedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      invalid('Updates cannot be posted in the future.', `${path}.postedAt`)
    }

    const impacts = new Map<string, ImpactRow>()
    for (const [i, entry] of (row.components ?? []).entries()) {
      const monitor = relId(entry?.monitor)
      if (monitor === null || !components.has(String(monitor))) {
        invalid('Only components of this status page can be affected.', `${path}.components.${i}`)
      }
      if (!isComponentImpact(entry.impact)) {
        invalid('Choose a valid impact.', `${path}.components.${i}.impact`)
      }
      impacts.set(String(monitor), {
        monitor: monitor as ImpactRow['monitor'],
        impact: entry.impact,
      })
    }

    let id = row.id ? String(row.id) : newRowId()
    if (seenIds.has(id)) id = newRowId()
    seenIds.add(id)
    return {
      id,
      status: row.status,
      message: row.message ?? '',
      postedAt: postedAt.toISOString(),
      editedAt: null,
      components: [...impacts.values()],
    }
  })

  const declared: ComponentImpact = isComponentImpact(data.impact)
    ? data.impact
    : (originalDoc?.impact ?? 'operational')

  let state = deriveIncidentState(toTimeline(rows), declared)
  // `active` toggles from clients that do not post updates (Payload admin, old API clients).
  const postedNew = rows.some(
    (row) => !originalById.has(String(row.id)) && !synthesized.has(String(row.id)),
  )
  const wasActive = originalDoc ? originalDoc.active !== false : true
  if (
    !postedNew &&
    typeof data.active === 'boolean' &&
    data.active !== wasActive &&
    data.active !== state.active
  ) {
    const status: IncidentStatus = data.active ? 'investigating' : 'resolved'
    rows.push({
      id: newRowId(),
      status,
      message: '',
      postedAt: now,
      editedAt: null,
      components: [],
    })
    state = deriveIncidentState(toTimeline(rows), declared)
  }

  data.updates = rows
  data.status = state.status
  data.impact = state.impact
  data.active = state.active
  data.resolvedAt = state.resolvedAt
  data.affectedMonitors = state.components.map((row) => ({
    monitor: row.monitor as ImpactRow['monitor'],
    impact: row.impact,
  }))
  data.style = legacyStyleFromImpact(state.impact)
  if (!state.active) data.pinned = false

  return data
}

/** Announces every newly posted update to `onIncidentUpdatePosted` listeners (subscribers, #104). */
const announceUpdates: CollectionAfterChangeHook<Incident> = async ({
  doc,
  previousDoc,
  operation,
  req,
}) => {
  const silent = silentIds(req)
  const before = new Set(
    operation === 'create' ? [] : (previousDoc?.updates ?? []).map((row) => String(row.id)),
  )
  const fresh = sortUpdates(toTimeline(doc.updates ?? [])).filter(
    (row) => !before.has(String(row.id)) && !silent.has(String(row.id)),
  )
  let previousStatus: IncidentStatus | null =
    operation === 'create' || !previousDoc ? null : incidentTimeline(previousDoc).state.status
  for (const timelineRow of fresh) {
    const update = (doc.updates ?? []).find((row) => String(row.id) === String(timelineRow.id))
    if (!update) continue
    const kind =
      previousStatus === null
        ? 'opened'
        : update.status === 'resolved'
          ? 'resolved'
          : previousStatus === 'resolved'
            ? 'reopened'
            : 'updated'
    await emitIncidentUpdatePosted({
      payload: req.payload,
      incident: doc,
      update,
      kind,
      previousStatus,
    })
    previousStatus = update.status
  }
  return doc
}

const impactOptions = COMPONENT_IMPACTS.map((impact) => ({ label: impact, value: impact }))

const componentFields: Field[] = [
  {
    type: 'row',
    fields: [
      {
        // Not required: deleting a monitor nulls the reference (history keeps the row) instead of
        // failing on the NOT NULL constraint. New updates must name a monitor (see buildTimeline).
        name: 'monitor',
        type: 'relationship',
        relationTo: 'monitors',
        filterOptions: ({ data }): Where | true => {
          const organization = relId((data as { organization?: unknown })?.organization)
          return organization === null ? true : { organization: { equals: organization } }
        },
      },
      {
        name: 'impact',
        type: 'select',
        required: true,
        defaultValue: 'major_outage',
        options: impactOptions,
      },
    ],
  },
]

/**
 * Incidents are announcements on a status page with a timeline of updates. Members with
 * `status-page:*` manage them; the public reads them through `GET /api/status-pages/:slug/public`
 * (server side, `overrideAccess`), so the collection itself is not readable anonymously.
 */
export const Incidents: CollectionConfig = {
  slug: 'incidents',
  admin: {
    useAsTitle: 'title',
    group: 'Status pages',
    defaultColumns: ['title', 'statusPage', 'status', 'impact', 'pinned', 'createdAt'],
  },
  access: {
    read: orgScoped('status-page:read'),
    create: orgScoped('status-page:update'),
    update: orgScoped('status-page:update'),
    delete: orgScoped('status-page:update'),
  },
  hooks: {
    beforeChange: [deriveFromStatusPage, buildTimeline],
    afterChange: [announceUpdates],
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
      type: 'row',
      fields: [
        {
          name: 'status',
          type: 'select',
          index: true,
          options: INCIDENT_STATUSES.map((status) => ({ label: status, value: status })),
          admin: { readOnly: true, description: adminT('marmot:incidents:statusDescription') },
        },
        {
          name: 'impact',
          type: 'select',
          options: impactOptions,
          admin: { description: adminT('marmot:incidents:impactDescription') },
        },
      ],
    },
    {
      name: 'updates',
      type: 'array',
      admin: { description: adminT('marmot:incidents:updatesDescription') },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'status',
              type: 'select',
              required: true,
              defaultValue: 'investigating',
              options: INCIDENT_STATUSES.map((status) => ({ label: status, value: status })),
            },
            {
              name: 'postedAt',
              type: 'date',
              required: true,
              defaultValue: () => new Date().toISOString(),
              admin: { date: { pickerAppearance: 'dayAndTime' } },
            },
            {
              name: 'editedAt',
              type: 'date',
              admin: { date: { pickerAppearance: 'dayAndTime' }, readOnly: true },
            },
          ],
        },
        {
          name: 'message',
          type: 'textarea',
          admin: { description: adminT('marmot:incidents:contentDescription') },
        },
        {
          name: 'components',
          type: 'array',
          admin: { description: adminT('marmot:incidents:componentsDescription') },
          fields: componentFields,
        },
      ],
    },
    {
      name: 'affectedMonitors',
      type: 'array',
      admin: { readOnly: true, description: adminT('marmot:incidents:affectedDescription') },
      fields: componentFields,
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
      name: 'resolvedAt',
      type: 'date',
      admin: { date: { pickerAppearance: 'dayAndTime' }, readOnly: true },
    },
    // Legacy single-post fields, kept so incidents written before the timeline migrate lazily
    // (`legacyUpdate`) without losing data. New clients use `updates` and `impact`.
    {
      name: 'content',
      type: 'textarea',
      admin: { hidden: true },
    },
    {
      name: 'style',
      type: 'select',
      defaultValue: 'info',
      options: LEGACY_INCIDENT_STYLES.map((style) => ({ label: style, value: style })),
      admin: { hidden: true },
    },
  ],
  timestamps: true,
}
