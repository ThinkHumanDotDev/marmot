/**
 * WhatsApp provider (#128): exact request payloads for both backends with `fetch` mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Heartbeat, Monitor } from '@/payload-types'
import { validateNotificationConfig } from '@/server/notifications/send'
import { getNotificationProvider, OK_MESSAGE } from './index'
import { normalizeWhatsappNumber, whatsappConfigSchema } from './whatsapp'

const monitor = {
  id: 7,
  name: 'API',
  type: 'http',
  url: 'https://api.example.com/health',
} as unknown as Monitor

const downBeat = {
  id: 99,
  monitor: 7,
  status: 'down',
  msg: 'Request failed with status code 503',
  time: '2026-03-10T10:30:00.000Z',
} as unknown as Heartbeat

const downMessage = '[API] [🔴 Down] Request failed with status code 503'

type Call = { url: string; init: RequestInit; body: unknown }
let calls: Call[]

function mockFetch(status = 200, body = '{"messages":[{"id":"wamid.1"}]}') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      let parsed: unknown = init?.body
      if (typeof init?.body === 'string') {
        try {
          parsed = JSON.parse(init.body)
        } catch {
          parsed = init.body
        }
      }
      calls.push({ url, init: init ?? {}, body: parsed })
      return new Response(body, { status, headers: { 'content-type': 'application/json' } })
    }),
  )
}

const send = (
  config: Record<string, unknown>,
  ctx: { monitor?: Monitor | null; heartbeat?: Heartbeat | null; message?: string } = {},
) =>
  getNotificationProvider('whatsapp')!.send({
    config: whatsappConfigSchema.parse(config),
    message: ctx.message ?? downMessage,
    monitor: ctx.monitor === undefined ? monitor : ctx.monitor,
    heartbeat: ctx.heartbeat === undefined ? downBeat : ctx.heartbeat,
  })

const cloud = {
  backend: 'cloud',
  recipient: '+49 151 2345 6789',
  accessToken: 'EAAG-token',
  phoneNumberId: '106540352242922',
  templateName: 'marmot_alert',
  templateLanguage: 'de',
}

const twilio = {
  backend: 'twilio',
  recipient: 'whatsapp:+14155550123',
  accountSid: 'AC1',
  authToken: 'secret',
  fromNumber: '+14155238886',
}

beforeEach(() => {
  calls = []
  mockFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('whatsapp config', () => {
  it('validates E.164 numbers and the fields each backend needs', () => {
    expect(normalizeWhatsappNumber(' whatsapp:+1 (415) 555-0123 ')).toBe('+14155550123')
    expect(() => validateNotificationConfig('whatsapp', cloud)).not.toThrow()
    expect(() => validateNotificationConfig('whatsapp', twilio)).not.toThrow()

    expect(() =>
      validateNotificationConfig('whatsapp', { ...cloud, recipient: '0151234567' }),
    ).toThrow(/recipient: Use E\.164 format/)
    expect(() =>
      validateNotificationConfig('whatsapp', { ...cloud, recipient: '+0123456789' }),
    ).toThrow(/E\.164/)
    expect(() =>
      validateNotificationConfig('whatsapp', { ...twilio, fromNumber: '4155238886' }),
    ).toThrow(/fromNumber: Use E\.164 format/)
    expect(() =>
      validateNotificationConfig('whatsapp', { backend: 'cloud', recipient: '+14155550123' }),
    ).toThrow(/accessToken: Required; phoneNumberId: Required; templateName: Required/)
    expect(() =>
      validateNotificationConfig('whatsapp', { backend: 'twilio', recipient: '+14155550123' }),
    ).toThrow(/accountSid: Required; authToken: Required; fromNumber: Required/)
  })
})

describe('whatsapp via the Cloud API', () => {
  it('sends an approved template with name, status and msg as body parameters', async () => {
    expect(await send(cloud)).toBe(OK_MESSAGE)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/106540352242922/messages')
    expect(calls[0].init.method).toBe('POST')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('authorization')).toBe('Bearer EAAG-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(calls[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '4915123456789',
      type: 'template',
      template: {
        name: 'marmot_alert',
        language: { code: 'de' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'API' },
              { type: 'text', text: '🔴 Down' },
              { type: 'text', text: downMessage },
            ],
          },
        ],
      },
    })
  })

  it('renders custom variables, flattens whitespace and omits components without variables', async () => {
    await send(
      { ...cloud, templateVariables: '{{ heartbeat.msg | upcase }}\n\n{{ monitor.url }}\n' },
      { message: 'line one\n\tline two' },
    )
    expect((calls[0].body as { template: unknown }).template).toEqual({
      name: 'marmot_alert',
      language: { code: 'de' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'REQUEST FAILED WITH STATUS CODE 503' },
            { type: 'text', text: 'https://api.example.com/health' },
          ],
        },
      ],
    })

    // A test send has no monitor: empty values become "-" (WhatsApp rejects empty parameters),
    // and multi-line messages are flattened.
    await send(
      { ...cloud, templateVariables: '{{ monitor.url }}\n{{ msg }}' },
      { monitor: null, heartbeat: null, message: 'Testing\nfrom   Marmot' },
    )
    expect((calls[1].body as { template: { components: unknown } }).template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: '-' },
          { type: 'text', text: 'Testing from Marmot' },
        ],
      },
    ])

    await send({
      ...cloud,
      templateName: 'hello_world',
      templateLanguage: 'en_US',
      templateVariables: '',
    })
    expect((calls[2].body as { template: unknown }).template).toEqual({
      name: 'hello_world',
      language: { code: 'en_US' },
    })
  })

  it('surfaces the Graph API error message', async () => {
    mockFetch(
      400,
      JSON.stringify({
        error: {
          message: '(#132001) Template name does not exist in the translation',
          type: 'OAuthException',
          code: 132001,
          fbtrace_id: 'Aa1',
        },
      }),
    )
    await expect(send(cloud)).rejects.toThrow(
      'WhatsApp Cloud API (HTTP 400): (#132001) Template name does not exist in the translation',
    )

    mockFetch(502, 'upstream down')
    await expect(send(cloud)).rejects.toThrow('Request failed (HTTP 502) upstream down')
  })
})

describe('whatsapp via Twilio', () => {
  it('sends a content template with numbered variables from whatsapp: numbers', async () => {
    expect(await send({ ...twilio, apiKey: 'SK1', contentSid: 'HX123' })).toBe(OK_MESSAGE)
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json')
    expect(calls[0].init.method).toBe('POST')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('SK1:secret').toString('base64')}`,
    )
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(calls[0].body as string))).toEqual({
      To: 'whatsapp:+14155550123',
      From: 'whatsapp:+14155238886',
      ContentSid: 'HX123',
      ContentVariables: JSON.stringify({ '1': 'API', '2': '🔴 Down', '3': downMessage }),
    })
  })

  it('sends the plain message without a content template', async () => {
    await send(twilio)
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('AC1:secret').toString('base64')}`,
    )
    expect(Object.fromEntries(new URLSearchParams(calls[0].body as string))).toEqual({
      To: 'whatsapp:+14155550123',
      From: 'whatsapp:+14155238886',
      Body: downMessage,
    })
  })

  it('surfaces the Twilio error message', async () => {
    mockFetch(
      400,
      JSON.stringify({
        code: 63016,
        message: 'Failed to send freeform message because you are outside the allowed window.',
        status: 400,
      }),
    )
    await expect(send(twilio)).rejects.toThrow(
      'Twilio (HTTP 400): Failed to send freeform message because you are outside the allowed window.',
    )
  })
})
