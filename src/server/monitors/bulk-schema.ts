/**
 * Body of `POST /api/orgs/:orgId/monitors/bulk` (#124), shared by the route handler and the
 * OpenAPI document. Kept apart from `bulk.ts` so the document does not load the engine.
 */
import { z } from 'zod'

import { MAX_BULK_MONITORS, MONITOR_BULK_ACTIONS } from '@/lib/monitor-bulk'

const id = z.union([z.string().min(1).max(64), z.number().int()])

/** Most tags or channels one request may add or remove. */
export const MAX_BULK_REFERENCES = 50

const tagRow = z.object({
  tag: id,
  /** Value of the tag row (`env: prod`); ignored by `removeTags`. */
  value: z.string().trim().max(200).nullable().optional(),
})

/** Body of `POST /api/orgs/:orgId/monitors/bulk` (shared with the OpenAPI document). */
export const monitorBulkBody = z
  .object({
    ids: z.array(id).min(1).max(MAX_BULK_MONITORS),
    action: z.enum(MONITOR_BULK_ACTIONS),
    payload: z
      .object({
        tags: z.array(tagRow).min(1).max(MAX_BULK_REFERENCES).optional(),
        notifications: z.array(id).min(1).max(MAX_BULK_REFERENCES).optional(),
        /** Maintenance window of `addToMaintenance`. */
        maintenance: id.optional(),
        /** Status page of `addToStatusPageGroup`. */
        statusPage: id.optional(),
        /** Id of the group (row of the page's `groups`) of `addToStatusPageGroup`. */
        group: z.string().min(1).max(64).optional(),
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    const needs: (keyof NonNullable<typeof body.payload>)[] =
      body.action === 'addTags' || body.action === 'removeTags'
        ? ['tags']
        : body.action === 'addNotifications' || body.action === 'removeNotifications'
          ? ['notifications']
          : body.action === 'addToMaintenance'
            ? ['maintenance']
            : body.action === 'addToStatusPageGroup'
              ? ['statusPage', 'group']
              : []
    for (const field of needs) {
      if (body.payload?.[field] === undefined) {
        ctx.addIssue({ code: 'custom', path: ['payload', field], message: `${field} is required` })
      }
    }
  })

export type MonitorBulkBody = z.infer<typeof monitorBulkBody>
