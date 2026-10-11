import { getPayload } from 'payload'

import config from '@payload-config'
import { handleInboundEmailWebhook } from '@/server/push/inbound-webhook'

export const dynamic = 'force-dynamic'

/**
 * `POST /api/inbound-email` — inbound-parse webhook for ping-by-email (#135): Postmark JSON,
 * Mailgun / SendGrid form posts or a raw message, authenticated by `INBOUND_EMAIL_WEBHOOK_SECRET`.
 * See `src/server/push/inbound-webhook.ts` and docs/Monitors.md#ping-by-email.
 */
export async function POST(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  return handleInboundEmailWebhook(payload, request)
}
