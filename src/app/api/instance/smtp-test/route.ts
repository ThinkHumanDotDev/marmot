import { APIError } from 'payload'

import { isSuperadmin } from '@/access/permissions'
import { env } from '@/env'
import { getRequestContext, jsonError, readJson, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

/**
 * POST /api/instance/smtp-test `{ to? }` → `{ sent: true, to }`
 *
 * Sends a test message through the configured email adapter (superadmins only). 400 when SMTP is
 * not configured (`SMTP_HOST` unset: Payload would only log the mail to the console).
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  if (!isSuperadmin(user)) return jsonError('Forbidden', 403)
  if (!env.SMTP_HOST) {
    throw new APIError('SMTP is not configured. Set SMTP_HOST (and friends) and restart.', 400)
  }

  const body = await readJson<{ to?: unknown }>(request)
  const to = typeof body.to === 'string' && body.to.includes('@') ? body.to.trim() : user.email

  try {
    await payload.sendEmail({
      to,
      subject: 'Marmot test email',
      text: `This is a test message from Marmot (${env.NEXT_PUBLIC_SERVER_URL}). If you can read this, SMTP works.`,
    })
  } catch (error) {
    throw new APIError(
      `Sending failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    )
  }
  return Response.json({ sent: true, to })
})
