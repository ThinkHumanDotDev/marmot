import { getPayload } from 'payload'

import config from '@payload-config'
import { isApiKeyPrincipal } from '@/access/permissions'
import { authenticateRequest } from '@/server/auth/request-auth'
import type { RequestUser } from '@/server/monitors/http'
import { jsonError, readJson } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { isSlackAppEnabled, slackDisabledResponse } from '@/server/slack/config'
import { confirmLink } from '@/server/slack/manage'

export const dynamic = 'force-dynamic'

/**
 * POST /api/slack/link `{ token }` — links the Slack user of a `/marmot link` token to the signed-in
 * member (#129). The token is signed and expires after 15 minutes; the member must belong to the
 * organization that installed the app in that workspace. Answers `{ linked: true }`, 400 for an
 * invalid token, 403 for a non-member, 401 without a session.
 */
export async function POST(request: Request) {
  if (!isSlackAppEnabled()) return slackDisabledResponse()
  const payload = await getPayload({ config })
  const auth = await authenticateRequest(payload, request)
  if (auth.response) return auth.response
  const user = auth.user as RequestUser | null | undefined
  if (!user || isApiKeyPrincipal(user)) {
    return jsonError(401, errorText(request, 'unauthenticated'))
  }
  const body = await readJson<{ token?: unknown }>(request)
  const token = typeof body?.token === 'string' ? body.token : ''
  const result = await confirmLink(payload, token, user)
  if (!result.ok) {
    return result.error === 'not-member'
      ? jsonError(403, errorText(request, 'slackNotMember'))
      : jsonError(400, errorText(request, 'slackLinkInvalid'))
  }
  return Response.json({ linked: true })
}
