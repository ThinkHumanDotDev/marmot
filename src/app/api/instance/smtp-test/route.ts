import { isSuperadmin } from '@/access/permissions'
import { env } from '@/env'
import {
  forbidden,
  getRequestContext,
  readJson,
  requestLocale,
  unauthorized,
  withErrors,
} from '@/server/http'
import { serverTranslator } from '@/server/i18n'
import { apiError } from '@/server/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/instance/smtp-test `{ to? }` → `{ sent: true, to }`
 *
 * Sends a test message through the configured email adapter (superadmins only). 400 when SMTP is
 * not configured (`SMTP_HOST` unset: Payload would only log the mail to the console).
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized(request)
  if (!isSuperadmin(user)) return forbidden(request)
  if (!env.SMTP_HOST) {
    throw apiError('smtpNotConfigured', 400)
  }

  const body = await readJson<{ to?: unknown }>(request)
  const to = typeof body.to === 'string' && body.to.includes('@') ? body.to.trim() : user.email

  // Written in the requesting superadmin's language: they are the reader (by default, the recipient).
  const t = serverTranslator(requestLocale(request))
  try {
    await payload.sendEmail({
      to,
      subject: t('email.smtpTest.subject'),
      text: t('email.smtpTest.text', { url: env.NEXT_PUBLIC_SERVER_URL }),
    })
  } catch (error) {
    throw apiError('smtpSendFailed', 502, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return Response.json({ sent: true, to })
})
