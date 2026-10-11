/**
 * Whether ping-by-email (#135) is on, and the inbound domain: `INBOUND_EMAIL_DOMAIN` plus at least
 * one transport (`INBOUND_SMTP_PORT` for the worker's listener, `INBOUND_EMAIL_WEBHOOK_SECRET` for
 * `/api/inbound-email`). Kept free of the mail parser so pages can import it cheaply.
 */
import { env } from '@/env'
import { pushEmailAddress } from '@/lib/push-email'
import type { Monitor } from '@/payload-types'

/** The inbound domain while ping-by-email is on, else `null`. */
export function inboundEmailDomain(): string | null {
  const domain = env.INBOUND_EMAIL_DOMAIN
  if (!domain) return null
  return env.INBOUND_SMTP_PORT > 0 || env.INBOUND_EMAIL_WEBHOOK_SECRET ? domain : null
}

export const isPushEmailEnabled = (): boolean => inboundEmailDomain() !== null

/** The address a push monitor receives mail at, or `null` when the feature is off. */
export function monitorPushEmailAddress(
  monitor: Pick<Monitor, 'type' | 'pushToken'>,
): string | null {
  if (monitor.type !== 'push') return null
  return pushEmailAddress(monitor.pushToken, inboundEmailDomain())
}
