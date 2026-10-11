/**
 * The demo mode sink (#159): in demo mode every notification, email and webhook is handed here
 * instead of leaving the instance. It only logs (structured, `demoSink: <kind>`), so operators can
 * watch what the demo would have sent without anything reaching a third party.
 */
import type { EmailAdapter, SendEmailOptions } from 'payload'

import { childLogger } from '@/lib/logger'

const log = childLogger('demo:sink')

export type DemoSinkKind = 'notification' | 'email' | 'webhook' | 'subscriber-webhook'

/** Record a delivery the demo instance swallowed. Never throws. */
export function deliverToDemoSink(kind: DemoSinkKind, details: Record<string, unknown>): void {
  try {
    log.info({ demoSink: kind, ...details }, 'demo mode: delivery captured by the sink')
  } catch {
    // Logging must never fail a delivery path.
  }
}

const recipients = (to: SendEmailOptions['to']): string[] => {
  const list: unknown[] = Array.isArray(to) ? to.flat() : to ? [to] : []
  return list.map((entry) =>
    typeof entry === 'string' ? entry : String((entry as { address?: unknown })?.address ?? ''),
  )
}

/** Payload email adapter that sends nothing (used instead of SMTP in demo mode). */
export const demoSinkEmailAdapter =
  (defaultFromName: string, defaultFromAddress: string): EmailAdapter =>
  () => ({
    name: 'demo-sink',
    defaultFromName,
    defaultFromAddress,
    sendEmail: async (message) => {
      deliverToDemoSink('email', { to: recipients(message.to), subject: message.subject })
      return { accepted: recipients(message.to), demo: true }
    },
  })
