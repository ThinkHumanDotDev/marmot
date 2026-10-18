/**
 * Shared plumbing of `/api/orgs/:orgId/declared-incidents/**`: request bodies become collection
 * data; authentication and authorisation come from `src/server/monitors/http.ts`.
 */
import type { Payload } from 'payload'

import type {
  DeclareIncidentInput,
  UpdateDeclaredIncidentInput,
} from '@/lib/validation/declared-incident'
import { parseId } from '@/server/monitors/http'

import type { Id } from './ids'

/** JSON ids: numbers pass, strings become the database's id type. */
const toId = (payload: Payload, value: string | number | null | undefined): Id | null =>
  value === null || value === undefined
    ? null
    : typeof value === 'number'
      ? value
      : parseId(payload, value)

export function declareData(payload: Payload, orgId: Id, input: DeclareIncidentInput) {
  return {
    organization: orgId,
    title: input.title,
    severity: input.severity,
    summary: input.summary || null,
    commander: toId(payload, input.commander),
    startedAt: input.startedAt ? new Date(input.startedAt).toISOString() : undefined,
    monitorIncident: toId(payload, input.monitorIncident),
    statusPageIncident: toId(payload, input.statusPageIncident),
  }
}

export function updateData(payload: Payload, input: UpdateDeclaredIncidentInput) {
  const data: Record<string, unknown> = {}
  if (input.title !== undefined) data.title = input.title
  if (input.severity !== undefined) data.severity = input.severity
  if (input.summary !== undefined) data.summary = input.summary || null
  if (input.commander !== undefined) data.commander = toId(payload, input.commander)
  if (input.status !== undefined) data.status = input.status
  if (input.startedAt !== undefined) data.startedAt = new Date(input.startedAt).toISOString()
  if (input.statusPageIncident !== undefined) {
    data.statusPageIncident = toId(payload, input.statusPageIncident)
  }
  const postmortem: Record<string, unknown> = {}
  if (input.postmortem !== undefined) postmortem.content = input.postmortem
  if (input.actionItems !== undefined) {
    postmortem.actionItems = input.actionItems.map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      title: item.title,
      owner: toId(payload, item.owner),
      dueDate: item.dueDate ?? null,
      done: item.done === true,
      ticketUrl: item.ticketUrl ?? null,
    }))
  }
  if (input.approvePostmortem) postmortem.status = 'approved'
  if (Object.keys(postmortem).length > 0) data.postmortem = postmortem
  if (input.skipPostmortem) data.postmortemSkipped = true
  return data
}
