/**
 * Phone-call provider (#146): Twilio calls the number and reads the alert out; pressing 1
 * acknowledges the monitor incident (stopping its escalation), 2 repeats the message. Unanswered
 * calls and voicemail are called again up to `retries` times while the incident stays open. The
 * call flow and its webhooks live in `src/server/voice-calls`.
 */
import { z } from 'zod'

import { normalizePhoneNumber, startVoiceCall } from '@/server/voice-calls/calls'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

/** E.164: `+`, country code, up to 15 digits in total. */
const E164 = /^\+[1-9]\d{6,14}$/
const E164_MESSAGE = 'Use E.164 format, e.g. +14155550123'

const phoneNumber = z
  .string()
  .refine((value) => E164.test(normalizePhoneNumber(value)), E164_MESSAGE)

export const voiceCallConfigSchema = z.object({
  accountSid: z.string().min(1),
  authToken: z.string().min(1),
  fromNumber: phoneNumber,
  toNumber: phoneNumber,
  voice: z.string().max(100).optional(),
  language: z
    .string()
    .regex(/^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*)?$/, 'Use a language tag such as en-US')
    .optional(),
  retries: z.number().int().min(0).max(5).default(2),
  retryDelaySeconds: z.number().int().min(15).max(3600).default(60),
})

export type VoiceCallProviderConfig = z.infer<typeof voiceCallConfigSchema>

export const voiceCallFieldMeta: Record<keyof VoiceCallProviderConfig, NotificationFieldMeta> = {
  accountSid: { label: 'Twilio account SID', placeholder: 'AC…' },
  authToken: {
    label: 'Twilio auth token',
    secret: true,
    description:
      'The account’s auth token. It also verifies that keypresses really come from Twilio.',
  },
  fromNumber: {
    label: 'From number',
    placeholder: '+15005550006',
    description: 'A voice-capable Twilio number, in E.164 format.',
  },
  toNumber: {
    label: 'Number to call',
    placeholder: '+14155550123',
    description: 'International E.164 format, starting with + and the country code.',
  },
  voice: {
    label: 'Voice',
    placeholder: 'Polly.Joanna',
    description: 'A Twilio text-to-speech voice. Leave empty for Twilio’s default voice.',
  },
  language: {
    label: 'Language',
    placeholder: 'en-US',
    description: 'Language of the speech. Leave empty to follow the organization’s language.',
  },
  retries: {
    label: 'Retries',
    description:
      'How many times to call again when nobody answers or voicemail picks up, while the incident is open.',
  },
  retryDelaySeconds: {
    label: 'Delay between calls (seconds)',
  },
}

registerNotificationProvider({
  name: 'voice-call',
  label: 'Phone call (Twilio)',
  group: 'generic',
  docsUrl: 'https://www.twilio.com/docs/voice/api/call-resource',
  configSchema: voiceCallConfigSchema,
  fieldMeta: voiceCallFieldMeta,
  testOnce: true,
  async send(ctx) {
    const config = voiceCallConfigSchema.parse(ctx.config)
    return startVoiceCall(config, ctx)
  },
})
