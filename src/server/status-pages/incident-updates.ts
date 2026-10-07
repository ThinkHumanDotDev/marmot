/**
 * Builder-side operations on an incident's update timeline, shared by the route handlers under
 * `/api/orgs/:orgId/status-pages/:id/incidents/**`. Every write goes through the Local API with the
 * request user (`overrideAccess: false`), so the `incidents` collection's access rules and hooks
 * (`src/collections/Incidents.ts`) validate and derive everything.
 */
import {
  isComponentImpact,
  isIncidentStatus,
  type ComponentImpact,
  type IncidentStatus,
} from '@/lib/incident-timeline'
import type { Incident } from '@/payload-types'
import type { ErrorKey } from '@/server/errors'

import { coerceId, loadOrgStatusPage, type Authenticated } from './http'

type UpdateRow = NonNullable<Incident['updates']>[number]

export interface IncidentUpdateInput {
  status: IncidentStatus
  message: string
  /** Component ids (group row ids of the page) and their impact. */
  components: { component: string; impact: ComponentImpact }[]
  postedAt?: string
  /** Incident-level impact for incidents that affect no component. */
  impact?: ComponentImpact
}

/** Validates the JSON body of "post an update" (and the first update of a new incident). */
export function parseUpdateInput(
  body: Record<string, unknown>,
  defaults: { status?: IncidentStatus } = {},
): { ok: true; input: IncidentUpdateInput } | { ok: false; error: ErrorKey } {
  const status = body.status ?? defaults.status
  if (!isIncidentStatus(status)) {
    return { ok: false, error: 'incidentUpdateStatusInvalid' }
  }
  if (body.message !== undefined && body.message !== null && typeof body.message !== 'string') {
    return { ok: false, error: 'incidentMessageInvalid' }
  }
  if (body.components !== undefined && !Array.isArray(body.components)) {
    return { ok: false, error: 'incidentComponentsShape' }
  }
  const components: IncidentUpdateInput['components'] = []
  for (const entry of (body.components as unknown[] | undefined) ?? []) {
    const row = entry as { component?: unknown; impact?: unknown } | null
    const component = row?.component
    if (typeof component !== 'string' || !component || !isComponentImpact(row?.impact)) {
      return { ok: false, error: 'incidentComponentsShape' }
    }
    components.push({ component, impact: row.impact })
  }
  if (body.postedAt !== undefined && typeof body.postedAt !== 'string') {
    return { ok: false, error: 'incidentPostedAtInvalid' }
  }
  if (body.impact !== undefined && !isComponentImpact(body.impact)) {
    return { ok: false, error: 'incidentImpactInvalid' }
  }
  return {
    ok: true,
    input: {
      status,
      message: typeof body.message === 'string' ? body.message : '',
      components,
      ...(typeof body.postedAt === 'string' ? { postedAt: body.postedAt } : {}),
      ...(isComponentImpact(body.impact) ? { impact: body.impact } : {}),
    },
  }
}

/** The update row a client sends for a new timeline entry (the hook assigns id and defaults). */
export const toUpdateRow = (input: IncidentUpdateInput): UpdateRow =>
  ({
    status: input.status,
    message: input.message,
    components: input.components,
    ...(input.postedAt ? { postedAt: input.postedAt } : {}),
  }) as UpdateRow

/** Loads an incident of a page of `orgId` with the user's access. */
export async function loadOrgIncident(
  ctx: Authenticated,
  orgId: string,
  pageId: string,
  incidentId: string,
): Promise<Incident | null> {
  const page = await loadOrgStatusPage(ctx, orgId, pageId, 0)
  if (!page) return null
  const { docs } = await ctx.payload.find({
    collection: 'incidents',
    where: {
      and: [
        { id: { equals: coerceId(ctx.payload, incidentId) } },
        { statusPage: { equals: page.id } },
      ],
    },
    limit: 1,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs[0] ?? null
}

/** Existing rows as the hook expects them back (ids kept). */
const keepRows = (incident: Incident): UpdateRow[] => [...(incident.updates ?? [])]

/** Appends an update to the timeline. Returns the saved incident and the new update. */
export async function postIncidentUpdate(
  ctx: Authenticated,
  incident: Incident,
  input: IncidentUpdateInput,
): Promise<{ doc: Incident; update: UpdateRow }> {
  const before = new Set((incident.updates ?? []).map((row) => String(row.id)))
  const doc = await ctx.payload.update({
    collection: 'incidents',
    id: incident.id,
    data: {
      updates: [...keepRows(incident), toUpdateRow(input)],
      ...(input.impact ? { impact: input.impact } : {}),
    },
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  // A legacy incident also gains its migrated update; the posted one is the newest new row.
  const added = (doc.updates ?? []).filter((row) => !before.has(String(row.id)))
  return { doc, update: added.at(-1) as UpdateRow }
}

/**
 * Replaces the text of a posted update (`editedAt` is stamped by the collection). `legacy` addresses
 * the single update of an incident written before the timeline existed.
 */
export async function editIncidentUpdate(
  ctx: Authenticated,
  incident: Incident,
  updateId: string,
  message: string,
): Promise<{ doc: Incident; update: UpdateRow } | null> {
  let current = incident
  if ((current.updates ?? []).length === 0) {
    if (updateId !== 'legacy') return null
    // Materialise the legacy update first (any write does).
    current = await ctx.payload.update({
      collection: 'incidents',
      id: incident.id,
      data: {},
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    updateId = String(current.updates?.[0]?.id)
  }
  if (!(current.updates ?? []).some((row) => String(row.id) === updateId)) return null

  const doc = await ctx.payload.update({
    collection: 'incidents',
    id: current.id,
    data: {
      updates: keepRows(current).map((row) =>
        String(row.id) === updateId ? { ...row, message } : row,
      ),
    },
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  const update = (doc.updates ?? []).find((row) => String(row.id) === updateId) as UpdateRow
  return { doc, update }
}
