/**
 * Request bodies of the API key routes (`/api/orgs/:orgId/api-keys/**`), shared with the OpenAPI
 * document (`src/server/api/openapi.ts`).
 */
import { z } from 'zod'

import { API_KEY_SCOPES } from '@/lib/api-key-scopes'

const MAX_EXPIRY_DAYS = 3650

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  /** `read` (default): GET only, as a viewer. `write`: also mutations, as a member. Immutable. */
  scope: z.enum(API_KEY_SCOPES).default('read'),
  /** ISO date, or `null`/omitted for a key that never expires. */
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Convenience for the UI: expire this many days from now. */
  expiresInDays: z.number().int().positive().max(MAX_EXPIRY_DAYS).nullable().optional(),
})

export const apiKeyPatchSchema = z.object({ active: z.boolean() })
