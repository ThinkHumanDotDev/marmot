import { getPayload } from 'payload'

import config from '@payload-config'
import { handleVoiceWebhook, isVoiceWebhookKind } from '@/server/voice-calls/webhooks'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ callId: string; kind: string }> }

/**
 * `POST /api/notifications/voice/:callId/{twiml,gather,status}`: Twilio's webhooks of a phone-call
 * alert (#146). `twiml` answers the call, `gather` takes the keypress (1 acknowledges the incident,
 * 2 repeats the message) and `status` gets the final call status (unanswered calls are retried).
 * Each request is verified with Twilio's `X-Twilio-Signature` (403 otherwise); unknown or expired
 * calls are 404.
 */
export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const { callId, kind } = await params
  if (!isVoiceWebhookKind(kind)) return new Response(null, { status: 404 })
  return handleVoiceWebhook(request, callId, kind, () => getPayload({ config }))
}
