/**
 * WhatsApp provider (#128): Meta's WhatsApp Business Cloud API or Twilio's WhatsApp sender.
 *
 * Business-initiated WhatsApp messages must use a pre-approved template, so the Cloud API backend
 * always sends a template message whose body variables come from `templateVariables` (one Liquid
 * template per line → `{{1}}`, `{{2}}`, …). Twilio sends a Content template (`contentSid`) with the
 * same variables, or a free-form body inside the 24-hour customer service window.
 */
import { z } from 'zod'

import { renderMessageTemplate } from '@/server/notifications/message'
import { httpRequest, OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta, NotificationSendContext } from './types'

/** Graph API version used for the Cloud API. */
export const WHATSAPP_GRAPH_VERSION = 'v21.0'

/** E.164: `+`, country code, up to 15 digits in total. */
const E164 = /^\+[1-9]\d{6,14}$/

/** `+14155550123` from `+14155550123`, `whatsapp:+14155550123` or `+1 415 555 0123`. */
export function normalizeWhatsappNumber(value: string): string {
  return value
    .trim()
    .replace(/^whatsapp:/i, '')
    .replace(/[\s().-]/g, '')
}

export const isE164 = (value: string) => E164.test(normalizeWhatsappNumber(value))

const E164_MESSAGE = 'Use E.164 format, e.g. +14155550123'

export const DEFAULT_TEMPLATE_VARIABLES = '{{ name }}\n{{ status }}\n{{ msg }}'

export const whatsappConfigSchema = z
  .object({
    backend: z.enum(['cloud', 'twilio']).default('cloud'),
    recipient: z.string().refine(isE164, E164_MESSAGE),
    // Meta WhatsApp Business Cloud API
    accessToken: z.string().optional(),
    phoneNumberId: z.string().optional(),
    templateName: z.string().optional(),
    templateLanguage: z.string().default('en_US'),
    // Twilio
    accountSid: z.string().optional(),
    apiKey: z.string().optional(),
    authToken: z.string().optional(),
    fromNumber: z.string().optional(),
    contentSid: z.string().optional(),
    // Both
    templateVariables: z.string().default(DEFAULT_TEMPLATE_VARIABLES),
  })
  .superRefine((config, ctx) => {
    const required = (keys: (keyof typeof config)[]) => {
      for (const key of keys) {
        const value = config[key]
        if (typeof value !== 'string' || !value.trim()) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'Required' })
        }
      }
    }
    if (config.backend === 'cloud') {
      required(['accessToken', 'phoneNumberId', 'templateName', 'templateLanguage'])
    } else {
      required(['accountSid', 'authToken', 'fromNumber'])
      if (config.fromNumber?.trim() && !isE164(config.fromNumber)) {
        ctx.addIssue({ code: 'custom', path: ['fromNumber'], message: E164_MESSAGE })
      }
    }
  })

export type WhatsappConfig = z.infer<typeof whatsappConfigSchema>

export const whatsappFieldMeta: Record<keyof WhatsappConfig, NotificationFieldMeta> = {
  backend: {
    label: 'Backend',
    options: { cloud: 'WhatsApp Business Cloud API (Meta)', twilio: 'Twilio WhatsApp' },
  },
  recipient: {
    label: 'Recipient number',
    placeholder: '+14155550123',
    description: 'International E.164 format, starting with + and the country code.',
  },
  accessToken: {
    label: 'Access token',
    secret: true,
    description: 'Cloud API only: a permanent system-user token with whatsapp_business_messaging.',
  },
  phoneNumberId: {
    label: 'Phone number ID',
    placeholder: '106540352242922',
    description: 'Cloud API only: the sender’s phone number ID (not the phone number itself).',
  },
  templateName: {
    label: 'Template name',
    placeholder: 'marmot_alert',
    description: 'Cloud API only: an approved message template.',
  },
  templateLanguage: { label: 'Template language', placeholder: 'en_US' },
  accountSid: { label: 'Twilio account SID', placeholder: 'AC…' },
  apiKey: {
    label: 'Twilio API key SID',
    description: 'Optional: authenticate with an API key instead of the account SID.',
  },
  authToken: { label: 'Twilio auth token (or API key secret)', secret: true },
  fromNumber: {
    label: 'Twilio WhatsApp sender',
    placeholder: '+14155238886',
    description: 'Twilio only: your WhatsApp-enabled Twilio number.',
  },
  contentSid: {
    label: 'Twilio content template SID',
    placeholder: 'HX…',
    description:
      'Twilio only: an approved content template. Without it the plain message is sent, which WhatsApp only delivers within 24 hours of the recipient’s last message.',
  },
  templateVariables: {
    label: 'Template variables',
    template: 'text',
    multiline: true,
    description:
      'One Liquid template per line, filling the template’s numbered variables in order. Leave empty for a template without variables.',
  },
}

/**
 * Render each non-empty line of `templateVariables`. WhatsApp rejects parameters that are empty or
 * contain newlines, tabs or long runs of spaces, so whitespace is collapsed and empty values become `-`.
 */
export function renderWhatsappVariables(
  config: Pick<WhatsappConfig, 'templateVariables'>,
  ctx: NotificationSendContext,
): string[] {
  return (config.templateVariables ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const value = renderMessageTemplate(
        line,
        ctx.message,
        ctx.monitor,
        ctx.heartbeat,
        ctx.locale,
        ctx,
      )
      return value.replace(/\s+/g, ' ').trim() || '-'
    })
}

/** Turn an HTTP failure into `WhatsApp Cloud API (HTTP 400 Bad Request): <vendor message>`. */
function vendorError(error: unknown, vendor: string): Error {
  const text = error instanceof Error ? error.message : String(error)
  const status = /\(HTTP \d+[^)]*\)/.exec(text)?.[0]
  const raw = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]
  if (!status || raw === undefined) return error instanceof Error ? error : new Error(text)
  let detail = raw
  try {
    detail = JSON.parse(`"${raw}"`) as string
  } catch {
    // keep the escaped text
  }
  return new Error(`${vendor} ${status}: ${detail}`)
}

async function sendCloud(config: WhatsappConfig, variables: string[]): Promise<void> {
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(
    config.phoneNumberId!.trim(),
  )}/messages`
  const template: Record<string, unknown> = {
    name: config.templateName!.trim(),
    language: { code: config.templateLanguage.trim() },
  }
  if (variables.length) {
    template.components = [
      { type: 'body', parameters: variables.map((text) => ({ type: 'text', text })) },
    ]
  }
  try {
    await httpRequest(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken!.trim()}` },
      json: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizeWhatsappNumber(config.recipient).slice(1),
        type: 'template',
        template,
      },
    })
  } catch (error) {
    throw vendorError(error, 'WhatsApp Cloud API')
  }
}

async function sendTwilio(
  config: WhatsappConfig,
  variables: string[],
  message: string,
): Promise<void> {
  const accountSid = config.accountSid!.trim()
  const user = config.apiKey?.trim() || accountSid
  const body = new URLSearchParams()
  body.append('To', `whatsapp:${normalizeWhatsappNumber(config.recipient)}`)
  body.append('From', `whatsapp:${normalizeWhatsappNumber(config.fromNumber!)}`)
  if (config.contentSid?.trim()) {
    body.append('ContentSid', config.contentSid.trim())
    if (variables.length) {
      body.append(
        'ContentVariables',
        JSON.stringify(Object.fromEntries(variables.map((value, i) => [String(i + 1), value]))),
      )
    }
  } else {
    body.append('Body', message)
  }
  try {
    await httpRequest(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Authorization: `Basic ${Buffer.from(`${user}:${config.authToken!.trim()}`).toString('base64')}`,
        },
        rawBody: body.toString(),
      },
    )
  } catch (error) {
    throw vendorError(error, 'Twilio')
  }
}

registerNotificationProvider({
  name: 'whatsapp',
  label: 'WhatsApp',
  group: 'chat',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates',
  configSchema: whatsappConfigSchema,
  fieldMeta: whatsappFieldMeta,
  async send(ctx) {
    const config = whatsappConfigSchema.parse(ctx.config)
    const variables = renderWhatsappVariables(config, ctx)
    if (config.backend === 'twilio') await sendTwilio(config, variables, ctx.message)
    else await sendCloud(config, variables)
    return OK_MESSAGE
  },
})
