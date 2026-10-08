/**
 * Request bodies of the location routes (`/api/orgs/:orgId/locations/**`), shared with the OpenAPI
 * document (`src/server/api/openapi.ts`).
 */
import { z } from 'zod'

import { LOCATION_SLUG_PATTERN, MAX_LOCATION_LABELS } from '@/lib/probe-locations'

const labels = z
  .array(
    z.object({
      key: z.string().trim().min(1).max(64),
      value: z.string().trim().max(200).nullish(),
    }),
  )
  .max(MAX_LOCATION_LABELS)

const slug = z.string().trim().toLowerCase().regex(LOCATION_SLUG_PATTERN)

export const locationCreateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(100),
  /** Derived from the name when omitted; unique per organization, `local` is reserved. */
  slug: slug.optional(),
  /** Up to 20 metadata labels (`region: eu-west`). */
  labels: labels.default([]),
})

export const locationPatchSchema = z
  .object({ name: z.string().trim().min(1).max(100), slug, labels })
  .partial()
