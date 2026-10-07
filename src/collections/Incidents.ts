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
import { adminGroup, adminT } from '@/i18n/admin'
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
import type { ErrorKey } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'
import { emitIncidentUpdatePosted } from '@/server/status-pages/incident-events'
import { assignPublicId } from '@/server/status-pages/public-ids'

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

/** Validation error in the language of the user the operation runs as (`errors.<key>`). */
const invalidKey = (req: PayloadRequest, key: ErrorKey, path: string): never =>
  invalid(userErrorText(req, key), path)

function silentIds(req: PayloadRequest): Set<string> {
  const existing = req.context[SILENT_UPDATES]
  if (existing instanceof Set) return existing as Set<string>
  const created = new Set<string>()
  req.context[SILENT_UPDATES] = created
  return created
}

/** Component ids (group row ids) of the status page. */
export function pageComponentIds(page: Pick<StatusPage, 'groups'>): Set<string> {
  const ids = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) if (row.id) ids.add(String(row.id))
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
    components: (row.components ?? []).flatMap((c) =>
      c?.component ? [{ component: String(c.component), impact: c.impact }] : [],
    ),
  }))

const impactKey = (rows: readonly ImpactRow[] | null | undefined): string =>
  (rows ?? [])
    .map((row) => `${row?.component}:${row?.impact}`)
    .sort()
    .join(',')

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
    return invalid(userErrorText(req, 'incidentStatusPageRequired'), 'statusPage')
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
 * - setting `active` without sending `updates` posts a `resolved` (or `investigating`) update, and
 *   editing `affectedComponents` posts the changed impacts with the current status;
 * - `status`, `impact`, `active`, `resolvedAt`, `affectedComponents` and the legacy `style` are
 *   derived,
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
      affectedComponents: source.affectedComponents,
      active: source.active,
      createdAt: source.createdAt,
      resolvedAt: source.resolvedAt,
      updatedAt: source.updatedAt,
    })
    const id = newRowId()
    synthesized.add(id)
    if (originalDoc) silent.add(id)
    rows = [{ ...legacy, id }, ...rows]
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

    if (!isIncidentStatus(row.status))
      invalidKey(req, 'incidentUpdateStatusInvalid', `${path}.status`)
    const postedAt = row.postedAt ? new Date(row.postedAt) : new Date(now)
    if (Number.isNaN(postedAt.getTime()))
      invalidKey(req, 'incidentPostedAtInvalid', `${path}.postedAt`)
    if (postedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      invalidKey(req, 'incidentPostedAtFuture', `${path}.postedAt`)
    }

    // Rows migrated from a stored incident keep their components even if the page changed since.
    const migrated = originalDoc !== undefined && synthesized.has(String(row.id))
    const impacts = new Map<string, ImpactRow>()
    for (const [i, entry] of (row.components ?? []).entries()) {
      const component = entry?.component ? String(entry.component) : ''
      if (!migrated && (!components.has(component) || impacts.has(component))) {
        invalidKey(req, 'incidentComponentsInvalid', `${path}.components.${i}`)
      }
      if (!isComponentImpact(entry.impact)) {
        invalidKey(req, 'incidentImpactInvalid', `${path}.components.${i}.impact`)
      }
      impacts.set(component, { component, impact: entry.impact })
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
  const postedNew = rows.some(
    (row) => !originalById.has(String(row.id)) && !synthesized.has(String(row.id)),
  )

  // Clients that edit `affectedComponents` directly (Payload admin, API clients of the component
  // model) post an update with the changed impacts and the current status.
  if (
    originalDoc &&
    !postedNew &&
    Array.isArray(data.affectedComponents) &&
    impactKey(data.affectedComponents) !== impactKey(originalDoc.affectedComponents)
  ) {
    const wanted = new Map<string, ComponentImpact>()
    for (const [i, row] of data.affectedComponents.entries()) {
      const component = row?.component ? String(row.component) : ''
      if (!components.has(component) || wanted.has(component)) {
        invalidKey(req, 'incidentComponentsInvalid', `affectedComponents.${i}`)
      }
      if (!isComponentImpact(row.impact))
        invalidKey(req, 'incidentImpactInvalid', `affectedComponents.${i}`)
      wanted.set(component, row.impact)
    }
    const changes: ImpactRow[] = []
    for (const [component, impact] of wanted) {
      const current = state.components.find((c) => c.component === component)?.impact
      if (current !== impact) changes.push({ component, impact })
    }
    for (const current of state.components) {
      if (!wanted.has(current.component) && current.impact !== 'operational') {
        changes.push({ component: current.component, impact: 'operational' })
      }
    }
    if (changes.length > 0) {
      rows.push({
        id: newRowId(),
        status: state.status === 'resolved' ? 'investigating' : state.status,
        message: '',
        postedAt: now,
        editedAt: null,
        components: changes,
      })
      state = deriveIncidentState(toTimeline(rows), declared)
    }
  }

  // `active` toggles from clients that do not post updates (Payload admin, old API clients).
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
  data.affectedComponents = state.components.map((row) => ({
    component: row.component,
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
      req,
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
        // A component id (group row id of the page, see src/lib/status-page-components.ts).
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
    group: adminGroup('statusPages'),
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
      // Short id of the public permalink (#107); assigned by the hook, never by clients.
      name: 'publicId',
      type: 'text',
      index: true,
      hooks: { beforeChange: [assignPublicId('incidents')] },
      admin: {
        position: 'sidebar',
        readOnly: true,
        description: adminT('marmot:incidents:publicIdDescription'),
      },
    },
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
      // Current impact per component, derived from the updates (kept in sync by `buildTimeline`).
      // Static components (#106) take their status from it.
      name: 'affectedComponents',
      type: 'array',
      admin: { description: adminT('marmot:incidents:affectedComponentsDescription') },
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
