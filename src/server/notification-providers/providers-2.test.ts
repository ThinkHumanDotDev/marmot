/**
 * Payload assertions for the second wave of notification providers (mocked `fetch`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Heartbeat, Monitor } from '@/payload-types'
import { setAppriseRunner } from './apprise'
import { setGoogleChatRateLimitDelay } from './google-chat'
import {
  describeNotificationProviders,
  describeProvider,
  getNotificationProvider,
  listNotificationProviders,
  NOTIFICATION_PROVIDER_GROUPS,
  OK_MESSAGE,
} from './index'
import { signNextcloudTalk } from './nextcloud-talk'
import { onebotSendUrl } from './onebot'
import { serverchanUrl } from './serverchan'

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }))
vi.mock('web-push', () => ({ default: { sendNotification } }))

const monitor = {
  id: 7,
  name: 'API',
  type: 'http',
  url: 'https://api.example.com/health',
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
  updatedAt: '',
  createdAt: '',
} as unknown as Monitor

const downBeat = {
  id: 99,
  monitor: 7,
  status: 'down',
  msg: 'Request failed with status code 503',
  ping: null,
  duration: 60,
  important: true,
  time: '2026-03-10T10:30:00.000Z',
} as unknown as Heartbeat

const upBeat = {
  ...downBeat,
  id: 100,
  status: 'up',
  msg: '200 - OK',
  ping: 123,
} as unknown as Heartbeat

const downMessage = '[API] [🔴 Down] Request failed with status code 503'
const upMessage = '[API] [✅ Up] 200 - OK'
const TIME = '2026-03-10 10:30:00 (UTC)'

type Call = { url: string; init: RequestInit; body: unknown }

let calls: Call[]

function mockFetch(status = 200, body = '{"ok":true}') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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
  type: string,
  config: Record<string, unknown>,
  ctx: { monitor?: Monitor | null; heartbeat?: Heartbeat | null; message?: string } = {},
) => {
  const provider = getNotificationProvider(type)
  if (!provider) throw new Error(`provider ${type} missing`)
  const heartbeat = ctx.heartbeat === undefined ? downBeat : ctx.heartbeat
  return provider.send({
    config,
    message: ctx.message ?? (heartbeat?.status === 'up' ? upMessage : downMessage),
    monitor: ctx.monitor === undefined ? monitor : ctx.monitor,
    heartbeat,
  })
}

const headersOf = (call: Call) => new Headers(call.init.headers)
const test = { monitor: null, heartbeat: null, message: 'Testing' }

beforeEach(() => {
  calls = []
  mockFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('notification provider registry (wave 2)', () => {
  const WAVE_2 = [
    'alerta',
    'apprise',
    'bark',
    'bitrix24',
    'clicksend',
    'dingding',
    'feishu',
    'google-chat',
    'grafana-oncall',
    'heii-oncall',
    'home-assistant',
    'line-messaging',
    'mattermost',
    'nextcloud-talk',
    'onebot',
    'opsgenie',
    'pagerduty',
    'pumble',
    'pushbullet',
    'pushdeer',
    'pushy',
    'resend',
    'rocket-chat',
    'sendgrid',
    'serverchan',
    'signal',
    'splunk',
    'squadcast',
    'techulus-push',
    'twilio',
    'webpush',
    'wecom',
    'zoho-cliq',
  ]

  it('registers every wave-2 provider', () => {
    const names = listNotificationProviders().map((p) => p.name)
    for (const name of WAVE_2) expect(names).toContain(name)
    expect(names).toHaveLength(10 + WAVE_2.length)
  })

  it('every registered provider is describable with renderable fields', () => {
    const groups = Object.keys(NOTIFICATION_PROVIDER_GROUPS)
    for (const provider of listNotificationProviders()) {
      const descriptor = describeProvider(provider)
      expect(descriptor.name).toBe(provider.name)
      expect(descriptor.label.length).toBeGreaterThan(0)
      expect(groups).toContain(descriptor.group)
      expect(descriptor.fields.length).toBeGreaterThan(0)
      expect(descriptor.fields.some((f) => f.required)).toBe(true)
      for (const field of descriptor.fields) {
        expect(['string', 'number', 'boolean', 'enum']).toContain(field.kind)
        expect(field.label.length).toBeGreaterThan(0)
        if (field.kind === 'enum') expect(field.values!.length).toBeGreaterThan(0)
        if (field.options) {
          for (const key of Object.keys(field.options)) expect(field.values).toContain(key)
        }
      }
      // fieldMeta keys must match the schema so labels never go missing.
      const names = new Set(descriptor.fields.map((f) => f.name))
      for (const key of Object.keys(provider.fieldMeta ?? {})) expect(names.has(key)).toBe(true)
    }
    const all = describeNotificationProviders()
    expect(new Set(all.map((d) => d.name)).size).toBe(all.length)
  })

  it('rejects an invalid config before calling the network', async () => {
    await expect(send('pagerduty', {})).rejects.toThrow()
    await expect(send('mattermost', { webhookUrl: 'nope' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('mattermost', () => {
  it('posts a red attachment with the error on DOWN', async () => {
    await send('mattermost', {
      webhookUrl: 'https://mm.example.com/hooks/abc',
      channel: '#Alerts',
      iconEmoji: ':up: :down:',
    })
    expect(calls[0].url).toBe('https://mm.example.com/hooks/abc')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0]).get('content-type')).toBe('application/json')
    expect(calls[0].body).toMatchObject({
      username: 'API Marmot',
      channel: '#alerts',
      icon_emoji: ':down:',
      attachments: [
        {
          color: '#FF0000',
          title: 'API service went down.',
          title_link: 'https://api.example.com/health',
          fields: [
            { short: false, title: 'Error', value: 'Request failed with status code 503' },
            { short: true, title: 'Time', value: TIME },
          ],
        },
      ],
    })
  })

  it('posts a green attachment with ping on UP and plain text for tests', async () => {
    await send(
      'mattermost',
      { webhookUrl: 'https://mm.example.com/hooks/abc' },
      { heartbeat: upBeat },
    )
    expect(calls[0].body).toMatchObject({
      attachments: [{ color: '#32CD32', fields: [{ title: 'Ping', value: '123ms' }, {}] }],
    })
    await send('mattermost', { webhookUrl: 'https://mm.example.com/hooks/abc' }, test)
    expect(calls[1].body).toEqual({ username: 'Marmot', text: 'Testing' })
  })
})

describe('rocket-chat', () => {
  it('sends coloured attachments for DOWN and UP', async () => {
    await send('rocket-chat', {
      webhookUrl: 'https://rc.example.com/hooks/x',
      channel: '#ops',
      username: 'Marmot',
    })
    expect(calls[0].body).toMatchObject({
      text: 'Marmot Alert',
      channel: '#ops',
      username: 'Marmot',
      attachments: [{ color: '#ff0000', text: `*Message*\n${downMessage}` }],
    })
    await send(
      'rocket-chat',
      { webhookUrl: 'https://rc.example.com/hooks/x' },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toMatchObject({ attachments: [{ color: '#32cd32' }] })
  })
})

describe('google-chat', () => {
  afterEach(() => setGoogleChatRateLimitDelay(null))

  it('sends a cardsV2 message with message, time and address widgets', async () => {
    await send('google-chat', { webhookUrl: 'https://chat.googleapis.com/v1/spaces/x/messages' })
    const body = calls[0].body as {
      fallbackText: string
      cardsV2: { card: { header: { title: string }; sections: { widgets: unknown[] }[] } }[]
    }
    expect(body.fallbackText).toBe('🔴 API went down')
    expect(body.cardsV2[0].card.sections[0].widgets).toEqual([
      { textParagraph: { text: `<b>Message:</b>\n${downMessage}` } },
      { textParagraph: { text: `<b>Time:</b>\n${TIME}` } },
      { textParagraph: { text: '<b>Address:</b>\nhttps://api.example.com/health' } },
    ])

    await send(
      'google-chat',
      { webhookUrl: 'https://chat.googleapis.com/x' },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toMatchObject({ fallbackText: '✅ API is back online' })
  })

  it('renders templates and retries on HTTP 429', async () => {
    setGoogleChatRateLimitDelay(() => 0)
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        attempts++
        calls.push({ url: String(_url), init: init ?? {}, body: JSON.parse(String(init?.body)) })
        return new Response('rate limited', { status: attempts < 3 ? 429 : 200 })
      }),
    )
    await send('google-chat', {
      webhookUrl: 'https://chat.googleapis.com/x',
      useTemplate: true,
      template: '{{ name }}: {{ heartbeat.msg }}',
      maxRetries: 3,
    })
    expect(attempts).toBe(3)
    expect(calls[2].body).toEqual({ text: 'API: Request failed with status code 503' })

    attempts = 0
    await expect(
      send('google-chat', { webhookUrl: 'https://chat.googleapis.com/x', maxRetries: 2 }),
    ).rejects.toThrow(/HTTP 429/)
    expect(attempts).toBe(2)
  })
})

describe('pagerduty', () => {
  it('triggers an event on DOWN with a dedup key per monitor', async () => {
    await send('pagerduty', { integrationKey: 'rk_1', priority: 'critical' })
    expect(calls[0].url).toBe('https://events.pagerduty.com/v2/enqueue')
    expect(calls[0].body).toEqual({
      payload: {
        summary: '[Marmot Monitor 🔴 Down] [API] Request failed with status code 503',
        severity: 'critical',
        source: 'https://api.example.com/health',
      },
      routing_key: 'rk_1',
      event_action: 'trigger',
      dedup_key: 'Marmot/7',
    })
  })

  it('resolves on UP only when configured, and triggers test events', async () => {
    const skipped = await send('pagerduty', { integrationKey: 'rk_1' }, { heartbeat: upBeat })
    expect(skipped).toBe('no action required')
    expect(calls).toHaveLength(0)

    await send(
      'pagerduty',
      {
        integrationKey: 'rk_1',
        autoResolve: 'resolve',
        integrationUrl: 'https://pd.local/enqueue',
      },
      { heartbeat: upBeat },
    )
    expect(calls[0].url).toBe('https://pd.local/enqueue')
    expect(calls[0].body).toMatchObject({ event_action: 'resolve', dedup_key: 'Marmot/7' })

    await send('pagerduty', { integrationKey: 'rk_1' }, test)
    expect(calls[1].body).toMatchObject({
      event_action: 'trigger',
      dedup_key: 'Marmot/test',
      payload: { summary: '[Marmot Alert] Testing', source: 'Marmot Test Button' },
    })
  })
})

describe('opsgenie', () => {
  it('creates an alert on DOWN and closes it by alias on UP', async () => {
    await send('opsgenie', { apiKey: 'gk', region: 'eu', priority: 1 })
    expect(calls[0].url).toBe('https://api.eu.opsgenie.com/v2/alerts')
    expect(headersOf(calls[0]).get('authorization')).toBe('GenieKey gk')
    expect(calls[0].body).toEqual({
      message: 'Marmot Alert: API',
      alias: 'API',
      description: downMessage,
      source: 'Marmot',
      priority: 'P1',
    })

    await send('opsgenie', { apiKey: 'gk' }, { heartbeat: upBeat })
    expect(calls[1].url).toBe('https://api.opsgenie.com/v2/alerts/API/close?identifierType=alias')
    expect(calls[1].body).toEqual({ source: 'Marmot' })
  })
})

describe('apprise', () => {
  afterEach(() => setAppriseRunner(null))

  it('passes the message, URL and title to the CLI and surfaces errors', async () => {
    const runs: string[][] = []
    setAppriseRunner(async (args) => {
      runs.push(args)
      return { stdout: 'ok', stderr: '', code: 0 }
    })
    const result = await send('apprise', { appriseUrl: 'tgram://t/c', title: 'Marmot' })
    expect(result).toBe(OK_MESSAGE)
    expect(runs[0]).toEqual(['-vv', '-b', downMessage, 'tgram://t/c', '-t', 'Marmot'])

    setAppriseRunner(async () => ({ stdout: '', stderr: 'ERROR: bad url', code: 1 }))
    await expect(send('apprise', { appriseUrl: 'nope://' })).rejects.toThrow(/ERROR: bad url/)
    expect(calls).toHaveLength(0)
  })

  it('reports a missing binary readably', async () => {
    setAppriseRunner(null)
    const original = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      await expect(send('apprise', { appriseUrl: 'json://localhost' })).rejects.toThrow(
        /apprise CLI is not installed/,
      )
    } finally {
      process.env.PATH = original
    }
  })
})

describe('signal', () => {
  it('posts to signal-cli with split recipients and templates', async () => {
    await send('signal', {
      apiUrl: 'http://signal:8080/v2/send',
      number: '+491',
      recipients: '+492, +493 ,group.x',
    })
    expect(calls[0].url).toBe('http://signal:8080/v2/send')
    expect(calls[0].body).toEqual({
      message: downMessage,
      number: '+491',
      recipients: ['+492', '+493', 'group.x'],
    })
    await send(
      'signal',
      {
        apiUrl: 'http://signal:8080/v2/send',
        number: '+491',
        recipients: '+492',
        useTemplate: true,
        template: '{{ name }} {{ heartbeat.status }}',
      },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toMatchObject({ message: 'API up' })
  })
})

describe('home-assistant', () => {
  it('calls the notify service with a bearer token and monitor data', async () => {
    await send('home-assistant', {
      url: 'http://ha.local:8123/',
      longLivedAccessToken: 'llat',
      notificationService: 'mobile_app_phone',
    })
    expect(calls[0].url).toBe('http://ha.local:8123/api/services/notify/mobile_app_phone')
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer llat')
    expect(calls[0].body).toEqual({
      title: 'Marmot',
      message: downMessage,
      data: { name: 'API', status: 'down', channel: 'Marmot' },
    })
    await send(
      'home-assistant',
      {
        url: 'http://ha.local',
        longLivedAccessToken: 'x',
        notificationService: 'persistent_notification',
      },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toEqual({ title: 'Marmot', message: upMessage })
  })
})

describe('pushbullet', () => {
  it('pushes notes with the status label and time', async () => {
    await send('pushbullet', { accessToken: 'o.abc' })
    expect(calls[0].url).toBe('https://api.pushbullet.com/v2/pushes')
    expect(headersOf(calls[0]).get('access-token')).toBe('o.abc')
    expect(calls[0].body).toEqual({
      type: 'note',
      title: 'Marmot Alert: API',
      body: `[🔴 Down] Request failed with status code 503\nTime: ${TIME}`,
    })
    await send('pushbullet', { accessToken: 'o.abc' }, { heartbeat: upBeat })
    expect(calls[1].body).toMatchObject({ body: `[✅ Up] 200 - OK\nTime: ${TIME}` })
    await send('pushbullet', { accessToken: 'o.abc' }, test)
    expect(calls[2].body).toEqual({ type: 'note', title: 'Marmot Alert', body: 'Testing' })
  })
})

describe('twilio', () => {
  it('posts form-encoded SMS with basic auth (API key when set)', async () => {
    await send('twilio', {
      accountSid: 'AC1',
      apiKey: 'SK1',
      authToken: 'secret',
      fromNumber: '+1500',
      toNumber: '+1600',
      messagingServiceSid: 'MG1',
    })
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json')
    expect(calls[0].init.method).toBe('POST')
    const headers = headersOf(calls[0])
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('SK1:secret').toString('base64')}`,
    )
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded')
    const params = new URLSearchParams(calls[0].body as string)
    expect(params.get('To')).toBe('+1600')
    expect(params.get('From')).toBe('+1500')
    expect(params.get('Body')).toBe(downMessage)
    expect(params.get('MessagingServiceSid')).toBe('MG1')

    await send(
      'twilio',
      { accountSid: 'AC1', authToken: 's', fromNumber: '+1', toNumber: '+2' },
      { heartbeat: upBeat },
    )
    expect(headersOf(calls[1]).get('authorization')).toBe(
      `Basic ${Buffer.from('AC1:s').toString('base64')}`,
    )
    expect(new URLSearchParams(calls[1].body as string).has('MessagingServiceSid')).toBe(false)
  })
})

describe('sendgrid / resend', () => {
  it('sendgrid posts personalizations with cc/bcc lists', async () => {
    await send('sendgrid', {
      apiKey: 'SG.x',
      fromEmail: ' alerts@example.com ',
      toEmail: 'ops@example.com',
      ccEmail: 'a@example.com, b@example.com',
      subject: 'Alert',
    })
    expect(calls[0].url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer SG.x')
    expect(calls[0].body).toEqual({
      personalizations: [
        {
          to: [{ email: 'ops@example.com' }],
          cc: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
        },
      ],
      from: { email: 'alerts@example.com' },
      subject: 'Alert',
      content: [
        { type: 'text/plain', value: expect.stringContaining(downMessage) },
        { type: 'text/html', value: expect.stringContaining('<!doctype html>') },
      ],
    })
  })

  it('sendgrid renders the subject and HTML templates', async () => {
    await send('sendgrid', {
      apiKey: 'SG.x',
      fromEmail: 'alerts@example.com',
      toEmail: 'ops@example.com',
      subject: '{% if heartbeat.status == "down" %}DOWN{% else %}UP{% endif %}: {{ name }}',
      htmlTemplate: '<p>{{ heartbeat.msg }} {{ "<b>" }}</p><a href="https://x.test">Open</a>',
    })
    const body = calls[0].body as { subject: string; content: { type: string; value: string }[] }
    expect(body.subject).toBe('DOWN: API')
    expect(body.content[1]).toEqual({
      type: 'text/html',
      value: `<p>${downBeat.msg} &lt;b&gt;</p><a href="https://x.test">Open</a>`,
    })
    expect(body.content[0]).toEqual({
      type: 'text/plain',
      value: `${downBeat.msg} <b>\nOpen (https://x.test)`,
    })
  })

  it('resend posts a text email with the display name', async () => {
    await send(
      'resend',
      { apiKey: 're_x', fromEmail: 'alerts@example.com', toEmail: 'ops@example.com' },
      { heartbeat: upBeat },
    )
    expect(calls[0].url).toBe('https://api.resend.com/emails')
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer re_x')
    expect(calls[0].body).toEqual({
      from: 'Marmot <alerts@example.com>',
      to: 'ops@example.com',
      subject: 'Notification from Marmot',
      text: expect.stringContaining(upMessage),
      html: expect.stringContaining('<!doctype html>'),
    })
  })
})

describe('bark', () => {
  it('GETs the v1 path and POSTs JSON for v2', async () => {
    await send('bark', { endpoint: 'https://api.day.app/key/' })
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].url).toBe(
      `https://api.day.app/key/${encodeURIComponent('Marmot Monitor Down')}/${encodeURIComponent(downMessage)}?group=Marmot&sound=telegraph`,
    )
    await send(
      'bark',
      { endpoint: 'https://api.day.app/key', apiVersion: 'v2', group: 'Ops', sound: 'bell' },
      { heartbeat: upBeat },
    )
    expect(calls[1].url).toBe('https://api.day.app/key')
    expect(calls[1].body).toEqual({
      title: 'Marmot Monitor Up',
      body: upMessage,
      sound: 'bell',
      group: 'Ops',
    })
  })
})

describe('pushdeer / serverchan', () => {
  it('pushdeer posts markdown and validates the response', async () => {
    mockFetch(200, JSON.stringify({ content: { result: [JSON.stringify({ success: 'ok' })] } }))
    await send('pushdeer', { pushKey: 'PDU1' })
    expect(calls[0].url).toBe('https://api2.pushdeer.com/message/push')
    expect(calls[0].body).toEqual({
      pushkey: 'PDU1',
      text: '## Marmot: API down',
      desp: downMessage,
      type: 'markdown',
    })
    mockFetch(200, JSON.stringify({ content: { result: [] } }))
    await expect(send('pushdeer', { pushKey: 'bad' }, { heartbeat: upBeat })).rejects.toThrow(
      /Invalid PushDeer key/,
    )
  })

  it('serverchan routes sctp keys to ft07 and titles by status', async () => {
    expect(serverchanUrl('sctp123tabc')).toBe('https://123.push.ft07.com/send/sctp123tabc.send')
    expect(serverchanUrl('SCT1KEY')).toBe('https://sctapi.ftqq.com/SCT1KEY.send')
    await send('serverchan', { sendKey: 'SCT1KEY' })
    expect(calls[0].body).toEqual({ title: 'Marmot Monitor Down API', desp: downMessage })
    await send('serverchan', { sendKey: 'SCT1KEY' }, { heartbeat: upBeat })
    expect(calls[1].body).toEqual({ title: 'Marmot Monitor Up API', desp: upMessage })
  })
})

describe('splunk / squadcast', () => {
  it('splunk sends severity on DOWN and the configured recovery type on UP', async () => {
    await send('splunk', { restUrl: 'https://alert.victorops.com/x', severity: 'WARNING' })
    expect(calls[0].body).toEqual({
      message_type: 'WARNING',
      state_message:
        '[Marmot Monitor 🔴 Down] [https://api.example.com/health] Request failed with status code 503',
      entity_display_name: 'Marmot Alert: API',
      entity_id: 'Marmot/7',
    })
    expect(await send('splunk', { restUrl: 'https://x.y/z' }, { heartbeat: upBeat })).toBe(
      'No action required',
    )
    await send(
      'splunk',
      { restUrl: 'https://x.y/z', autoResolve: 'RECOVERY' },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toMatchObject({ message_type: 'RECOVERY' })
  })

  it('squadcast triggers and resolves with the heartbeat attached', async () => {
    await send('squadcast', { webhookUrl: 'https://api.squadcast.com/v2/incidents/api/x' })
    expect(calls[0].body).toMatchObject({
      message: 'API is DOWN',
      description: 'Request failed with status code 503',
      status: 'trigger',
      event_id: '7',
      source: 'marmot',
      tags: { AlertAddress: 'https://api.example.com/health' },
      heartbeat: { status: 'down' },
    })
    await send('squadcast', { webhookUrl: 'https://x.y/z' }, { heartbeat: upBeat })
    expect(calls[1].body).toMatchObject({ message: 'API is UP', status: 'resolve' })
  })
})

describe('webpush', () => {
  it('sends through web-push with VAPID details and the parsed subscription', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 })
    const subscription = {
      endpoint: 'https://push.example.com/abc',
      keys: { p256dh: 'p', auth: 'a' },
    }
    await send('webpush', {
      subscription: JSON.stringify(subscription),
      vapidPublicKey: 'pub',
      vapidPrivateKey: 'priv',
      vapidSubject: 'mailto:ops@example.com',
    })
    expect(sendNotification).toHaveBeenCalledWith(
      subscription,
      JSON.stringify({ title: 'Marmot', body: downMessage }),
      { vapidDetails: { subject: 'mailto:ops@example.com', publicKey: 'pub', privateKey: 'priv' } },
    )
    expect(calls).toHaveLength(0)

    sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }))
    await expect(
      send(
        'webpush',
        {
          subscription: JSON.stringify(subscription),
          vapidPublicKey: 'p',
          vapidPrivateKey: 'k',
          vapidSubject: 'mailto:x@y.z',
        },
        { heartbeat: upBeat },
      ),
    ).rejects.toThrow(/HTTP 410/)
    await expect(
      send('webpush', {
        subscription: '{}',
        vapidPublicKey: 'p',
        vapidPrivateKey: 'k',
        vapidSubject: 'x',
      }),
    ).rejects.toThrow(/endpoint/)
  })
})

describe('line-messaging / pumble / zoho-cliq', () => {
  it('line pushes a text message with a bearer token', async () => {
    await send('line-messaging', { channelAccessToken: 'tok', userId: 'U1' })
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/message/push')
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer tok')
    expect(calls[0].body).toEqual({
      to: 'U1',
      messages: [
        {
          type: 'text',
          text: `Marmot Alert: [🔴 Down]\nName: API \nRequest failed with status code 503\nTime: ${TIME}`,
        },
      ],
    })
    await send('line-messaging', { channelAccessToken: 'tok', userId: 'U1' }, { heartbeat: upBeat })
    expect((calls[1].body as { messages: { text: string }[] }).messages[0].text).toContain(
      '[✅ Up]',
    )
  })

  it('pumble posts coloured attachments', async () => {
    await send('pumble', { webhookUrl: 'https://api.pumble.com/hook' })
    expect(calls[0].body).toEqual({
      attachments: [
        { title: 'API is down', text: 'Request failed with status code 503', color: '#DC3645' },
      ],
    })
    await send('pumble', { webhookUrl: 'https://api.pumble.com/hook' }, { heartbeat: upBeat })
    expect(calls[1].body).toEqual({
      attachments: [{ title: 'API is up', text: '200 - OK', color: '#5BDD8B' }],
    })
  })

  it('zoho cliq posts a markdown text', async () => {
    await send('zoho-cliq', { webhookUrl: 'https://cliq.zoho.com/api/v2/x' })
    expect(calls[0].body).toEqual({
      text: '🔴 [API] went down\n\n*Description:* Request failed with status code 503\n*URL:* https://api.example.com/health',
    })
    await send('zoho-cliq', { webhookUrl: 'https://cliq.zoho.com/api/v2/x' }, { heartbeat: upBeat })
    expect((calls[1].body as { text: string }).text).toMatch(/^### ✅ \[API\] is back online/)
  })
})

describe('clicksend / alerta / grafana-oncall / heii-oncall', () => {
  it('clicksend strips non-ASCII and checks the API status', async () => {
    mockFetch(200, JSON.stringify({ data: { messages: [{ status: 'SUCCESS' }] } }))
    await send('clicksend', { login: 'u', password: 'k', toNumber: '+61', senderName: 'Marmot' })
    expect(calls[0].url).toBe('https://rest.clicksend.com/v3/sms/send')
    expect(headersOf(calls[0]).get('authorization')).toBe(
      `Basic ${Buffer.from('u:k').toString('base64')}`,
    )
    expect(calls[0].body).toEqual({
      messages: [
        {
          body: '[API] [ Down] Request failed with status code 503',
          to: '+61',
          source: 'marmot',
          from: 'Marmot',
        },
      ],
    })
    mockFetch(200, JSON.stringify({ data: { messages: [{ status: 'INVALID_RECIPIENT' }] } }))
    await expect(
      send('clicksend', { login: 'u', password: 'k', toNumber: 'x' }, { heartbeat: upBeat }),
    ).rejects.toThrow(/INVALID_RECIPIENT/)
  })

  it('alerta posts alerts with the configured severities', async () => {
    await send('alerta', {
      apiEndpoint: 'https://alerta.example.com/api/alert',
      apiKey: 'k',
      environment: 'Production',
    })
    expect(headersOf(calls[0]).get('authorization')).toBe('Key k')
    expect(calls[0].body).toMatchObject({
      environment: 'Production',
      severity: 'critical',
      event: 'http',
      group: 'marmot-http',
      resource: 'API',
      text: 'Service http is down.',
      correlate: ['service_up', 'service_down'],
    })
    await send(
      'alerta',
      {
        apiEndpoint: 'https://a.b/api/alert',
        apiKey: 'k',
        environment: 'P',
        recoverState: 'normal',
      },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toMatchObject({ severity: 'normal', text: 'Service http is up.' })
  })

  it('grafana oncall sends alerting/ok states', async () => {
    await send('grafana-oncall', { webhookUrl: 'https://oncall.grafana.net/x' })
    expect(calls[0].body).toEqual({
      title: 'API is down',
      message: 'Request failed with status code 503',
      state: 'alerting',
    })
    await send(
      'grafana-oncall',
      { webhookUrl: 'https://oncall.grafana.net/x' },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toEqual({ title: 'API is up', message: '200 - OK', state: 'ok' })
  })

  it('heii oncall alerts on DOWN and resolves on UP', async () => {
    await send('heii-oncall', { apiKey: 'k', triggerId: 't1' })
    expect(calls[0].url).toBe('https://heiioncall.com/triggers/t1/alert')
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer k')
    expect(calls[0].body).toMatchObject({ status: 'down', monitorName: 'API' })
    await send('heii-oncall', { apiKey: 'k', triggerId: 't1' }, { heartbeat: upBeat })
    expect(calls[1].url).toBe('https://heiioncall.com/triggers/t1/resolve')
  })
})

describe('nextcloud-talk / dingding / feishu / bitrix24 / wecom / onebot', () => {
  it('nextcloud talk signs the message and honours silent flags', async () => {
    await send('nextcloud-talk', {
      host: 'https://cloud.example.com/',
      conversationToken: 'abc',
      botSecret: 's3cret',
      sendSilentDown: true,
    })
    expect(calls[0].url).toBe(
      'https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/abc/message',
    )
    const headers = headersOf(calls[0])
    const random = headers.get('x-nextcloud-talk-bot-random')!
    expect(random).toMatch(/^[0-9a-f]{64}$/)
    expect(headers.get('x-nextcloud-talk-bot-signature')).toBe(
      signNextcloudTalk('s3cret', random, downMessage),
    )
    expect(headers.get('ocs-apirequest')).toBe('true')
    expect(calls[0].body).toEqual({ message: downMessage, silent: true })
    await send(
      'nextcloud-talk',
      { host: 'https://c.e', conversationToken: 'abc', botSecret: 's', sendSilentDown: true },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toEqual({ message: upMessage, silent: false })
  })

  it('dingding signs the webhook and sends markdown with mentions', async () => {
    mockFetch(200, '{"errcode":0,"errmsg":"ok"}')
    await send('dingding', {
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
      secretKey: 'SEC1',
      mentioning: 'specify-mobiles',
      mobileList: '138, 139',
    })
    const url = new URL(calls[0].url)
    expect(url.searchParams.get('access_token')).toBe('t')
    expect(url.searchParams.get('timestamp')).toMatch(/^\d+$/)
    expect(url.searchParams.get('sign')).toBeTruthy()
    expect(calls[0].body).toEqual({
      msgtype: 'markdown',
      markdown: {
        title: '[DOWN] API',
        text: `## [DOWN] API \n> Request failed with status code 503\n> Time: ${TIME}\n@138 @139`,
      },
      at: { isAtAll: false, atUserIds: [], atMobiles: ['138', '139'] },
    })
    await send(
      'dingding',
      {
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
        secretKey: 'S',
        mentioning: 'everyone',
      },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toMatchObject({ markdown: { title: '[UP] API' }, at: { isAtAll: true } })

    mockFetch(200, '{"errcode":310000,"errmsg":"sign not match"}')
    await expect(
      send('dingding', {
        webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
        secretKey: 'S',
      }),
    ).rejects.toThrow(/sign not match/)
  })

  it('feishu sends interactive cards and plain text for tests', async () => {
    await send('feishu', { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' })
    expect(calls[0].body).toMatchObject({
      msg_type: 'interactive',
      card: {
        header: { title: { content: 'Marmot Alert: [Down] API' }, template: 'red' },
        elements: [
          {
            text: {
              content: `**Message**: Request failed with status code 503\n**Ping**: N/A\n**Time**: ${TIME}`,
            },
          },
        ],
      },
    })
    await send('feishu', { webhookUrl: 'https://open.feishu.cn/x' }, { heartbeat: upBeat })
    expect(calls[1].body).toMatchObject({
      card: {
        header: { template: 'green' },
        elements: [{ text: { content: expect.stringContaining('**Ping**: 123 ms') } }],
      },
    })
    await send('feishu', { webhookUrl: 'https://open.feishu.cn/x' }, test)
    expect(calls[2].body).toEqual({ msg_type: 'text', content: { text: 'Testing' } })
  })

  it('bitrix24 GETs im.notify.system.add with query parameters', async () => {
    await send('bitrix24', { webhookUrl: 'https://example.bitrix24.com/rest/1/abc/', userId: '42' })
    expect(calls[0].init.method).toBe('GET')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/rest/1/abc/im.notify.system.add.json')
    expect(url.searchParams.get('user_id')).toBe('42')
    expect(url.searchParams.get('message')).toBe('[B]Marmot[/B]')
    expect(url.searchParams.get('ATTACH[COLOR]')).toBe('#b73419')
    expect(url.searchParams.get('ATTACH[BLOCKS][0][MESSAGE]')).toBe(downMessage)
    await send(
      'bitrix24',
      { webhookUrl: 'https://e.b/rest/1/abc', userId: '42' },
      { heartbeat: upBeat },
    )
    expect(new URL(calls[1].url).searchParams.get('ATTACH[COLOR]')).toBe('#67b518')
  })

  it('wecom posts text with the status title and mentions', async () => {
    await send('wecom', { botKey: 'k1', mentionedMobileList: '138,@all' })
    expect(calls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1')
    expect(calls[0].body).toEqual({
      msgtype: 'text',
      text: {
        content: `Marmot Monitor Down\n${downMessage}`,
        mentioned_mobile_list: ['138', '@all'],
      },
    })
    await send('wecom', { botKey: 'k1' }, { heartbeat: upBeat })
    expect(calls[1].body).toEqual({
      msgtype: 'text',
      text: { content: `Marmot Monitor Up\n${upMessage}` },
    })
  })

  it('onebot normalises the address and targets groups or users', async () => {
    expect(onebotSendUrl('127.0.0.1:5700')).toBe('http://127.0.0.1:5700/send_msg')
    expect(onebotSendUrl('https://bot.example.com/')).toBe('https://bot.example.com/send_msg')
    await send('onebot', { httpAddr: '127.0.0.1:5700', accessToken: 'tok', receiverId: '12345' })
    expect(calls[0].url).toBe('http://127.0.0.1:5700/send_msg')
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer tok')
    expect(calls[0].body).toEqual({
      auto_escape: true,
      message: `Marmot Alert: ${downMessage}`,
      message_type: 'group',
      group_id: '12345',
    })
    await send(
      'onebot',
      { httpAddr: 'http://b', accessToken: 't', msgType: 'private', receiverId: '9' },
      { heartbeat: upBeat },
    )
    expect(calls[1].body).toMatchObject({ message_type: 'private', user_id: '9' })
  })
})

describe('techulus-push / pushy', () => {
  it('techulus posts to the keyed endpoint with optional channel and sound', async () => {
    await send('techulus-push', {
      apiKey: 'k',
      channel: 'ops',
      sound: 'harp',
      timeSensitive: false,
    })
    expect(calls[0].url).toBe('https://push.techulus.com/api/v1/notify/k')
    expect(calls[0].body).toEqual({
      title: 'Marmot',
      body: downMessage,
      timeSensitive: false,
      channel: 'ops',
      sound: 'harp',
    })
  })

  it('pushy posts the notification with the API key in the query', async () => {
    await send('pushy', { apiKey: 'k', deviceToken: 'd' }, { heartbeat: upBeat })
    expect(calls[0].url).toBe('https://api.pushy.me/push?api_key=k')
    expect(calls[0].body).toEqual({
      to: 'd',
      data: { message: 'Marmot' },
      notification: { body: upMessage, badge: 1, sound: 'ping.aiff' },
    })
  })
})
