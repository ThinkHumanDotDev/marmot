/**
 * Request bodies of `/api/orgs/:orgId/declared-incidents/**` (#101), shared by the route handlers
 * and the dashboard forms. The collection hook (`src/server/declared-incidents/hooks.ts`) enforces
 * the workflow rules on every write; these schemas only shape the input.
 */
import { z } from 'zod'

import {
  DECLARED_INCIDENT_SEVERITIES,
  DECLARED_INCIDENT_STATUSES,
  MAX_ACTION_ITEMS,
} from '@/lib/declared-incidents'

/** A relationship id from JSON: Postgres ids arrive as numbers or numeric strings, Mongo as strings. */
const id = z.union([z.string().min(1).max(64), z.number().int().positive()])

export const POSTMORTEM_MAX_LENGTH = 100_000

export const declareIncidentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  severity: z.enum(DECLARED_INCIDENT_SEVERITIES).default('major'),
  summary: z.string().trim().max(5000).optional(),
  commander: id.nullish(),
  /** Backdated start; defaults to the monitor incident's start, else now. */
  startedAt: z.iso.datetime({ offset: true }).optional(),
  monitorIncident: id.nullish(),
  statusPageIncident: id.nullish(),
})
export type DeclareIncidentInput = z.infer<typeof declareIncidentSchema>

/** A calendar day, `YYYY-MM-DD`. */
const day = z.iso.date()

/** One postmortem action item; rows that keep their `id` stay the same item (and its ticket link). */
export const actionItemSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(500),
  owner: id.nullish(),
  dueDate: day.nullish(),
  done: z.boolean().optional(),
  ticketUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullish(),
})
export type ActionItemInput = z.infer<typeof actionItemSchema>

export const updateDeclaredIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    severity: z.enum(DECLARED_INCIDENT_SEVERITIES),
    summary: z.string().trim().max(5000).nullable(),
    commander: id.nullable(),
    status: z.enum(DECLARED_INCIDENT_STATUSES),
    startedAt: z.iso.datetime({ offset: true }),
    statusPageIncident: id.nullable(),
    /** Markdown body of the postmortem; saving it makes the postmortem a draft. */
    postmortem: z.string().max(POSTMORTEM_MAX_LENGTH),
    /** The postmortem's action items, replacing the stored list (rows keep their `id`). */
    actionItems: z.array(actionItemSchema).max(MAX_ACTION_ITEMS),
    /** `true` approves the current postmortem. */
    approvePostmortem: z.literal(true),
    /** With `status: 'closed'`: close without an approved postmortem (admins only). */
    skipPostmortem: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0)
export type UpdateDeclaredIncidentInput = z.infer<typeof updateDeclaredIncidentSchema>

export const declaredNoteSchema = z.object({ message: z.string().trim().min(1).max(5000) })
