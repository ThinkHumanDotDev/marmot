import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Heartbeat, Monitor } from '@/payload-types'
import {
  describeNotificationProviders,
  getNotificationProvider,
  listNotificationProviders,
  OK_MESSAGE,
} from './index'
import { setSmtpTransportFactory } from './smtp'

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

const message = '[API] [🔴 Down] Request failed with status code 503'

type Call = { url: string; init: RequestInit; body: unknown }

let calls: Call[]
let fetchMock: ReturnType<typeof vi.fn>

function mockFetch(status = 200, body = '{"ok":true}') {
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
  })
  vi.stubGlobal('fetch', fetchMock)
}

const send = (
  type: string,
  config: Record<string, unknown>,
  ctx: { monitor?: Monitor | null; heartbeat?: Heartbeat | null; message?: string } = {},
) => {
  const provider = getNotificationProvider(type)
  if (!provider) throw new Error(`provider ${type} missing`)
  return provider.send({
    config,
    message: ctx.message ?? message,
    monitor: ctx.monitor === undefined ? monitor : ctx.monitor,
    heartbeat: ctx.heartbeat === undefined ? downBeat : ctx.heartbeat,
  })
}

const headersOf = (call: Call) => new Headers(call.init.headers)

beforeEach(() => {
  calls = []
  mockFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('notification provider registry', () => {
  it('registers the first ten built-in providers with renderable schemas', () => {
    const names = listNotificationProviders().map((p) => p.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'discord',
        'gotify',
        'matrix',
        'ntfy',
        'pushover',
        'slack',
        'smtp',
        'teams',
        'telegram',
        'webhook',
      ]),
    )
    // The full list (including wave 2) is asserted in providers-2.test.ts.
    const descriptors = describeNotificationProviders()
    expect(descriptors).toHaveLength(names.length)
    const discord = descriptors.find((d) => d.name === 'discord')!
    expect(discord.group).toBe('chat')
    expect(discord.fields.find((f) => f.name === 'webhookUrl')).toMatchObject({
      kind: 'string',
      required: true,
      secret: true,
    })
    expect(discord.fields.find((f) => f.name === 'messageFormat')).toMatchObject({
      kind: 'enum',
      required: false,
      defaultValue: 'normal',
      values: ['normal', 'minimalist', 'custom'],
    })
    const ntfy = descriptors.find((d) => d.name === 'ntfy')!
    expect(ntfy.fields.find((f) => f.name === 'priority')).toMatchObject({
      kind: 'number',
      required: false,
      defaultValue: 4,
    })
    expect(ntfy.fields.find((f) => f.name === 'password')).toMatchObject({
      kind: 'string',
      required: false,
      secret: true,
    })
  })
})

describe('discord', () => {
  it('posts a red embed for a DOWN heartbeat', async () => {
    const result = await send('discord', {
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      username: 'Marmot',
      prefixMessage: '@here',
    })
    expect(result).toBe(OK_MESSAGE)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/1/abc')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0]).get('content-type')).toBe('application/json')
    const body = calls[0].body as {
      username: string
      content: string
      embeds: { title: string; color: number; fields: { name: string; value: string }[] }[]
    }
    expect(body.username).toBe('Marmot')
    expect(body.content).toBe('@here')
    expect(body.embeds[0].color).toBe(16711680)
    expect(body.embeds[0].title).toContain('API went down')
    expect(body.embeds[0].fields).toEqual(
      expect.arrayContaining([
        { name: 'Service Name', value: 'API' },
        { name: 'Service URL', value: 'https://api.example.com/health' },
        { name: 'Error', value: 'Request failed with status code 503' },
      ]),
    )
  })

  it('posts a green embed with ping for an UP heartbeat and plain content for tests', async () => {
    await send(
      'discord',
      { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      { heartbeat: upBeat },
    )
    const up = calls[0].body as { embeds: { color: number; fields: { name: string }[] }[] }
    expect(up.embeds[0].color).toBe(65280)
    expect(up.embeds[0].fields.map((f) => f.name)).toContain('Ping')

    await send(
      'discord',
      { webhookUrl: 'https://discord.com/api/webhooks/1/abc', suppressNotifications: true },
      { monitor: null, heartbeat: null, message: 'Testing' },
    )
    expect(calls[1].body).toEqual({ username: 'Marmot', content: 'Testing', flags: 1 << 12 })
  })

  it('renders custom templates and threads', async () => {
    await send('discord', {
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      messageFormat: 'custom',
      messageTemplate: '{{ monitor.name }} is {{ status }}: {{ heartbeat.msg }}',
      channelType: 'postToThread',
      threadId: '555',
    })
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/1/abc?thread_id=555')
    expect(calls[0].body).toMatchObject({
      content: 'API is 🔴 Down: Request failed with status code 503',
    })
  })

  it('surfaces HTTP errors with status and body', async () => {
    mockFetch(401, '{"message":"Invalid Webhook Token"}')
    await expect(
      send('discord', { webhookUrl: 'https://discord.com/api/webhooks/1/abc' }),
    ).rejects.toThrow(/HTTP 401.*Invalid Webhook Token/)
  })

  it('rejects an invalid config before calling the network', async () => {
    await expect(send('discord', { webhookUrl: 'not a url' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('slack', () => {
  it('sends a rich attachment with blocks and the channel mention', async () => {
    await send('slack', {
      webhookUrl: 'https://hooks.slack.com/services/T/B/x',
      channel: '#alerts',
      username: 'Marmot',
      iconEmoji: ':bell:',
      channelNotify: true,
    })
    expect(calls[0].url).toBe('https://hooks.slack.com/services/T/B/x')
    const body = calls[0].body as {
      text: string
      channel: string
      username: string
      icon_emoji: string
      attachments: { color: string; blocks: { type: string }[] }[]
    }
    expect(body.text).toBe(`${message} <!channel>`)
    expect(body.channel).toBe('#alerts')
    expect(body.username).toBe('Marmot')
    expect(body.icon_emoji).toBe(':bell:')
    expect(body.attachments[0].color).toBe('#e01e5a')
    expect(body.attachments[0].blocks.map((b) => b.type)).toEqual(['header', 'section', 'actions'])
  })

  it('sends plain text when rich messages are off and for templates', async () => {
    await send('slack', { webhookUrl: 'https://hooks.slack.com/x', richMessage: false })
    expect(calls[0].body).toMatchObject({ text: `API\n${message}` })

    await send('slack', {
      webhookUrl: 'https://hooks.slack.com/x',
      useTemplate: true,
      template: '{{ name }} → {{ heartbeat.status }}',
    })
    expect(calls[1].body).toMatchObject({ text: 'API → down' })
  })
})

describe('telegram', () => {
  it('calls sendMessage on the bot API with the chat id and flags', async () => {
    await send('telegram', {
      botToken: '123:ABC',
      chatId: '-1001',
      messageThreadId: '42',
      sendSilently: true,
      protectContent: true,
    })
    expect(calls[0].url).toBe('https://api.telegram.org/bot123:ABC/sendMessage')
    expect(calls[0].body).toEqual({
      chat_id: '-1001',
      text: message,
      disable_notification: true,
      protect_content: true,
      link_preview_options: { is_disabled: true },
      message_thread_id: '42',
    })
  })

  it('escapes MarkdownV2 templates and honours a custom server', async () => {
    await send('telegram', {
      botToken: 't',
      chatId: '1',
      serverUrl: 'https://tg.local/',
      useTemplate: true,
      template: '*{{ monitor.name }}*: {{ heartbeat.msg }}',
      templateParseMode: 'MarkdownV2',
    })
    expect(calls[0].url).toBe('https://tg.local/bott/sendMessage')
    expect(calls[0].body).toMatchObject({
      parse_mode: 'MarkdownV2',
      text: '*API*: Request failed with status code 503',
    })
  })
})

describe('ntfy', () => {
  it('publishes to the topic with bumped priority and tags on DOWN', async () => {
    await send('ntfy', {
      serverUrl: 'https://ntfy.sh/',
      topic: 'marmot',
      priority: 3,
      authMethod: 'accessToken',
      accessToken: 'tk_abc',
    })
    expect(calls[0].url).toBe('https://ntfy.sh')
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer tk_abc')
    expect(calls[0].body).toEqual({
      topic: 'marmot',
      message: 'Request failed with status code 503',
      priority: 4,
      title: 'API Down [Marmot]',
      tags: ['red_circle'],
      actions: [{ action: 'view', label: 'Open API', url: 'https://api.example.com/health' }],
    })
  })

  it('uses basic auth and the test tag for test messages', async () => {
    await send(
      'ntfy',
      { topic: 't', authMethod: 'usernamePassword', username: 'u', password: 'p' },
      { monitor: null, heartbeat: null, message: 'Testing' },
    )
    expect(headersOf(calls[0]).get('authorization')).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    )
    expect(calls[0].body).toMatchObject({ topic: 't', tags: ['test_tube'], priority: 4 })
  })
})

describe('webhook', () => {
  it('posts heartbeat, monitor and msg as JSON with additional headers', async () => {
    await send('webhook', {
      url: 'https://example.com/hook',
      additionalHeaders: '{"Authorization":"Bearer x","X-Env":"prod"}',
    })
    expect(calls[0].url).toBe('https://example.com/hook')
    expect(calls[0].init.method).toBe('POST')
    const headers = headersOf(calls[0])
    expect(headers.get('authorization')).toBe('Bearer x')
    expect(headers.get('x-env')).toBe('prod')
    expect(headers.get('content-type')).toBe('application/json')
    expect(calls[0].body).toEqual({
      msg: message,
      monitor: JSON.parse(JSON.stringify(monitor)),
      heartbeat: JSON.parse(JSON.stringify(downBeat)),
    })
  })

  it('renders a custom body verbatim and rejects invalid headers', async () => {
    await send('webhook', {
      url: 'https://example.com/hook',
      method: 'PUT',
      contentType: 'custom',
      customBody: '{"text": "{{ msg }}", "name": "{{ monitor.name }}"}',
      additionalHeaders: '{"Content-Type":"application/json"}',
    })
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].body).toEqual({ text: message, name: 'API' })

    await expect(
      send('webhook', { url: 'https://example.com/hook', additionalHeaders: 'nope' }),
    ).rejects.toThrow(/not valid JSON/)
  })

  it('sends multipart form data and GET query parameters', async () => {
    await send('webhook', { url: 'https://example.com/hook', contentType: 'form-data' })
    expect(calls[0].init.body).toBeInstanceOf(FormData)
    expect((calls[0].init.body as FormData).get('data')).toContain('"msg"')

    await send('webhook', { url: 'https://example.com/hook', method: 'GET' })
    const url = new URL(calls[1].url)
    expect(calls[1].init.method).toBe('GET')
    expect(url.searchParams.get('msg')).toBe(message)
    expect(JSON.parse(url.searchParams.get('monitor')!)).toMatchObject({ name: 'API' })
  })
})

describe('teams', () => {
  it('sends an adaptive card with facts and an open-url action', async () => {
    await send('teams', { webhookUrl: 'https://prod.westus.logic.azure.com/workflows/x' })
    const body = calls[0].body as {
      type: string
      summary: string
      attachments: {
        contentType: string
        content: { body: { type: string; facts?: { title: string; value: string }[] }[] }
      }[]
    }
    expect(body.type).toBe('message')
    expect(body.summary).toBe('🔴 [API] went down')
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive')
    const facts = body.attachments[0].content.body.find((b) => b.type === 'FactSet')!.facts!
    expect(facts.map((f) => f.title)).toEqual(['Description', 'Monitor', 'URL', 'Time'])
    expect(body.attachments[0].content.body.at(-1)).toMatchObject({ type: 'ActionSet' })
  })
})

describe('gotify', () => {
  it('posts to /message with the app token in the query string', async () => {
    await send('gotify', { serverUrl: 'https://gotify.local/', appToken: 'A.b/c', priority: 5 })
    expect(calls[0].url).toBe('https://gotify.local/message?token=A.b%2Fc')
    expect(calls[0].body).toEqual({ message, priority: 5, title: 'Marmot: API' })
  })
})

describe('pushover', () => {
  it('posts to the Pushover API with sounds, priority and time', async () => {
    await send(
      'pushover',
      {
        userKey: 'u',
        appToken: 't',
        device: 'phone',
        priority: '1',
        sound: 'siren',
        soundUp: 'magic',
        ttl: 600,
      },
      { heartbeat: upBeat },
    )
    expect(calls[0].url).toBe('https://api.pushover.net/1/messages.json')
    expect(calls[0].body).toMatchObject({
      user: 'u',
      token: 't',
      device: 'phone',
      priority: 1,
      sound: 'magic',
      ttl: 600,
      html: 1,
      title: 'Marmot',
    })
    expect((calls[0].body as { message: string }).message).toContain(
      '<b>Time</b>: 2026-03-10 10:30:00 (UTC)',
    )
  })
})

describe('matrix', () => {
  it('PUTs an m.room.message with a bearer token and random txn id', async () => {
    await send('matrix', {
      homeserverUrl: 'https://matrix.example.org/',
      internalRoomId: '!room:example.org',
      accessToken: 'syt_abc',
    })
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].url).toMatch(
      /^https:\/\/matrix\.example\.org\/_matrix\/client\/r0\/rooms\/!room%3Aexample\.org\/send\/m\.room\.message\/[A-Za-z0-9%]+$/,
    )
    expect(headersOf(calls[0]).get('authorization')).toBe('Bearer syt_abc')
    expect(calls[0].body).toEqual({ msgtype: 'm.text', body: message })
  })
})

describe('smtp', () => {
  afterEach(() => setSmtpTransportFactory(null))

  it('builds the transport from the channel and sends subject/body templates', async () => {
    const sendMail = vi.fn(async () => ({}))
    const transports: Record<string, unknown>[] = []
    setSmtpTransportFactory((options) => {
      transports.push(options)
      return { sendMail } as never
    })

    await send('smtp', {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'u',
      pass: 'p',
      from: 'Marmot <alerts@example.com>',
      to: 'ops@example.com, oncall@example.com',
      subject: '{{ name }} is {{ status }}',
      body: '<p>{{ heartbeat.msg }}</p>',
      htmlBody: true,
    })

    expect(transports[0]).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'u', pass: 'p' },
    })
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Marmot <alerts@example.com>',
        to: 'ops@example.com, oncall@example.com',
        subject: 'API is 🔴 Down',
        html: '<p>Request failed with status code 503</p>',
      }),
    )
    expect(calls).toHaveLength(0)
  })

  it('refuses useServerSmtp when the instance has no SMTP_HOST', async () => {
    await expect(send('smtp', { useServerSmtp: true, to: 'ops@example.com' })).rejects.toThrow(
      /SMTP_HOST/,
    )
  })
})
