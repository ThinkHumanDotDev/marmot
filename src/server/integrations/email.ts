/**
 * Email-to-incident (#152): mail to `<integration token>@INBOUND_EMAIL_DOMAIN` arrives through the
 * ping-by-email transports (#135: the worker's SMTP listener and `POST /api/inbound-email`) and is
 * applied as one alert (`parseInboundEmail`): the subject is the title, the integration's resolved
 * keyword in the subject marks the recovery, and rules match `subject`, `from` and `body`.
 */
import type { Payload } from 'payload'

import { parseInboundEmail } from '@/lib/inbound-alerts'
import { pushTokenFromAddress } from '@/lib/push-email'
import type { Integration } from '@/payload-types'
import { inboundEmailDomain } from '@/server/push/inbound-config'

import { findIntegrationByToken } from './http'
import { ingestAlerts, type AlertResult } from './ingest'

export interface IntegrationMail {
  subject?: string | null
  text?: string | null
  from?: string | null
}

/** The active integration an inbound address belongs to, or `null`. */
export async function findIntegrationByAddress(
  payload: Payload,
  address: string,
): Promise<Integration | null> {
  const domain = inboundEmailDomain()
  if (!domain) return null
  const token = pushTokenFromAddress(address, domain)
  return token ? findIntegrationByToken(payload, token.toLowerCase()) : null
}

export async function ingestIntegrationEmail(
  payload: Payload,
  integration: Integration,
  mail: IntegrationMail,
  options: { now?: Date } = {},
): Promise<AlertResult[]> {
  const alert = parseInboundEmail(mail, integration.emailResolvedKeyword)
  return ingestAlerts(
    payload,
    integration,
    { alerts: [alert], dropped: 0 },
    {
      source: 'email',
      raw: { from: mail.from ?? null, subject: mail.subject ?? null, text: alert.description },
      now: options.now,
    },
  )
}
