import { getPayload } from 'payload'

import config from '@payload-config'
import { isSmsStopKeyword } from '@/lib/status-page-subscribers'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { loadSmsChannel } from '@/server/status-pages/subscribers/deliver'
import { unsubscribePhoneFromPage } from '@/server/status-pages/subscribers/signup'
import { verifyTwilioSignature } from '@/server/status-pages/subscribers/twilio'
import { serverUrl } from '@/server/status-pages/urls'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

/**
 * POST /api/status-pages/:slug/sms-inbound — Twilio "A message comes in" webhook of the page's SMS
 * number. A `STOP` (or `UNSUBSCRIBE`, `CANCEL`, …) reply removes the sender's SMS subscription to
 * the page. Requests must carry a valid `X-Twilio-Signature` for the page's Twilio channel and the
 * URL as configured in Twilio (`NEXT_PUBLIC_SERVER_URL` + this path). Twilio itself also blocks
 * further messages to numbers that replied STOP; Marmot removes those subscribers on the next send.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  const channel = page ? await loadSmsChannel(payload, page) : null
  if (!page || !channel) return new Response(null, { status: 404 })

  const form = await request.formData().catch(() => null)
  const fields: Record<string, string> = {}
  for (const [key, value] of form?.entries() ?? []) {
    if (typeof value === 'string') fields[key] = value
  }
  const url = `${serverUrl()}${new URL(request.url).pathname}`
  const authToken = String((channel.config as Record<string, unknown>)?.authToken ?? '')
  if (!verifyTwilioSignature(authToken, url, fields, request.headers.get('x-twilio-signature'))) {
    return new Response(null, { status: 403 })
  }

  if (fields.From && isSmsStopKeyword(fields.Body ?? '')) {
    await unsubscribePhoneFromPage(payload, page.id, fields.From)
  }
  return new Response(EMPTY_TWIML, { headers: { 'Content-Type': 'text/xml' } })
}
