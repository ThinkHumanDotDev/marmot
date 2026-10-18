import { UnrecoverableError } from 'bullmq'
import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { GET as installRoute } from '@/app/api/orgs/[orgId]/slack/install/route'
import { DELETE as unlinkRoute } from '@/app/api/orgs/[orgId]/slack/links/[linkId]/route'
import { DELETE as uninstallRoute, GET as settingsRoute } from '@/app/api/orgs/[orgId]/slack/route'
import { POST as commandsRoute } from '@/app/api/slack/commands/route'
import { POST as eventsRoute } from '@/app/api/slack/events/route'
import { POST as interactionsRoute } from '@/app/api/slack/interactions/route'
import { POST as linkRoute } from '@/app/api/slack/link/route'
import { GET as callbackRoute } from '@/app/api/slack/oauth/callback/route'
import { resetEnvCache } from '@/env'
import type {
  Monitor,
  MonitorIncident,
  Organization,
  SlackInstallation,
  StatusPage,
  StatusPageSubscriber,
  User,
} from '@/payload-types'
import { setOnDemandTransport, type OnDemandTransport } from '@/server/engine/on-demand'
import { openIncident } from '@/server/incidents/store'
import { getProviderDescriptors } from '@/server/notifications/api'
import { sendNotification } from '@/server/notifications/send'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { settleSlackTasks } from '@/server/slack/http'
import { slackSignature } from '@/server/slack/signature'
import { openBotToken, SLACK_STATE_COOKIE } from '@/server/slack/tokens'
import {
  processSubscriberJob,
  setSubscriberJobSink,
  type SubscriberJob,
} from '@/server/status-pages/subscribers'

/**
 * Slack app (#129): disabled without its variables, signature verification, OAuth install per
 * organization, account linking, `/marmot` subcommands (subscribe → the next incident update is
 * posted to the channel), the alert buttons, the incident modal and uninstalling. Slack is mocked
 * through `globalThis.fetch`.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+slack-${run}@marmot.test`
const PASSWORD = 'password-123'
const SECRET = 'slack-signing-secret-for-tests'
const TEAM = `T${run.toUpperCase()}`
const CHANNEL = 'C0ALERTS'
const BOT_TOKEN = `xoxb-${run}-secret`
const SERVER = 'http://localhost:3000'

const SLACK_ENV = {
  SLACK_CLIENT_ID: '123.456',
  SLACK_CLIENT_SECRET: 'client-secret',
  SLACK_SIGNING_SECRET: SECRET,
}
const savedEnv = Object.fromEntries(Object.keys(SLACK_ENV).map((key) => [key, process.env[key]]))

function setSlackEnv(on: boolean) {
  for (const [key, value] of Object.entries(SLACK_ENV)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  resetEnvCache()
}

// ---------------------------------------------------------------------------------------------
// Slack mock

type SlackCall = { url: string; method: string; body: Record<string, unknown>; auth: string | null }
const calls: SlackCall[] = []
const callsTo = (method: string) => calls.filter((c) => c.method === method)

function slackResponse(url: string): Response {
  if (url.endsWith('/oauth.v2.access')) {
    return Response.json({
      ok: true,
      access_token: BOT_TOKEN,
      token_type: 'bot',
      scope: 'commands,chat:write,chat:write.public',
      bot_user_id: 'UBOT',
      app_id: 'A0MARMOT',
      team: { id: TEAM, name: 'Acme Workspace' },
      authed_user: { id: 'UOWNER' },
    })
  }
  if (url.includes('/chat.postMessage')) return Response.json({ ok: true, ts: '1.2' })
  return Response.json({ ok: true })
}

const parseBody = (init: RequestInit): Record<string, unknown> => {
  const raw = typeof init.body === 'string' ? init.body : ''
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

// ---------------------------------------------------------------------------------------------
// Requests

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  params: Record<string, string>,
  url: string,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) })

/** A request signed like Slack signs it (`secret` and `timestamp` overridable to forge one). */
function signed(
  url: string,
  body: string,
  {
    secret = SECRET,
    timestamp = Math.floor(Date.now() / 1000),
    contentType = 'application/x-www-form-urlencoded',
  } = {},
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': slackSignature(secret, timestamp, body),
    },
    body,
  })
}

const commandBody = (user: string, text: string, channel = CHANNEL) =>
  new URLSearchParams({
    team_id: TEAM,
    channel_id: channel,
    user_id: user,
    command: '/marmot',
    text,
    trigger_id: `trigger-${user}`,
    response_url: 'https://hooks.slack.com/commands/T/1/abc',
  }).toString()

async function slash(user: string, text: string, channel = CHANNEL) {
  const res = await commandsRoute(
    signed(`${SERVER}/api/slack/commands`, commandBody(user, text, channel)),
  )
  const raw = await res.text()
  return {
    status: res.status,
    body: (raw ? JSON.parse(raw) : {}) as {
      response_type?: string
      text?: string
      blocks?: unknown[]
    },
  }
}

async function interact(body: Record<string, unknown>) {
  const form = new URLSearchParams({ payload: JSON.stringify(body) }).toString()
  const res = await interactionsRoute(signed(`${SERVER}/api/slack/interactions`, form))
  const raw = await res.text()
  return {
    status: res.status,
    body: (raw ? JSON.parse(raw) : null) as Record<string, unknown> | null,
  }
}

const RESPONSE_URL = 'https://hooks.slack.com/actions/T/1/xyz'
const button = (user: string, actionId: string, value: string) => ({
  type: 'block_actions',
  user: { id: user, team_id: TEAM },
  team: { id: TEAM },
  channel: { id: CHANNEL },
  response_url: RESPONSE_URL,
  actions: [{ action_id: actionId, value }],
})
const responses = () => calls.filter((c) => c.url === RESPONSE_URL).map((c) => c.body)

// ---------------------------------------------------------------------------------------------
// Fixtures

let owner: User
let member: User
let viewer: User
let other: User
let org: Organization
let otherOrg: Organization
let monitor: Monitor
let page: StatusPage
let tokens: Record<'owner' | 'member' | 'viewer' | 'other', string>
const auth = (token: string) => ({ authorization: `JWT ${token}` })

const jobs: (SubscriberJob & { attemptsMade: number })[] = []
async function drain() {
  for (let guard = 0; jobs.length > 0 && guard < 200; guard++) {
    const job = jobs.shift()!
    try {
      await processSubscriberJob(payload, {
        name: job.name,
        data: job.data,
        attemptsMade: job.attemptsMade,
        opts: job.opts,
      })
    } catch (error) {
      if (
        !(error instanceof UnrecoverableError) &&
        job.attemptsMade + 1 < (job.opts.attempts ?? 1)
      ) {
        jobs.push({ ...job, attemptsMade: job.attemptsMade + 1 })
      }
    }
  }
}

async function installation(): Promise<SlackInstallation | null> {
  const { docs } = await payload.find({
    collection: 'slack-installations',
    where: { teamId: { equals: TEAM } },
    overrideAccess: true,
    showHiddenFields: true,
    depth: 0,
  })
  return (docs[0] as SlackInstallation | undefined) ?? null
}

async function appSubscribers(): Promise<StatusPageSubscriber[]> {
  const { docs } = await payload.find({
    collection: 'status-page-subscribers',
    where: { statusPage: { equals: page.id } },
    overrideAccess: true,
    depth: 0,
  })
  return docs as StatusPageSubscriber[]
}

/** "Add to Slack" as `token` for `orgId`, through Slack's redirect back. */
async function install(token: string, orgId: string | number) {
  const start = await call(
    installRoute,
    { orgId: String(orgId) },
    `${SERVER}/api/orgs/${orgId}/slack/install`,
    {
      headers: auth(token),
    },
  )
  if (start.status !== 302) return { start, callback: null }
  const location = new URL(start.headers.get('location')!)
  const nonce = /marmot-slack-state=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')![1]
  const callback = await callbackRoute(
    new Request(
      `${SERVER}/api/slack/oauth/callback?code=code-${run}&state=${encodeURIComponent(location.searchParams.get('state')!)}`,
      { headers: { ...auth(token), cookie: `${SLACK_STATE_COOKIE}=${nonce}` } },
    ),
  )
  return { start, location, callback }
}

/** `/marmot link` as `slackUser`, confirmed in the browser as `token`. */
async function link(slackUser: string, token: string) {
  const reply = await slash(slackUser, 'link')
  const url = JSON.stringify(reply.body.blocks).match(/\/slack\/link\/([^"\\]+)/)
  expect(url, JSON.stringify(reply.body)).toBeTruthy()
  return linkRoute(
    new Request(`${SERVER}/api/slack/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify({ token: url![1] }),
    }),
  )
}

describe('Slack app', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    setSubscriberJobSink(async (batch) => {
      for (const job of batch) {
        if (!jobs.some((j) => j.opts.jobId === job.opts.jobId))
          jobs.push({ ...job, attemptsMade: 0 })
      }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input)
        const headers = new Headers(init.headers)
        calls.push({
          url,
          method: url.replace(/^https:\/\/slack\.com\/api\//, ''),
          body: parseBody(init),
          auth: headers.get('authorization'),
        })
        return slackResponse(url)
      }),
    )

    const mkUser = (name: string) =>
      payload.create({
        collection: 'users',
        data: { email: email(name), password: PASSWORD, name },
      }) as Promise<User>
    owner = await mkUser('Owner')
    member = await mkUser('Member')
    viewer = await mkUser('Viewer')
    other = await mkUser('Other')
    org = (await payload.create({
      collection: 'organizations',
      data: { name: 'Slack Acme', slug: `slack-acme-${run}` },
      user: { ...owner, collection: 'users' },
      overrideAccess: false,
    })) as Organization
    otherOrg = (await payload.create({
      collection: 'organizations',
      data: { name: 'Slack Other', slug: `slack-other-${run}` },
      user: { ...other, collection: 'users' },
      overrideAccess: false,
    })) as Organization
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
    monitor = (await payload.create({
      collection: 'monitors',
      data: {
        type: 'http',
        url: 'https://api.example.com/health',
        name: 'Public API',
        organization: org.id,
        active: true,
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
      },
    })) as Monitor
    page = (await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Acme Status',
        slug: `slack-status-${run}`,
        published: true,
        groups: [{ name: 'Core', monitors: [{ monitor: monitor.id }] }],
        subscriptions: { enabled: true, channels: ['email', 'slack'], deliveryMode: 'auto' },
      },
      depth: 0,
    })) as StatusPage

    const login = async (user: User) =>
      (
        await payload.login({
          collection: 'users',
          data: { email: user.email, password: PASSWORD },
        })
      ).token as string
    tokens = {
      owner: await login(owner),
      member: await login(member),
      viewer: await login(viewer),
      other: await login(other),
    }
  })

  afterEach(async () => {
    await settleSlackTasks()
  })

  afterAll(async () => {
    setSubscriberJobSink(null)
    setOnDemandTransport(undefined)
    vi.unstubAllGlobals()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetEnvCache()
    for (const o of [org, otherOrg]) {
      if (!o?.id) continue
      await payload.delete({
        collection: 'monitor-incidents',
        where: { organization: { equals: o.id } },
      })
      await payload.delete({ collection: 'incidents', where: { organization: { equals: o.id } } })
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: o.id } },
      })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: o.id } } })
      await payload.delete({ collection: 'organizations', id: o.id })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+slack-${run}@` } } })
    await closeRateLimitStore()
  })

  describe('without SLACK_* variables', () => {
    beforeAll(() => setSlackEnv(false))

    it('is fully disabled', async () => {
      expect((await slash('UOWNER', 'help')).status).toBe(404)
      expect((await interact(button('UOWNER', 'marmot_ack', '1'))).status).toBe(404)
      const settings = await call(
        settingsRoute,
        { orgId: String(org.id) },
        `${SERVER}/api/orgs/${org.id}/slack`,
        {
          headers: auth(tokens.owner),
        },
      )
      expect(settings.status).toBe(404)
      const start = await call(
        installRoute,
        { orgId: String(org.id) },
        `${SERVER}/api/orgs/${org.id}/slack/install`,
        {
          headers: auth(tokens.owner),
        },
      )
      expect(start.status).toBe(404)
      expect(getProviderDescriptors().some((d) => d.name === 'slack-app')).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  describe('with the app configured', () => {
    beforeAll(() => setSlackEnv(true))

    it('rejects unsigned, forged, tampered and replayed requests', async () => {
      const body = commandBody('UOWNER', 'help')
      const url = `${SERVER}/api/slack/commands`
      const unsigned = await commandsRoute(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }),
      )
      expect(unsigned.status).toBe(401)
      expect((await commandsRoute(signed(url, body, { secret: 'not-the-secret' }))).status).toBe(
        401,
      )
      const tampered = signed(url, body)
      const forgedBody = await commandsRoute(
        new Request(url, {
          method: 'POST',
          headers: tampered.headers,
          body: body.replace('help', 'subscribe'),
        }),
      )
      expect(forgedBody.status).toBe(401)
      const old = Math.floor(Date.now() / 1000) - 10 * 60
      expect((await commandsRoute(signed(url, body, { timestamp: old }))).status).toBe(401)
      expect(
        (
          await interactionsRoute(
            signed(`${SERVER}/api/slack/interactions`, 'payload={}', { secret: 'x' }),
          )
        ).status,
      ).toBe(401)
      expect(
        (
          await eventsRoute(
            signed(`${SERVER}/api/slack/events`, '{}', {
              secret: 'x',
              contentType: 'application/json',
            }),
          )
        ).status,
      ).toBe(401)

      // Genuine: a workspace that has not installed the app is told so.
      const genuine = await slash('UOWNER', 'help')
      expect(genuine.status).toBe(200)
      expect(genuine.body.text).toContain('not connected')
    })

    it('installs per organization through OAuth and seals the bot token', async () => {
      // Members may not install; only admins (`integration:manage`).
      const denied = await install(tokens.member, org.id)
      expect(denied.start.status).toBe(403)

      const { start, location, callback } = await install(tokens.owner, org.id)
      expect(start.status).toBe(302)
      expect(location!.origin + location!.pathname).toBe('https://slack.com/oauth/v2/authorize')
      expect(location!.searchParams.get('scope')).toBe('commands,chat:write,chat:write.public')
      expect(start.headers.get('set-cookie')).toMatch(/HttpOnly/)
      expect(callback!.status).toBe(302)
      expect(callback!.headers.get('location')).toBe(
        `${SERVER}/${org.slug}/settings/integrations?slack=installed`,
      )
      const exchange = callsTo('oauth.v2.access').at(-1)!
      expect(exchange.body.code).toBe(`code-${run}`)
      expect(exchange.auth).toBe(`Basic ${Buffer.from('123.456:client-secret').toString('base64')}`)

      const doc = await installation()
      expect(doc?.teamName).toBe('Acme Workspace')
      expect(doc?.botToken).not.toContain(BOT_TOKEN)
      expect(openBotToken(doc?.botToken)).toBe(BOT_TOKEN)
      // Never readable through the API.
      const res = await call(
        settingsRoute,
        { orgId: String(org.id) },
        `${SERVER}/api/orgs/${org.id}/slack`,
        {
          headers: auth(tokens.member),
        },
      )
      const settings = (await res.json()) as {
        installation: { teamName: string; links: { slackUserId: string }[] }
      }
      expect(JSON.stringify(settings)).not.toContain(BOT_TOKEN)
      expect(settings.installation.teamName).toBe('Acme Workspace')
      // The Slack user who approved the install is linked to the installing member.
      expect(settings.installation.links.map((l) => l.slackUserId)).toEqual(['UOWNER'])
      const ownerNow = (await payload.findByID({ collection: 'users', id: owner.id })) as User
      const asApi = await payload.find({
        collection: 'slack-installations',
        user: { ...ownerNow, collection: 'users' },
        overrideAccess: false,
      })
      expect(asApi.docs).toHaveLength(1)
      expect(JSON.stringify(asApi.docs)).not.toContain('botToken')

      // A callback whose state does not match the browser's cookie is refused.
      const forged = await callbackRoute(
        new Request(
          `${SERVER}/api/slack/oauth/callback?code=x&state=${encodeURIComponent(location!.searchParams.get('state')!)}`,
          {
            headers: { ...auth(tokens.owner), cookie: `${SLACK_STATE_COOKIE}=other` },
          },
        ),
      )
      expect(forged.headers.get('location')).toContain('slack=invalid-state')

      // The workspace belongs to one organization.
      const taken = await install(tokens.other, otherOrg.id)
      expect(taken.callback!.headers.get('location')).toContain('slack=team-taken')
    })

    it('needs a linked account before anything changes', async () => {
      const subscribe = await slash('UNOBODY', `subscribe ${SERVER}/status/${page.slug}`)
      expect(subscribe.body.text).toContain('/marmot link')
      const incident = await slash('UNOBODY', 'incident create')
      expect(incident.body.text).toContain('/marmot link')
      expect(callsTo('views.open')).toHaveLength(0)
      expect(await appSubscribers()).toHaveLength(0)

      // Reading stays open: help, and a public status page.
      expect((await slash('UNOBODY', 'help')).body.text).toContain('/marmot subscribe')
      const status = await slash('UNOBODY', `status ${page.slug}`)
      expect(status.body.text).toContain('Acme Status')
      // The organization's monitors are not.
      expect((await slash('UNOBODY', 'status')).body.text).toContain('/marmot link')
    })

    it('links a Slack user to a member through a signed link', async () => {
      // Someone outside the installing organization cannot claim it.
      const outsider = await link('UMEMBER', tokens.other)
      expect(outsider.status).toBe(403)
      const linked = await link('UMEMBER', tokens.member)
      expect(linked.status).toBe(200)
      expect((await slash('UMEMBER', 'link')).body.text).toContain('Member')
      expect((await link('UVIEWER', tokens.viewer)).status).toBe(200)

      const bad = await linkRoute(
        new Request(`${SERVER}/api/slack/link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth(tokens.member) },
          body: JSON.stringify({ token: 'forged.token' }),
        }),
      )
      expect(bad.status).toBe(400)
    })

    it('subscribes a channel and delivers the next incident update to it', async () => {
      const before = callsTo('chat.postMessage').length
      const reply = await slash('UMEMBER', `subscribe <${SERVER}/status/${page.slug}|status page>`)
      expect(reply.body.response_type, JSON.stringify(reply.body)).toBe('in_channel')
      const [subscriber] = await appSubscribers()
      expect(subscriber).toMatchObject({ channel: 'slack', target: `slack://${TEAM}/${CHANNEL}` })
      expect(subscriber.confirmedAt).toBeTruthy()
      // The welcome message went out with the bot token.
      const welcome = callsTo('chat.postMessage').slice(before)
      expect(welcome).toHaveLength(1)
      expect(welcome[0].auth).toBe(`Bearer ${BOT_TOKEN}`)
      expect(welcome[0].body.channel).toBe(CHANNEL)

      expect(
        (await slash('UMEMBER', `subscribe ${SERVER}/status/${page.slug}`)).body.text,
      ).toContain('already subscribed')
      expect((await slash('UNOBODY', 'subscriptions')).body.text).toContain('Acme Status')

      // Visitors and owners cannot point a subscriber at a workspace channel themselves.
      await expect(
        payload.create({
          collection: 'status-page-subscribers',
          data: {
            statusPage: page.id,
            organization: org.id,
            channel: 'slack',
            target: `slack://${TEAM}/CEVIL`,
          },
          overrideAccess: true,
        }),
      ).rejects.toThrow()

      const posted = callsTo('chat.postMessage').length
      await payload.create({
        collection: 'incidents',
        data: {
          statusPage: page.id,
          organization: org.id,
          title: `Checkout errors ${run}`,
          updates: [
            { status: 'investigating', message: 'We are looking into it.', components: [] },
          ],
        } as never,
        depth: 0,
      })
      await drain()
      const delivered = callsTo('chat.postMessage').slice(posted)
      expect(delivered).toHaveLength(1)
      expect(delivered[0].body.channel).toBe(CHANNEL)
      expect(delivered[0].auth).toBe(`Bearer ${BOT_TOKEN}`)
      expect(JSON.stringify(delivered[0].body)).toContain(`Checkout errors ${run}`)
    })

    it('acknowledges from the alert button only for linked members with permission', async () => {
      const { incident } = await openIncident(payload, {
        monitor,
        cause: 'HTTP 503',
        startedAt: new Date(),
      })

      await interact(button('UNOBODY', 'marmot_ack', String(incident.id)))
      await interact(button('UVIEWER', 'marmot_ack', String(incident.id)))
      let current = (await payload.findByID({
        collection: 'monitor-incidents',
        id: incident.id,
      })) as MonitorIncident
      expect(current.status).toBe('open')
      expect(responses().at(-2)?.text).toContain('/marmot link')
      expect(responses().at(-1)?.text).toContain('not allowed')

      const ok = await interact(button('UMEMBER', 'marmot_ack', String(incident.id)))
      expect(ok.status).toBe(200)
      current = (await payload.findByID({
        collection: 'monitor-incidents',
        id: incident.id,
      })) as MonitorIncident
      expect(current.status).toBe('acknowledged')
      expect(current.acknowledgedVia).toBe('slack')
      expect(
        String(
          typeof current.acknowledgedBy === 'object'
            ? current.acknowledgedBy?.id
            : current.acknowledgedBy,
        ),
      ).toBe(String(member.id))
      expect(responses().at(-1)).toMatchObject({ response_type: 'in_channel' })
      expect(String(responses().at(-1)?.text)).toContain('<@UMEMBER>')
    })

    it('runs "Check now" for linked members and reports the result', async () => {
      const added: { name: string; data: Record<string, unknown> }[] = []
      const transport = {
        queue: {
          add: vi.fn(async (name: string, data: Record<string, unknown>) => {
            added.push({ name, data })
            return {
              id: 'job-1',
              waitUntilFinished: async () => ({
                status: 'up',
                ok: true,
                msg: '200 - OK',
                ping: 42,
              }),
            }
          }),
        },
        events: {},
      } as unknown as OnDemandTransport
      setOnDemandTransport(transport)

      await interact(button('UVIEWER', 'marmot_check_now', String(monitor.id)))
      expect(added).toHaveLength(0)
      expect(responses().at(-1)?.text).toContain('not allowed')

      await interact(button('UMEMBER', 'marmot_check_now', String(monitor.id)))
      expect(added).toEqual([
        {
          name: 'manual-check',
          data: expect.objectContaining({ monitorId: String(monitor.id), record: true }),
        },
      ])
      await settleSlackTasks()
      expect(String(responses().at(-1)?.text)).toContain('Up (42 ms)')
    })

    it('posts a status-page incident from the modal with the member’s permissions', async () => {
      const opened = await slash('UMEMBER', 'incident create')
      expect(opened.status).toBe(200)
      const view = callsTo('views.open').at(-1)!.body.view as {
        private_metadata: string
        blocks: { block_id: string; element: { options?: { value: string }[] } }[]
      }
      expect(
        view.blocks.find((b) => b.block_id === 'page')?.element.options?.map((o) => o.value),
      ).toEqual([String(page.id)])

      const submission = (user: string, title: string) => ({
        type: 'view_submission',
        user: { id: user, team_id: TEAM },
        team: { id: TEAM },
        view: {
          callback_id: 'marmot_incident',
          private_metadata: view.private_metadata,
          state: {
            values: {
              page: { value: { selected_option: { value: String(page.id) } } },
              title: { value: { value: title } },
              status: { value: { selected_option: { value: 'identified' } } },
              message: { value: { value: 'Payments provider is degraded.' } },
            },
          },
        },
      })
      // The viewer is linked but may not post incidents.
      const refused = await interact(submission('UVIEWER', 'Viewer incident'))
      expect(refused.body).toMatchObject({ response_action: 'errors' })
      const unlinked = await interact(submission('UNOBODY', 'Nobody incident'))
      expect(unlinked.body).toMatchObject({ response_action: 'errors' })

      const accepted = await interact(submission('UMEMBER', `Payments ${run}`))
      expect(accepted.body).toBeNull()
      const { docs } = await payload.find({
        collection: 'incidents',
        where: { statusPage: { equals: page.id } },
        depth: 0,
      })
      const titles = docs.map((d) => d.title)
      expect(titles).toContain(`Payments ${run}`)
      expect(titles).not.toContain('Viewer incident')
      expect(titles).not.toContain('Nobody incident')
    })

    it('offers the "Slack (app)" channel with Acknowledge and Check now buttons', async () => {
      expect(getProviderDescriptors().some((d) => d.name === 'slack-app')).toBe(true)
      const before = callsTo('chat.postMessage').length
      const { incident } = await openIncident(payload, {
        monitor: { ...monitor, id: monitor.id },
        cause: 'down',
        startedAt: new Date(),
      })
      await sendNotification(
        payload,
        { type: 'slack-app', config: { channel: '#alerts' }, organization: org.id },
        {
          message: '[Public API] [🔴 Down] HTTP 503',
          monitor,
          heartbeat: {
            id: 1,
            monitor: monitor.id,
            status: 'down',
            msg: 'HTTP 503',
            time: new Date().toISOString(),
          } as never,
          event: 'down',
          openIncidentId: incident.id,
        },
      )
      const [message] = callsTo('chat.postMessage').slice(before)
      expect(message.body.channel).toBe('#alerts')
      expect(message.auth).toBe(`Bearer ${BOT_TOKEN}`)
      const actions = JSON.stringify(message.body.blocks)
      expect(actions).toContain('"action_id":"marmot_ack"')
      expect(actions).toContain(`"value":"${incident.id}"`)
      expect(actions).toContain('"action_id":"marmot_check_now"')
    })

    it('unsubscribes, unlinks and uninstalls', async () => {
      expect((await slash('UNOBODY', 'unsubscribe')).body.text).toContain('/marmot link')
      expect(await appSubscribers()).toHaveLength(1)
      expect((await slash('UMEMBER', 'unsubscribe')).body.text).toContain('Unsubscribed')
      expect(await appSubscribers()).toHaveLength(0)
      // Re-subscribe so uninstalling has something to end.
      await slash('UMEMBER', `subscribe ${page.slug}`)
      expect(await appSubscribers()).toHaveLength(1)

      expect((await slash('UVIEWER', 'unlink')).body.text).toContain('no longer linked')
      const settings = (await (
        await call(settingsRoute, { orgId: String(org.id) }, `${SERVER}/api/orgs/${org.id}/slack`, {
          headers: auth(tokens.owner),
        })
      ).json()) as { installation: { links: { id: string; slackUserId: string }[] } }
      expect(settings.installation.links.map((l) => l.slackUserId).sort()).toEqual([
        'UMEMBER',
        'UOWNER',
      ])
      const memberLink = settings.installation.links.find((l) => l.slackUserId === 'UMEMBER')!
      const asMember = await call(
        unlinkRoute,
        { orgId: String(org.id), linkId: memberLink.id },
        `${SERVER}/api/orgs/${org.id}/slack/links/${memberLink.id}`,
        { method: 'DELETE', headers: auth(tokens.member) },
      )
      expect(asMember.status).toBe(403)

      const removed = await call(
        uninstallRoute,
        { orgId: String(org.id) },
        `${SERVER}/api/orgs/${org.id}/slack`,
        {
          method: 'DELETE',
          headers: auth(tokens.owner),
        },
      )
      expect(removed.status).toBe(200)
      expect(callsTo('auth.revoke')).toHaveLength(1)
      expect(await installation()).toBeNull()
      expect(await appSubscribers()).toHaveLength(0)
      const { totalDocs } = await payload.count({
        collection: 'slack-user-links',
        where: { teamId: { equals: TEAM } },
        overrideAccess: true,
      })
      expect(totalDocs).toBe(0)
    })

    it('removes the installation when Slack reports the app uninstalled', async () => {
      await install(tokens.owner, org.id)
      expect(await installation()).not.toBeNull()
      const challenge = await eventsRoute(
        signed(
          `${SERVER}/api/slack/events`,
          JSON.stringify({ type: 'url_verification', challenge: 'abc' }),
          {
            contentType: 'application/json',
          },
        ),
      )
      expect(await challenge.json()).toEqual({ challenge: 'abc' })
      const event = await eventsRoute(
        signed(
          `${SERVER}/api/slack/events`,
          JSON.stringify({
            type: 'event_callback',
            team_id: TEAM,
            event: { type: 'app_uninstalled' },
          }),
          { contentType: 'application/json' },
        ),
      )
      expect(event.status).toBe(200)
      expect(await installation()).toBeNull()
    })
  })
})
