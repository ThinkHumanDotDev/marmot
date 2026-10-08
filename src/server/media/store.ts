/**
 * Writes to the `media` collection.
 *
 * `media.access` refuses create/update/delete to everyone except superadmins (the Payload admin
 * panel), because media rows carry no organization: Payload's default access would let any
 * signed-in user overwrite or delete any organization's logo through `/api/media`. Every upload in
 * the app therefore goes through a route handler that
 *
 * 1. checks the caller may change the document the image belongs to (status page, organization,
 *    own account),
 * 2. validates the bytes and sanitises SVGs (`prepareAsset` in `src/server/status-pages/assets.ts`),
 *    and only then
 * 3. stores the file with `storeMedia` (`overrideAccess: true`) and attaches it with the caller's
 *    access, discarding the upload when that fails.
 *
 * Handlers: status page images in `src/server/status-pages/assets.ts`, the organization logo and the
 * account avatar in `./routes.ts`.
 */
import type { Payload } from 'payload'

import type { Media } from '@/payload-types'
import type { PreparedAsset } from '@/server/status-pages/assets'

/** Stores a validated upload. Callers must have checked the user's permission first. */
export async function storeMedia(
  payload: Payload,
  asset: PreparedAsset,
  alt: string,
): Promise<Media> {
  return payload.create({
    collection: 'media',
    data: { alt },
    file: asset,
    overrideAccess: true,
  })
}

/** Removes an upload that could not be attached, so no orphan is left behind. */
export async function discardMedia(payload: Payload, id: string | number): Promise<void> {
  await payload.delete({ collection: 'media', id, overrideAccess: true }).catch(() => undefined)
}
