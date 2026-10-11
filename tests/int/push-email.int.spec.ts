import nodemailer from 'nodemailer'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { POST as inboundRoute } from '@/app/api/inbound-email/route'
import { resetEnvCache } from '@/env'
import type { Heartbeat, Monitor, Organization, PushEvent } from '@/payload-types'
import { isPushEmailEnabled, monitorPushEmailAddress } from '@/server/push/email'
import { startInboundSmtp, type InboundSmtpListener } from '@/server/push/smtp'

/**
 * Ping-by-email for push monitors (#135): the SMTP listener and the inbound-parse webhook record
 * successes, failures and starts by keyword; unknown tokens and oversized mail are refused without
 * taking the listener down; the feature is off without a domain and a transport.
 */
let payload: Payload
let org: Organization
let smtp: InboundSmtpListener
const run = Date.now().toString(36)
const DOMAIN = 'ping.marmot.test'
const SECRET = `inbound-secret-${run}-xxxxxxxx`
const MAX_BYTES = 20_000

const ENV_KEYS = [
  'INBOUND_EMAIL_DOMAIN',
  'INBOUND_SMTP_PORT',
  'INBOUND_EMAIL_WEBHOOK_SECRET',
  'INBOUND_EMAIL_MAX_BYTES',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEnvCache()
}

const enable = () =>
  setEnv({
    INBOUND_EMAIL_DOMAIN: DOMAIN,
    INBOUND_SMTP_PORT: '2525',
    INBOUND_EMAIL_WEBHOOK_SECRET: SECRET,
    INBOUND_EMAIL_MAX_BYTES: String(MAX_BYTES),
  })

let counter = 0
async function createPushMonitor(extra: Partial<Monitor> = {}) {
  counter += 1
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      name: `email-push-${run}-${counter}`,
      type: 'push',
      interval: 3600,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 5,
      ...extra,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

const addressOf = (monitor: Monitor) => `${monitor.pushToken}@${DOMAIN}`

async function beatsOf(monitor: Monitor): Promise<Heartbeat[]> {
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { monitor: { equals: monitor.id } },
    sort: 'time',
    depth: 0,
    overrideAccess: true,
  })
  return docs as Heartbeat[]
}

async function eventsOf(monitor: Monitor): Promise<PushEvent[]> {
  const { docs } = await payload.find({
    collection: 'push-events',
    where: { monitor: { equals: monitor.id } },
    sort: 'time',
    depth: 0,
    overrideAccess: true,
  })
  return docs as PushEvent[]
}

const transport = () =>
  nodemailer.createTransport({
    host: '127.0.0.1',
    port: smtp.port,
    secure: false,
    ignoreTLS: true,
  })

const send = (to: string, subject: string, text = 'Report attached.') =>
  transport().sendMail({ from: 'backup@nas.example', to, subject, text })

function webhook(
  body: BodyInit,
  init: { contentType?: string; secret?: string | null; headers?: Record<string, string> } = {},
) {
  const secret = init.secret === undefined ? SECRET : init.secret
  const url = `http://localhost/api/inbound-email${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`
  return inboundRoute(
    new Request(url, {
      method: 'POST',
      body,
      headers: {
        ...(init.contentType ? { 'content-type': init.contentType } : {}),
        ...init.headers,
      },
    }),
  )
}

describe('ping-by-email for push monitors', () => {
  beforeAll(async () => {
    enable()
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Email pings', slug: `email-pings-${run}` },
    })
    smtp = await startInboundSmtp(payload, { port: 0, host: '127.0.0.1' })
  })

  beforeEach(() => enable())

  afterAll(async () => {
    await smtp?.close()
    setEnv(savedEnv)
    if (org) {
      await payload.delete({
        collection: 'monitors',
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
  })

  it('is off without a domain or without a transport', () => {
    expect(isPushEmailEnabled()).toBe(true)
    setEnv({ INBOUND_EMAIL_DOMAIN: undefined })
    expect(isPushEmailEnabled()).toBe(false)
    enable()
    setEnv({ INBOUND_SMTP_PORT: '0', INBOUND_EMAIL_WEBHOOK_SECRET: undefined })
    expect(isPushEmailEnabled()).toBe(false)
    expect(monitorPushEmailAddress({ type: 'push', pushToken: 'abc' })).toBeNull()
    enable()
    expect(monitorPushEmailAddress({ type: 'push', pushToken: 'abc' })).toBe(`abc@${DOMAIN}`)
    expect(monitorPushEmailAddress({ type: 'http', pushToken: 'abc' })).toBeNull()
  })

  it('SMTP: "Backup OK" records a success, "Backup FAILED" a failure with the keyword', async () => {
    const monitor = await createPushMonitor({ pushEmailFailureKeyword: 'FAILED' })
    await send(addressOf(monitor), 'Backup OK', 'All 42 shares copied.')
    await send(addressOf(monitor), 'Backup FAILED', 'Share "photos" could not be read.')

    const beats = await beatsOf(monitor)
    expect(beats.map((beat) => [beat.status, beat.msg])).toEqual([
      ['up', 'Backup OK'],
      ['down', 'Backup FAILED'],
    ])
    const events = await eventsOf(monitor)
    expect(events.map((event) => [event.kind, event.source, event.msg])).toEqual([
      ['success', 'email', 'Backup OK'],
      ['fail', 'email', 'Backup FAILED'],
    ])
    expect(events[1].body).toContain('could not be read')
  })

  it('SMTP: start keyword opens a run; unmatched mail is ignored or a failure', async () => {
    const monitor = await createPushMonitor({
      pushEmailSuccessKeyword: 'completed',
      pushEmailStartKeyword: 'started',
    })
    await send(addressOf(monitor), 'Job started')
    await send(addressOf(monitor), 'Weekly newsletter')
    await send(addressOf(monitor), 'Job completed')
    expect((await eventsOf(monitor)).map((event) => [event.kind, event.msg])).toEqual([
      ['start', 'Job started'],
      ['log', 'Ignored: Weekly newsletter'],
      ['success', 'Job completed'],
    ])
    const beats = await beatsOf(monitor)
    expect(beats).toHaveLength(1)
    expect(beats[0].status).toBe('up')

    const strict = await createPushMonitor({
      pushEmailSuccessKeyword: 'completed',
      pushEmailUnmatched: 'fail',
    })
    await send(addressOf(strict), 'Weekly newsletter')
    expect((await beatsOf(strict)).map((beat) => beat.status)).toEqual(['down'])
  })

  it('SMTP: refuses unknown tokens, other domains and oversized mail, and keeps serving', async () => {
    const monitor = await createPushMonitor()
    await expect(send(`nobody${run}@${DOMAIN}`, 'Backup OK')).rejects.toMatchObject({
      responseCode: 550,
    })
    await expect(send(`${monitor.pushToken}@elsewhere.test`, 'Backup OK')).rejects.toMatchObject({
      responseCode: 550,
    })
    await expect(send(addressOf(monitor), 'Huge', 'x'.repeat(MAX_BYTES * 2))).rejects.toThrow()

    // Paused monitors do not take mail either.
    const paused = await createPushMonitor({ active: false })
    await expect(send(addressOf(paused), 'Backup OK')).rejects.toMatchObject({ responseCode: 550 })

    // Still listening, and nothing above was recorded.
    expect(await eventsOf(monitor)).toHaveLength(0)
    await send(addressOf(monitor), 'Backup OK')
    expect((await eventsOf(monitor)).map((event) => event.kind)).toEqual(['success'])
  })

  it('webhook: Postmark JSON, Mailgun form and a raw message', async () => {
    const monitor = await createPushMonitor({ pushEmailFailureKeyword: 'FAILED' })

    const postmark = await webhook(
      JSON.stringify({
        OriginalRecipient: addressOf(monitor),
        ToFull: [{ Email: addressOf(monitor), Name: '' }],
        Subject: 'Backup OK',
        TextBody: 'fine',
      }),
      { contentType: 'application/json' },
    )
    expect(postmark.status).toBe(200)
    expect(await postmark.json()).toEqual({ ok: true, accepted: 1 })

    const form = new FormData()
    form.set('recipient', addressOf(monitor))
    form.set('subject', 'Backup FAILED')
    form.set('body-plain', 'disk full')
    expect((await webhook(form)).status).toBe(200)

    const raw = [
      'From: nas@example.test',
      `To: Backups <${addressOf(monitor)}>`,
      'Subject: =?UTF-8?Q?Backup_OK_=E2=9C=94?=',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Done.',
    ].join('\r\n')
    const rawResponse = await webhook(raw, {
      contentType: 'message/rfc822',
      secret: null,
      headers: { 'x-marmot-secret': SECRET },
    })
    expect(await rawResponse.json()).toEqual({ ok: true, accepted: 1 })

    expect((await eventsOf(monitor)).map((event) => [event.kind, event.msg])).toEqual([
      ['success', 'Backup OK'],
      ['fail', 'Backup FAILED'],
      ['success', 'Backup OK ✔'],
    ])
  })

  it('webhook: secret, size limit, unknown tokens and the off switch', async () => {
    const body = JSON.stringify({ To: `nobody${run}@${DOMAIN}`, Subject: 'Backup OK' })
    expect((await webhook(body, { contentType: 'application/json', secret: null })).status).toBe(
      401,
    )
    expect(
      (await webhook(body, { contentType: 'application/json', secret: `${SECRET}x` })).status,
    ).toBe(401)
    // Basic auth carries the secret as the password.
    const basic = Buffer.from(`marmot:${SECRET}`).toString('base64')
    const unknown = await webhook(body, {
      contentType: 'application/json',
      secret: null,
      headers: { authorization: `Basic ${basic}` },
    })
    expect(await unknown.json()).toEqual({ ok: true, accepted: 0 })

    const huge = await webhook(JSON.stringify({ To: 'x', TextBody: 'x'.repeat(MAX_BYTES) }), {
      contentType: 'application/json',
    })
    expect(huge.status).toBe(413)

    expect((await webhook('{nope', { contentType: 'application/json' })).status).toBe(400)

    setEnv({ INBOUND_EMAIL_WEBHOOK_SECRET: undefined })
    expect((await webhook(body, { contentType: 'application/json' })).status).toBe(404)
  })
})
