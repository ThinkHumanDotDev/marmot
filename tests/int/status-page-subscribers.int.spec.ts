import { UnrecoverableError } from 'bullmq'
import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { GET as listNotificationsRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/notifications/route'
import {
  GET as getNotificationRoute,
  POST as notificationActionRoute,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/notifications/[notificationId]/route'
import { GET as exportRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/subscribers/export/route'
import { POST as importRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/subscribers/import/route'
import {
  GET as listSubscribersRoute,
  POST as addSubscriberRoute,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/subscribers/route'
import { POST as accessRoute } from '@/app/api/status-pages/[slug]/access/route'
import { POST as smsInboundRoute } from '@/app/api/status-pages/[slug]/sms-inbound/route'
import { POST as subscribeRoute } from '@/app/api/status-pages/[slug]/subscribe/route'
import { POST as verifyRoute } from '@/app/api/status-pages/[slug]/subscribe/verify/route'
import { POST as confirmRoute } from '@/app/api/status-pages/[slug]/subscriptions/[token]/confirm/route'
import {
  GET as subscriptionRoute,
  PATCH as patchSubscriptionRoute,
} from '@/app/api/status-pages/[slug]/subscriptions/[token]/route'
import { POST as unsubscribeRoute } from '@/app/api/status-pages/[slug]/subscriptions/[token]/unsubscribe/route'
import { buildMarmotExport, parseMarmotExport } from '@/server/import-export/marmot'
import type { MaintenanceEvent } from '@/server/maintenance/events'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import {
  announceMaintenanceEvent,
  processSubscriberJob,
  setSubscriberJobSink,
  subscriberLinkToken,
  SUBSCRIBE_RATE_LIMIT,
  type SubscriberJob,
} from '@/server/status-pages/subscribers'
import { twilioSignature } from '@/server/status-pages/subscribers/twilio'
import { verifyWebhookSignature } from '@/server/webhooks/signature'
import type {
  Incident,
  Monitor,
  Notification,
  Organization,
  StatusPage,
  StatusPageSubscriber,
  SubscriberNotification,
  User,
} from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+sub-${run}@marmot.test`
const PASSWORD = 'password-123'

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  params: Record<string, string>,
  init: RequestInit & { url?: string } = {},
): Promise<Response> =>
  (handler as Handler)(new Request(init.url ?? 'http://localhost:3000/api/test', init), {
    params: Promise.resolve(params),
  })

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

let owner: User
let member: User
let viewer: User
let org: Organization
let apiMonitor: Monitor
let webMonitor: Monitor
let page: StatusPage
let apiC: string
let webC: string
let twilio: Notification
let ownerToken: string
let memberToken: string
let viewerToken: string

const auth = (token: string) => ({ authorization: `JWT ${token}` })
const pageParams = () => ({ orgId: String(org.id), id: String(page.id) })

// ---------------------------------------------------------------------------------------------
// Captured side effects

type SentEmail = {
  to: string
  subject: string
  text: string
  html: string
  headers?: Record<string, string>
}
const emails: SentEmail[] = []
type FetchCall = { url: string; init: RequestInit; body: string }
const requests: FetchCall[] = []
/** Per-URL responder for the stubbed fetch. */
let respond: (url: string, body: string) => Response = () => new Response('ok')

/** Jobs captured by the inline sink; `drain()` runs them like the worker would. */
const jobs: (SubscriberJob & { attemptsMade: number })[] = []

async function drain({ retries = true } = {}) {
  const results: { name: string; error?: unknown }[] = []
  for (let guard = 0; jobs.length > 0 && guard < 500; guard++) {
    const job = jobs.shift()!
    try {
      await processSubscriberJob(payload, {
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        opts: job.opts,
      })
      results.push({ name: job.name })
    } catch (error) {
      results.push({ name: job.name, error })
      const max = job.opts.attempts ?? 1
      if (retries && !(error instanceof UnrecoverableError) && job.attemptsMade + 1 < max) {
        jobs.push({ ...job, attemptsMade: job.attemptsMade + 1 })
      }
    }
  }
  return results
}

const emailsTo = (to: string) => emails.filter((e) => e.to === to)

/** Token of the newest link of `kind` in the last email to `to`. */
function linkToken(to: string, kind: 'confirm' | 'manage' | 'unsubscribe'): string {
  const mail = emailsTo(to).at(-1)
  const match = mail?.text.match(new RegExp(`/${kind}/([^\\s/]+)`))
  if (!match) throw new Error(`no ${kind} link for ${to}`)
  return decodeURIComponent(match[1])
}

async function subscriberOf(target: string): Promise<StatusPageSubscriber | undefined> {
  const { docs } = await payload.find({
    collection: 'status-page-subscribers',
    where: { and: [{ statusPage: { equals: page.id } }, { target: { equals: target } }] },
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })
  return docs[0] as StatusPageSubscriber | undefined
}

async function setSubscriptions(data: Partial<NonNullable<StatusPage['subscriptions']>>) {
  page = (await payload.update({
    collection: 'status-pages',
    id: page.id,
    data: { subscriptions: { ...page.subscriptions, ...data } },
    depth: 0,
  })) as StatusPage
}

async function openIncident(
  title: string,
  components: { component: string; impact: 'major_outage' | 'partial_outage' }[],
): Promise<Incident> {
  return (await payload.create({
    collection: 'incidents',
    data: {
      statusPage: page.id,
      organization: org.id,
      title,
      updates: [{ status: 'investigating', message: `${title} details`, components }],
    } as never,
    depth: 0,
  })) as Incident
}

async function batchesFor(incident: Incident): Promise<SubscriberNotification[]> {
  const { docs } = await payload.find({
    collection: 'subscriber-notifications',
    where: { incident: { equals: incident.id } },
    sort: 'createdAt',
    depth: 0,
  })
  return docs as SubscriberNotification[]
}

async function addOwnerSubscriber(body: Record<string, unknown>) {
  const res = await call(addSubscriberRoute, pageParams(), json(body, auth(ownerToken)))
  const payloadJson = (await res.json()) as { doc: StatusPageSubscriber & { secret?: string } }
  expect(res.status, JSON.stringify(payloadJson)).toBe(201)
  return payloadJson.doc
}

describe('status page subscribers', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    resetInstanceSettingsCache()
    setSubscriberJobSink(async (batch) => {
      for (const job of batch) {
        if (!jobs.some((j) => j.opts.jobId === job.opts.jobId))
          jobs.push({ ...job, attemptsMade: 0 })
      }
    })
    vi.spyOn(payload, 'sendEmail').mockImplementation(async (message: unknown) => {
      emails.push(message as SentEmail)
      return undefined as never
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input)
        const body = typeof init.body === 'string' ? init.body : String(init.body ?? '')
        requests.push({ url, init, body })
        return respond(url, body)
      }),
    )

    owner = await payload.create({
      collection: 'users',
      data: { email: email('owner'), password: PASSWORD, name: 'Owner' },
    })
    member = await payload.create({
      collection: 'users',
      data: { email: email('member'), password: PASSWORD, name: 'Member' },
    })
    viewer = await payload.create({
      collection: 'users',
      data: { email: email('viewer'), password: PASSWORD, name: 'Viewer' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Sub Acme', slug: `sub-acme-${run}` },
      user: { ...owner, collection: 'users' },
      overrideAccess: false,
    })
    for (const [user, role] of [
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      await payload.update({
        collection: 'users',
        id: user.id,
        data: { organizations: [{ organization: org.id, role }] },
      })
    }
    apiMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'API', organization: org.id },
    })
    webMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Website', organization: org.id },
    })
    twilio = (await payload.create({
      collection: 'notifications',
      data: {
        organization: org.id,
        name: 'Twilio',
        type: 'twilio',
        config: {
          accountSid: 'AC123',
          authToken: 'twilio-auth-token',
          fromNumber: '+15005550006',
          toNumber: '+15005550007',
        },
      },
    })) as Notification
    page = (await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Sub Status',
        slug: `sub-${run}`,
        published: true,
        groups: [
          {
            name: 'Core',
            monitors: [{ monitor: apiMonitor.id }, { monitor: webMonitor.id }],
          },
        ],
        subscriptions: {
          enabled: true,
          channels: ['email', 'sms', 'webhook', 'slack'],
          deliveryMode: 'review',
          smsChannel: twilio.id,
        },
      },
      depth: 0,
    })) as StatusPage
    apiC = String(page.groups?.[0]?.monitors?.[0]?.id)
    webC = String(page.groups?.[0]?.monitors?.[1]?.id)

    const login = async (user: User) =>
      (
        await payload.login({
          collection: 'users',
          data: { email: user.email, password: PASSWORD },
        })
      ).token as string
    ownerToken = await login(owner)
    memberToken = await login(member)
    viewerToken = await login(viewer)
  })

  afterEach(() => {
    respond = () => new Response('ok')
  })

  afterAll(async () => {
    setSubscriberJobSink(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (org?.id) {
      await payload.delete({
        collection: 'maintenance',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'incidents', where: { organization: { equals: org.id } } })
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
      await payload.delete({
        collection: 'notifications',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'organizations', id: org.id })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+sub-${run}@` } } })
    await payload.updateGlobal({ slug: 'instance-settings', data: { trustProxy: false } })
    resetInstanceSettingsCache()
    await closeRateLimitStore()
  })

  const subscribe = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    call(subscribeRoute, { slug: page.slug }, json(body, headers))

  it('subscribes by email with double opt-in, receives the next update and unsubscribes in one click', async () => {
    const address = email('visitor')
    const res = await subscribe({ channel: 'email', target: address.toUpperCase() })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, next: 'confirm-email' })

    const pending = await subscriberOf(address)
    expect(pending).toMatchObject({ channel: 'email', source: 'self_signup', confirmedAt: null })
    expect(emailsTo(address)).toHaveLength(1)
    expect(emailsTo(address)[0].subject).toContain('Confirm your subscription to Sub Status')

    // Unconfirmed subscribers receive nothing.
    const early = await openIncident('Early', [])
    expect(await batchesFor(early)).toHaveLength(0)

    // The link leads to a page; the page's button posts here.
    const token = linkToken(address, 'confirm')
    const confirmed = await call(
      confirmRoute,
      { slug: page.slug, token },
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    )
    expect(confirmed.status).toBe(303)
    expect(confirmed.headers.get('location')).toBe(
      `/status/${page.slug}/manage/${token}?confirmed=1`,
    )
    expect((await subscriberOf(address))?.confirmedAt).toBeTruthy()

    // A second sign-up answers the same and sends a "manage" email instead of a confirmation.
    const again = await subscribe({ channel: 'email', target: address })
    expect(await again.json()).toEqual({ ok: true, next: 'confirm-email' })
    expect(emailsTo(address).at(-1)?.subject).toContain('Your subscription to Sub Status')

    // Review mode: the update waits for an admin.
    const incident = await openIncident('API errors', [{ component: apiC, impact: 'major_outage' }])
    const [batch] = await batchesFor(incident)
    expect(batch).toMatchObject({ state: 'pending_review', event: 'incident_opened' })
    expect(jobs).toHaveLength(0)

    const detail = await call(
      getNotificationRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      {
        headers: auth(ownerToken),
      },
    )
    const detailJson = (await detail.json()) as {
      preview: {
        email: { subject: string; html: string }
        sms: string
        recipients: Record<string, number>
      }
    }
    expect(detail.status).toBe(200)
    expect(detailJson.preview.email.subject).toBe('[Sub Status] New incident: API errors')
    expect(detailJson.preview.email.html).toContain('Affected: API')
    expect(detailJson.preview.sms).toContain('New incident: API errors')
    expect(detailJson.preview.recipients.email).toBeGreaterThanOrEqual(1)

    const before = emailsTo(address).length
    // Members manage subscribers but may not send.
    const forbidden = await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      json({ action: 'send' }, auth(memberToken)),
    )
    expect(forbidden.status).toBe(403)
    const sent = await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      json({ action: 'send' }, auth(ownerToken)),
    )
    expect(sent.status).toBe(200)
    await drain()
    const mail = emailsTo(address).at(-1)!
    expect(emailsTo(address)).toHaveLength(before + 1)
    expect(mail.subject).toBe('[Sub Status] New incident: API errors')
    expect(mail.text).toContain('API errors details')
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(mail.headers?.['List-Unsubscribe']).toMatch(
      new RegExp(
        `^<http://localhost:3000/api/status-pages/${page.slug}/subscriptions/.+/unsubscribe>$`,
      ),
    )
    const done = await payload.findByID({ collection: 'subscriber-notifications', id: batch.id })
    expect(done.state).toBe('sent')
    const deliveries = await payload.find({
      collection: 'subscriber-deliveries',
      where: { notification: { equals: batch.id } },
    })
    expect(deliveries.docs.every((d) => d.state === 'sent')).toBe(true)

    // A sent notification cannot be sent twice.
    const twice = await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      json({ action: 'send' }, auth(ownerToken)),
    )
    expect(twice.status).toBe(409)

    // RFC 8058 one-click unsubscribe.
    const oneClick = mail.headers!['List-Unsubscribe'].slice(1, -1)
    const unsubscribeToken = decodeURIComponent(oneClick.split('/subscriptions/')[1].split('/')[0])
    const removed = await call(
      unsubscribeRoute,
      { slug: page.slug, token: unsubscribeToken },
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      },
    )
    expect(removed.status).toBe(200)
    expect(await subscriberOf(address)).toBeUndefined()
  })

  it('never reveals whether an address is subscribed and refuses forged links', async () => {
    const res = await subscribe({ channel: 'email', target: 'nobody-yet@example.org' })
    expect(await res.json()).toEqual({ ok: true, next: 'confirm-email' })
    expect((await subscribe({ channel: 'email', target: 'not an email' })).status).toBe(400)
    expect(
      (await subscribe({ channel: 'email', target: 'x@example.org', components: ['nope'] })).status,
    ).toBe(400)

    const subscriber = await subscriberOf('nobody-yet@example.org')
    const token = subscriberLinkToken(subscriber!)
    const forged = `${token.slice(0, -2)}xx`
    const lookup = await call(subscriptionRoute, { slug: page.slug, token: forged })
    expect(lookup.status).toBe(404)
    // Another subscriber's id with this signature does not work either.
    const otherId = await call(subscriptionRoute, {
      slug: page.slug,
      token: `${String(subscriber!.id)}9.${token.split('.')[1]}`,
    })
    expect(otherId.status).toBe(404)
  })

  it('delivers only announcements about the components a subscriber chose', async () => {
    const a = await addOwnerSubscriber({
      channel: 'email',
      target: email('only-api'),
      components: [apiC],
    })
    const b = await addOwnerSubscriber({
      channel: 'email',
      target: email('only-web'),
      components: [webC],
    })
    expect(a.confirmedAt).toBeTruthy()
    expect(a.source).toBe('added_by_owner')

    await setSubscriptions({ deliveryMode: 'auto' })
    try {
      const incident = await openIncident('Website down', [
        { component: webC, impact: 'major_outage' },
      ])
      const [batch] = await batchesFor(incident)
      expect(batch.state).toBe('sending')
      await drain()
      expect(emailsTo(b.target).some((m) => m.subject.includes('Website down'))).toBe(true)
      expect(emailsTo(a.target).some((m) => m.subject.includes('Website down'))).toBe(false)

      // The manage link changes the choice.
      const token = subscriberLinkToken((await subscriberOf(a.target))!)
      const patched = await call(
        patchSubscriptionRoute,
        { slug: page.slug, token },
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ components: [apiC, webC] }),
        },
      )
      expect(patched.status).toBe(200)
      expect(((await patched.json()) as { components: string[] }).components).toEqual([apiC, webC])
    } finally {
      await setSubscriptions({ deliveryMode: 'review' })
    }
  })

  it('signs webhook deliveries and retries server errors with backoff', async () => {
    const url = `https://hooks.example.com/marmot-${run}`
    const doc = await addOwnerSubscriber({
      channel: 'webhook',
      target: url,
      headers: [{ name: 'Authorization', value: 'Bearer receiver' }],
    })
    expect(doc.secret).toMatch(/^whsec_/)
    // The welcome message proves the URL works and carries the links and the secret.
    const welcome = requests.filter((r) => r.url === url).at(-1)!
    const welcomeBody = JSON.parse(welcome.body)
    expect(welcomeBody).toMatchObject({ version: '1', type: 'test', event: 'subscription_created' })
    expect(welcomeBody.data.signing_secret).toBe(doc.secret)
    expect(welcomeBody.subscription.manage_url).toContain(`/status/${page.slug}/manage/`)

    // Viewers do not see subscribers at all.
    const asViewer = await call(listSubscribersRoute, pageParams(), { headers: auth(viewerToken) })
    expect(asViewer.status).toBe(403)

    let calls = 0
    respond = (target) => {
      if (target !== url) return new Response('ok')
      calls += 1
      return calls === 1 ? new Response('busy', { status: 503 }) : new Response('ok')
    }
    const incident = await openIncident('Webhook test', [])
    const [batch] = await batchesFor(incident)
    await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      json({ action: 'send' }, auth(ownerToken)),
    )
    await drain()
    expect(calls).toBe(2)
    const delivered = requests.filter((r) => r.url === url).at(-1)!
    const headers = delivered.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer receiver')
    expect(headers['X-Marmot-Event']).toBe('incident_opened')
    expect(verifyWebhookSignature(doc.secret!, delivered.body, headers['X-Marmot-Signature'])).toBe(
      true,
    )
    const body = JSON.parse(delivered.body)
    expect(body).toMatchObject({
      version: '1',
      type: 'incident',
      event: 'incident_opened',
      data: { incident: { title: 'Webhook test', status: 'investigating' } },
    })
    expect(body.subscription.unsubscribe_url).toContain('/unsubscribe/')
    expect(body.url).toMatch(new RegExp(`/status/${page.slug}/events/incident/[0-9a-z]{8}$`))
    expect(body.page.url).toBe(`http://localhost:3000/status/${page.slug}`)
    const [delivery] = (
      await payload.find({
        collection: 'subscriber-deliveries',
        where: {
          and: [{ notification: { equals: batch.id } }, { subscriber: { equals: doc.id } }],
        },
      })
    ).docs
    expect(delivery).toMatchObject({ state: 'sent', attempts: 2 })

    // A 4xx response is not retried; the batch reports the failure and can be retried.
    calls = 0
    respond = (target) => {
      if (target !== url) return new Response('ok')
      calls += 1
      return new Response('gone', { status: 410 })
    }
    const second = await openIncident('Webhook gone', [])
    const [secondBatch] = await batchesFor(second)
    await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(secondBatch.id) },
      json({ action: 'send' }, auth(ownerToken)),
    )
    await drain()
    expect(calls).toBe(1)
    const failed = await payload.findByID({
      collection: 'subscriber-notifications',
      id: secondBatch.id,
    })
    expect(failed.state).toBe('partially_failed')
    respond = () => new Response('ok')
    const retried = await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(secondBatch.id) },
      json({ action: 'retry' }, auth(ownerToken)),
    )
    expect(retried.status).toBe(200)
    await drain()
    expect(
      (await payload.findByID({ collection: 'subscriber-notifications', id: secondBatch.id }))
        .state,
    ).toBe('sent')
  })

  it('sends Slack incoming-webhook messages', async () => {
    const url = `https://hooks.slack.com/services/T0/B0/${run}`
    await addOwnerSubscriber({ channel: 'slack', target: url })
    const incident = await openIncident('Slack test', [])
    const [batch] = await batchesFor(incident)
    await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      json({ action: 'send' }, auth(ownerToken)),
    )
    await drain()
    const message = JSON.parse(requests.filter((r) => r.url === url).at(-1)!.body)
    expect(message.text).toBe('[Sub Status] New incident: Slack test')
    expect(JSON.stringify(message.blocks)).toContain('Unsubscribe')
    expect(
      (requests.filter((r) => r.url === url).at(-1)!.init.headers as Record<string, string>)[
        'X-Marmot-Signature'
      ],
    ).toBeUndefined()
  })

  it('verifies SMS subscribers with a code and sends the templated SMS', async () => {
    const phone = `+1555${String(Date.now()).slice(-7)}`
    const twilioBodies = () =>
      requests
        .filter((r) => r.url.includes('api.twilio.com'))
        .map((r) => new URLSearchParams(r.body))
        .filter((p) => p.get('To') === phone)

    const res = await subscribe({ channel: 'sms', target: phone })
    expect(await res.json()).toEqual({ ok: true, next: 'enter-code' })
    const codeSms = twilioBodies().at(-1)!
    expect(codeSms.get('From')).toBe('+15005550006')
    const code = codeSms.get('Body')!.match(/^(\d{6}) /)![1]

    const wrong = await call(
      verifyRoute,
      { slug: page.slug },
      json({ target: phone, code: code === '000000' ? '111111' : '000000' }),
    )
    expect(wrong.status).toBe(400)
    const ok = await call(verifyRoute, { slug: page.slug }, json({ target: phone, code }))
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { manageUrl: string }).manageUrl).toContain('/manage/')
    // A code works once.
    expect(
      (await call(verifyRoute, { slug: page.slug }, json({ target: phone, code }))).status,
    ).toBe(400)

    await setSubscriptions({
      smsTemplates: { incidentOpened: '{{ siteName }} ALERT {{ title }} ({{ status }}) {{ url }}' },
    })
    const incident = await openIncident('SMS test', [])
    const [batch] = await batchesFor(incident)
    await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      json({ action: 'send' }, auth(ownerToken)),
    )
    await drain()
    // The URL is the incident's permalink (#107).
    expect(twilioBodies().at(-1)!.get('Body')).toMatch(
      new RegExp(
        `^Sub Status ALERT SMS test \\(Investigating\\) http://localhost:3000/status/${page.slug}/events/incident/[0-9a-z]{8}$`,
      ),
    )

    // STOP through Twilio's inbound webhook ends the subscription.
    const params = { From: phone, Body: 'stop', To: '+15005550006' }
    const inboundUrl = `http://localhost:3000/api/status-pages/${page.slug}/sms-inbound`
    const unsigned = await call(
      smsInboundRoute,
      { slug: page.slug },
      {
        url: inboundUrl,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      },
    )
    expect(unsigned.status).toBe(403)
    const signed = await call(
      smsInboundRoute,
      { slug: page.slug },
      {
        url: inboundUrl,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilioSignature('twilio-auth-token', inboundUrl, params),
        },
        body: new URLSearchParams(params).toString(),
      },
    )
    expect(signed.status).toBe(200)
    expect(await subscriberOf(phone)).toBeUndefined()
  })

  it('removes SMS subscribers the provider reports as unsubscribed (STOP)', async () => {
    const phone = `+1666${String(Date.now()).slice(-7)}`
    await addOwnerSubscriber({ channel: 'sms', target: phone })
    respond = (url, body) =>
      url.includes('api.twilio.com') && body.includes(encodeURIComponent(phone))
        ? new Response('{"code": 21610, "message": "Attempt to send to unsubscribed recipient"}', {
            status: 400,
          })
        : new Response('ok')
    const incident = await openIncident('STOP test', [])
    const [batch] = await batchesFor(incident)
    await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(batch.id) },
      json({ action: 'send' }, auth(ownerToken)),
    )
    await drain()
    expect(await subscriberOf(phone)).toBeUndefined()
  })

  it('announces maintenance and lets an admin discard a draft', async () => {
    const maintenance = await payload.create({
      collection: 'maintenance',
      data: {
        organization: org.id,
        title: 'Database upgrade',
        description: 'Short downtime.',
        strategy: 'manual',
        active: true,
        monitors: [apiMonitor.id],
        statusPages: [page.id],
      } as never,
      depth: 0,
    })
    const occurrence = await payload.create({
      collection: 'maintenance-occurrences',
      data: {
        organization: org.id,
        maintenance: maintenance.id,
        start: '2030-01-01T10:00:00.000Z',
        end: '2030-01-01T11:00:00.000Z',
        state: 'scheduled',
      } as never,
      depth: 0,
    })
    const event: MaintenanceEvent = {
      type: 'scheduled',
      organizationId: String(org.id),
      maintenance: {
        id: String(maintenance.id),
        title: 'Database upgrade',
        description: 'Short downtime.',
        strategy: 'manual',
        statusPages: [String(page.id)],
        monitors: [String(apiMonitor.id)],
      },
      occurrence: {
        id: String(occurrence.id),
        maintenanceId: String(maintenance.id),
        publicId: occurrence.publicId!,
        state: 'scheduled',
        start: '2030-01-01T10:00:00.000Z',
        end: '2030-01-01T11:00:00.000Z',
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        remindersSent: [],
        updates: [],
      },
      update: null,
      reminderMinutes: null,
      at: new Date().toISOString(),
    }
    // Run twice: the dedupe key keeps one notification.
    await announceMaintenanceEvent(payload, event)
    await announceMaintenanceEvent(payload, event)
    const { docs } = await payload.find({
      collection: 'subscriber-notifications',
      where: { occurrence: { equals: occurrence.id } },
    })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      event: 'maintenance_scheduled',
      state: 'pending_review',
      title: 'Database upgrade',
      components: [apiC],
      message: 'Short downtime.',
      eventPublicId: occurrence.publicId,
    })

    const list = await call(listNotificationsRoute, pageParams(), { headers: auth(memberToken) })
    expect(
      ((await list.json()) as { docs: { id: unknown }[] }).docs.some(
        (d) => String(d.id) === String(docs[0].id),
      ),
    ).toBe(true)

    const discarded = await call(
      notificationActionRoute,
      { ...pageParams(), notificationId: String(docs[0].id) },
      json({ action: 'discard' }, auth(ownerToken)),
    )
    expect(discarded.status).toBe(200)
    expect(jobs).toHaveLength(0)
    expect(
      (await payload.findByID({ collection: 'subscriber-notifications', id: docs[0].id })).state,
    ).toBe('discarded')
    await payload.delete({ collection: 'subscriber-notifications', id: docs[0].id })
    await payload.delete({ collection: 'maintenance', id: maintenance.id })
  })

  it('exports and imports subscribers as CSV', async () => {
    const csv = [
      'channel,target,components',
      `email,${email('imported')},${apiC}`,
      'email,broken-address,',
      `sms,+15550001111,`,
    ].join('\n')
    const res = await call(importRoute, pageParams(), {
      method: 'POST',
      headers: { 'content-type': 'text/csv', ...auth(ownerToken) },
      body: csv,
    })
    const report = (await res.json()) as { created: number; skipped: { line: number }[] }
    expect(res.status).toBe(200)
    expect(report.created).toBe(2)
    expect(report.skipped.map((s) => s.line)).toEqual([3])
    expect(await subscriberOf(email('imported'))).toMatchObject({
      source: 'import',
      components: [apiC],
    })

    const exported = await call(exportRoute, pageParams(), { headers: auth(memberToken) })
    expect(exported.headers.get('content-type')).toContain('text/csv')
    expect(await exported.text()).toContain(`email,${email('imported')},${apiC},import,`)
    expect((await call(exportRoute, pageParams(), { headers: auth(viewerToken) })).status).toBe(403)

    // The organization export carries the page's subscription settings (not the subscribers).
    const file = await buildMarmotExport(payload, {
      orgId: org.id,
      user: {
        ...(await payload.findByID({ collection: 'users', id: owner.id, depth: 0 })),
        collection: 'users',
      },
    })
    const exportedPage = file.statusPages.find((p) => p.slug === page.slug)!
    expect(exportedPage.subscriptions).toMatchObject({
      enabled: true,
      deliveryMode: 'review',
      smsChannel: twilio.id,
    })
    expect(JSON.stringify(file)).not.toContain(email('imported'))
    const plan = parseMarmotExport(file)
    expect(plan.statusPages.find((p) => p.data.title === page.title)?.subscriptions).toMatchObject({
      enabled: true,
      smsChannelKey: String(twilio.id),
    })
  })

  it('works with password-protected pages: sign-up needs access, links carry the token', async () => {
    const address = email('protected')
    await addOwnerSubscriber({ channel: 'email', target: address })
    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { access: 'password', password: 'correct horse battery' },
    })
    try {
      const denied = await subscribe({ channel: 'email', target: email('stranger') })
      expect(denied.status).toBe(401)

      const login = await call(
        accessRoute,
        { slug: page.slug },
        json({ password: 'correct horse battery' }),
      )
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
      const allowed = await subscribe({ channel: 'email', target: email('insider') }, { cookie })
      expect(allowed.status).toBe(202)

      const token = subscriberLinkToken((await subscriberOf(address))!)
      const viaLink = await call(subscriptionRoute, { slug: page.slug, token })
      expect(viaLink.status).toBe(200)
      expect(await viaLink.json()).toMatchObject({
        channel: 'email',
        target: address,
        confirmed: true,
      })
    } finally {
      await payload.update({ collection: 'status-pages', id: page.id, data: { access: 'public' } })
    }
  })

  it('rate limits sign-ups per trusted client IP', async () => {
    await payload.updateGlobal({ slug: 'instance-settings', data: { trustProxy: true } })
    resetInstanceSettingsCache()
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`
    const headers = { 'x-forwarded-for': ip }
    const statuses: number[] = []
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT.points; i++) {
      statuses.push(
        (await subscribe({ channel: 'email', target: email(`rl${i}`) }, headers)).status,
      )
    }
    expect(statuses.every((s) => s === 202)).toBe(true)
    const last = await subscribe({ channel: 'email', target: email('rl-last') }, headers)
    expect(last.status).toBe(429)
    expect(last.headers.get('retry-after')).toBeTruthy()
    // Another client is not affected; a spoofed header only counts with trustProxy on.
    const other = await subscribe(
      { channel: 'email', target: email('rl-other') },
      {
        'x-forwarded-for': '198.51.100.7',
      },
    )
    expect(other.status).toBe(202)
    await payload.updateGlobal({ slug: 'instance-settings', data: { trustProxy: false } })
    resetInstanceSettingsCache()
  })

  it('offers only enabled channels and removes everything with the page', async () => {
    await setSubscriptions({ channels: ['email'] })
    expect((await subscribe({ channel: 'webhook', target: 'https://example.com/x' })).status).toBe(
      404,
    )
    await setSubscriptions({ enabled: false })
    expect((await subscribe({ channel: 'email', target: email('off') })).status).toBe(404)

    // Deleting the page takes subscribers, notifications and deliveries with it (Postgres FKs).
    const before = await payload.count({
      collection: 'status-page-subscribers',
      where: { statusPage: { equals: page.id } },
    })
    expect(before.totalDocs).toBeGreaterThan(0)
    await payload.delete({ collection: 'incidents', where: { statusPage: { equals: page.id } } })
    await payload.delete({ collection: 'status-pages', id: page.id })
    for (const collection of ['status-page-subscribers', 'subscriber-notifications'] as const) {
      const after = await payload.count({ collection, where: { statusPage: { equals: page.id } } })
      expect(after.totalDocs).toBe(0)
    }
  })
})
