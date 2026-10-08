import { verifyEmailToken } from '@/server/auth/email-verification'
import { getRequestContext, localizedError, readJson, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/verify-email `{ token }` → `{ verified: true, email, alreadyVerified }`
 *
 * Redeems the link from the verification email (#177). Works signed out too: the token alone
 * identifies the account. 400 for unknown, expired, used or outdated links. The link opens a page
 * with a confirm button that posts here, so mail scanners that prefetch the URL cannot use it up.
 */
export const POST = withErrors(async (request: Request) => {
  const { payload } = await getRequestContext(request)
  const { token } = await readJson<{ token?: unknown }>(request)
  const result = await verifyEmailToken(payload, token, request)
  if (!result.ok) return localizedError(request, 'verificationLinkInvalid', 400)
  return Response.json(
    { verified: true, email: result.email, alreadyVerified: result.alreadyVerified },
    { headers: { 'Cache-Control': 'no-store' } },
  )
})
