import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import nodemailer from 'nodemailer'

import { env } from '@/env'

/**
 * Generic SMTP email adapter. Any provider that speaks SMTP works (Cloudflare Email Routing,
 * Resend, Postmark, Mailgun, a self-hosted relay...). Without SMTP_HOST Payload falls back
 * to logging messages to the console, which is what you want in development and tests.
 */
export function getEmailAdapter() {
  if (!env.SMTP_HOST) {
    return undefined
  }

  const [defaultFromName, defaultFromAddress] = parseFrom(env.EMAIL_FROM)

  return nodemailerAdapter({
    defaultFromAddress,
    defaultFromName,
    // Build the transport ourselves: since nodemailer 10 the adapter's `transportOptions` type
    // (SMTPConnection.Options) no longer declares `auth`, though createTransport accepts it.
    transport: nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    }),
  })
}

export function parseFrom(from: string): [name: string, address: string] {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (match) return [match[1] || 'Marmot', match[2]]
  return ['Marmot', from.trim()]
}
