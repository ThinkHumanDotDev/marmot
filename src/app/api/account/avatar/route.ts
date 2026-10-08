import { removeAvatar, uploadAvatar } from '@/server/media/routes'

export const dynamic = 'force-dynamic'

/** POST /api/account/avatar (multipart `file`) — upload and set the signed-in user's avatar. */
export const POST = uploadAvatar

/** DELETE /api/account/avatar — clear the signed-in user's avatar. */
export const DELETE = removeAvatar
