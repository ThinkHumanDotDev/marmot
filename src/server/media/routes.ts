/**
 * Upload routes for the organization logo (`/api/orgs/:orgId/logo`) and the account avatar
 * (`/api/account/avatar`). See `./store.ts` for why media writes are server-only.
 */
import type { Payload } from 'payload'

import { canInOrg } from '@/access/overrides'
import { isApiKeyPrincipal } from '@/access/permissions'
import type { Media } from '@/payload-types'
import { apiError } from '@/server/errors'
import {
  forbidden,
  getRequestContext,
  jsonError,
  localizedError,
  parseId,
  requestLocale,
  unauthorized,
  withErrors,
} from '@/server/http'
import { prepareAsset, type ImageAssetKind, type PreparedAsset } from '@/server/status-pages/assets'

import { discardMedia, storeMedia } from './store'

/** Reads the multipart `file` field and validates it for `kind`, or returns an error response. */
export async function readImageUpload(
  request: Request,
  kind: ImageAssetKind,
): Promise<{ ok: true; asset: PreparedAsset } | { ok: false; response: Response }> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return { ok: false, response: localizedError(request, 'logoFileRequired', 400) }
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return { ok: false, response: localizedError(request, 'logoFileRequired', 400) }
  }
  const prepared = await prepareAsset(kind, file, requestLocale(request))
  if (!prepared.ok) return { ok: false, response: jsonError(prepared.error, 400) }
  return prepared
}

/** Stores `asset`, then runs `attach`; the upload is discarded when attaching fails. */
async function storeAndAttach<T>(
  payload: Payload,
  asset: PreparedAsset,
  alt: string,
  attach: (media: Media) => Promise<T>,
): Promise<T> {
  const media = await storeMedia(payload, asset, alt)
  try {
    return await attach(media)
  } catch (error) {
    await discardMedia(payload, media.id)
    throw error
  }
}

const mediaSummary = (media: Media | null) =>
  media ? { id: media.id, url: media.url ?? null } : null

type OrgRouteContext = { params: Promise<{ orgId: string }> }

async function orgLogoContext(request: Request, params: OrgRouteContext['params']) {
  const { payload, user, response } = await getRequestContext(request)
  if (response) return { response }
  if (!user) return { response: unauthorized(request) }
  const orgId = parseId(payload, (await params).orgId)
  const org = await payload.findByID({
    collection: 'organizations',
    id: orgId,
    depth: 0,
    user,
    overrideAccess: false,
    disableErrors: true,
  })
  if (!org) throw apiError('organizationNotFound', 404)
  if (!(await canInOrg(payload, user, org.id, 'organization:update'))) {
    return { response: forbidden(request) }
  }
  return { payload, user, org }
}

/** POST /api/orgs/:orgId/logo (multipart `file`) — needs `organization:update`. */
export const uploadOrgLogo = withErrors(async (request: Request, { params }: OrgRouteContext) => {
  const ctx = await orgLogoContext(request, params)
  if (ctx.response) return ctx.response
  const { payload, user, org } = ctx
  const upload = await readImageUpload(request, 'orgLogo')
  if (!upload.ok) return upload.response

  const media = await storeAndAttach(payload, upload.asset, `${org.name} logo`, async (media) => {
    await payload.update({
      collection: 'organizations',
      id: org.id,
      data: { logo: media.id },
      depth: 0,
      user,
      overrideAccess: false,
    })
    return media
  })
  return Response.json({ logo: mediaSummary(media) })
})

/** DELETE /api/orgs/:orgId/logo — clears the logo (the media row is kept). */
export const removeOrgLogo = withErrors(async (request: Request, { params }: OrgRouteContext) => {
  const ctx = await orgLogoContext(request, params)
  if (ctx.response) return ctx.response
  const { payload, user, org } = ctx
  await payload.update({
    collection: 'organizations',
    id: org.id,
    data: { logo: null },
    depth: 0,
    user,
    overrideAccess: false,
  })
  return Response.json({ logo: null })
})

async function accountContext(request: Request) {
  const { payload, user, response } = await getRequestContext(request)
  if (response) return { response }
  if (!user || isApiKeyPrincipal(user)) return { response: unauthorized(request) }
  return { payload, user }
}

/** POST /api/account/avatar (multipart `file`) — the signed-in user's own avatar. */
export const uploadAvatar = withErrors(async (request: Request) => {
  const ctx = await accountContext(request)
  if (ctx.response) return ctx.response
  const { payload, user } = ctx
  const upload = await readImageUpload(request, 'avatar')
  if (!upload.ok) return upload.response

  const media = await storeAndAttach(
    payload,
    upload.asset,
    `${user.name || user.email} avatar`,
    async (media) => {
      await payload.update({
        collection: 'users',
        id: user.id,
        data: { avatar: media.id },
        depth: 0,
        user,
        overrideAccess: false,
      })
      return media
    },
  )
  return Response.json({ avatar: mediaSummary(media) })
})

/** DELETE /api/account/avatar — clears the avatar (the media row is kept). */
export const removeAvatar = withErrors(async (request: Request) => {
  const ctx = await accountContext(request)
  if (ctx.response) return ctx.response
  const { payload, user } = ctx
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { avatar: null },
    depth: 0,
    user,
    overrideAccess: false,
  })
  return Response.json({ avatar: null })
})
