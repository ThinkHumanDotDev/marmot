import { ValidationError, type CollectionBeforeChangeHook } from 'payload'

import {
  isValidEmbedOrigin,
  normalizeEmbedOrigin,
  STATUS_PAGE_MAX_EMBED_ORIGINS,
} from '@/lib/status-page-embed'
import type { ErrorKey, ErrorValues } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'

import type { StatusPage } from '@/payload-types'

type OriginRow = NonNullable<StatusPage['embedOrigins']>[number]
type Req = { user?: unknown } | null | undefined

const invalid = (req: Req, key: ErrorKey, values?: ErrorValues): never => {
  throw new ValidationError({
    collection: 'status-pages',
    errors: [{ message: userErrorText(req, key, values), path: 'embedOrigins' }],
  })
}

/** Normalized, de-duplicated origins; throws on the first entry that is not an origin. */
export function normalizeOriginRows(rows: readonly OriginRow[], req?: Req): OriginRow[] {
  const seen = new Set<string>()
  const out: OriginRow[] = []
  for (const row of rows) {
    const origin = normalizeEmbedOrigin(String(row?.origin ?? ''))
    if (!origin) continue
    if (!isValidEmbedOrigin(origin)) invalid(req, 'statusPageEmbedOriginInvalid', { origin })
    if (seen.has(origin)) continue
    seen.add(origin)
    out.push({ ...row, origin })
  }
  return out
}

/**
 * `beforeChange` of `status-pages` (#109): normalizes the origins allowed to frame the page and
 * refuses `allowEmbedding: origins` with an empty list. The list is kept when embedding is switched
 * to another mode, so switching back restores it.
 */
export const applyEmbedSettings: CollectionBeforeChangeHook<StatusPage> = ({
  data,
  originalDoc,
  req,
}) => {
  if (Array.isArray(data.embedOrigins)) {
    data.embedOrigins = normalizeOriginRows(data.embedOrigins, req)
    if (data.embedOrigins.length > STATUS_PAGE_MAX_EMBED_ORIGINS) {
      invalid(req, 'statusPageEmbedOriginsTooMany', { max: STATUS_PAGE_MAX_EMBED_ORIGINS })
    }
  }
  const mode = data.allowEmbedding ?? originalDoc?.allowEmbedding ?? 'off'
  if (mode === 'origins') {
    const origins = data.embedOrigins ?? originalDoc?.embedOrigins ?? []
    if (origins.length === 0) invalid(req, 'statusPageEmbedOriginsRequired')
  }
  return data
}
