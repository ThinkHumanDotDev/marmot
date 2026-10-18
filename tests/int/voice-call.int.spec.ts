import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { POST as voiceWebhook } from '@/app/api/notifications/voice/[callId]/[kind]/route'
import { POST as testRoute } from '@/app/api/orgs/[orgId]/notifications/test/route'
import { POST as createPolicyRoute } from '@/app/api/orgs/[orgId]/on-call/escalation-policies/route'
import { env } from '@/env'
import type {
  Heartbeat,
  Monitor,
  MonitorIncident,
  Notification,
  Organization,
  User,
} from '@/payload-types'
import { createQueue } from '@/server/engine/queues'
import { handleIncidentBeat, setIncidentJobSink } from '@/server/incidents'
import { processNotificationJob } from '@/server/notifications'
import {
  escalationStepJobId,
  processEscalationPage,
  processEscalationStep,
  setEscalationsQueue,
  type EscalationJobData,
  type EscalationJobName,
  type EscalationPageJobData,
  type EscalationStepJobData,
  type EscalationsQueue,
} from '@/server/on-call/escalation'
import { closeEmitter } from '@/server/realtime/emitter'
import {
  closeVoiceCallStore,
  loadVoiceCall,
  processVoiceCallRetry,
  setVoiceCallJobSink,
  twilioSignature,
  voiceWebhookUrl,
  type VoiceCallRetryJob,
  type VoiceWebhookKind,
} from '@/server/voice-calls'

/**
 * Phone-call alerts (#146) against a mocked Twilio: the call request, the TwiML conversation,
 * acknowledging the incident by pressing 1 (which stops the escalation), retries of unanswered
 * calls, and Twilio signature checks that refuse forged webhooks.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+voice-${run}@marmot.test`
const PASSWORD = 'password-123'
const prefix = `test-voice-${run}`

const ACCOUNT_SID = 'AC00000000000000000000000000000001'
const AUTH_TOKEN = 'twilio-auth-token-for-tests'

let org: Organization
let admin: { user: User; cookie: string }
let channel: Notification
let queue: EscalationsQueue

/** Calls Marmot asked Twilio to place, with their form fields. */
let twilioCalls: { url: string; auth: string; form: URLSearchParams }[] = []
let nextSid = 0
let retryJobs: VoiceCallRetryJob[] = []

function stubTwilio(status = 201) {
  twilioCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const headers = new Headers(init?.headers)
      twilioCalls.push({
        url,
        auth: headers.get('authorization') ?? '',
        form: new URLSearchParams(String(init?.body ?? '')),
      })
      if (status >= 400) {
        return new Response(JSON.stringify({ code: 21211, message: 'Invalid To number' }), {
          status,
        })
      }
      nextSid += 1
      return new Response(JSON.stringify({ sid: `CA${String(nextSid).padStart(32, '0')}` }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

/** The call id Marmot put in the TwiML URL of a placed call. */
const callIdOf = (call: { form: URLSearchParams }) =>
  /\/api\/notifications\/voice\/([^/]+)\/twiml$/.exec(call.form.get('Url') ?? '')![1]

/** A webhook request as Twilio sends it, signed with `token` unless `signature` is given. */
async function twilio(
  callId: string,
  kind: VoiceWebhookKind,
  fields: Record<string, string>,
  { token = AUTH_TOKEN, signature }: { token?: string; signature?: string | null } = {},
): Promise<Response> {
  const url = voiceWebhookUrl(callId, kind)
  const form = new URLSearchParams({ AccountSid: ACCOUNT_SID, ...fields })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  }
  const sig = signature === undefined ? twilioSignature(token, url, form) : signature
  if (sig !== null) headers['x-twilio-signature'] = sig
  // Behind a proxy the request URL differs from the public one Twilio signed.
  const internal = url.replace(env.NEXT_PUBLIC_SERVER_URL, 'http://10.0.0.5:3000')
  return voiceWebhook(new Request(internal, { method: 'POST', headers, body: form.toString() }), {
    params: Promise.resolve({ callId, kind }),
  })
}

async function createMonitor(name: string): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    depth: 0,
    overrideAccess: true,
    data: {
      organization: org.id,
      name,
      type: 'http',
      url: 'https://example.com',
      active: true,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      timeout: 48,
      notifications: [channel.id],
    } as never,
  })) as Monitor
}

async function goDown(monitor: Monitor): Promise<{ incident: MonitorIncident; beat: Heartbeat }> {
  const beat = (await payload.create({
    collection: 'heartbeats',
    depth: 0,
    overrideAccess: true,
    data: {
      monitor: monitor.id,
      organization: org.id,
      status: 'down',
      msg: 'HTTP 503',
      important: true,
      time: new Date().toISOString(),
    } as never,
  })) as Heartbeat
  const fresh = (await payload.findByID({
    collection: 'monitors',
    id: monitor.id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor
  const result = await handleIncidentBeat({ payload, monitor: fresh, heartbeat: beat } as never)
  return { incident: result!.incident!, beat }
}

const incident = (id: string | number) =>
  payload.findByID({
    collection: 'monitor-incidents',
    id,
    depth: 0,
    overrideAccess: true,
  }) as Promise<MonitorIncident>

/** Sends the monitor's DOWN notification through the queue processor and returns the call id. */
async function alert(monitor: Monitor, beat: Heartbeat): Promise<string> {
  stubTwilio()
  const result = await processNotificationJob(payload, {
    data: {
      notificationId: String(channel.id),
      monitorId: String(monitor.id),
      heartbeatId: String(beat.id),
      organizationId: String(org.id),
      notificationEvent: 'down',
    },
  })
  expect(result.outcome).toBe('sent')
  expect(twilioCalls).toHaveLength(1)
  return callIdOf(twilioCalls[0])
}

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Voice Co', slug: `voice-co-${run}` },
  })
  const user = await payload.create({
    collection: 'users',
    data: { email: email('admin'), password: PASSWORD, name: 'Admin' },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: org.id, role: 'admin' })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email('admin'), password: PASSWORD },
  })
  admin = { user, cookie: `payload-token=${token}` }
  channel = (await payload.create({
    collection: 'notifications',
    depth: 0,
    overrideAccess: true,
    data: {
      organization: org.id,
      name: 'On-call phone',
      type: 'voice-call',
      config: {
        accountSid: ACCOUNT_SID,
        authToken: AUTH_TOKEN,
        fromNumber: '+15005550006',
        toNumber: '+1 (415) 555-0123',
        voice: 'Polly.Joanna',
        retries: 2,
        retryDelaySeconds: 30,
      },
      events: ['down'],
      active: true,
    } as never,
  })) as Notification
  queue = createQueue<EscalationJobData, void, EscalationJobName>('escalations', { prefix })
  setEscalationsQueue(queue)
  setIncidentJobSink(async () => {})
})

beforeEach(() => {
  retryJobs = []
  setVoiceCallJobSink(async (job) => {
    retryJobs.push(job)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setVoiceCallJobSink(null)
})

afterAll(async () => {
  setEscalationsQueue(null)
  setIncidentJobSink(null)
  await queue?.obliterate({ force: true })
  await queue?.close()
  await closeVoiceCallStore()
  await closeEmitter()
  if (org) {
    for (const collection of [
      'monitor-incidents',
      'heartbeats',
      'monitors',
      'escalation-policies',
      'notifications',
    ] as const) {
      await payload.delete({ collection, where: { organization: { equals: org.id } } })
    }
    await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+voice-${run}@` } } })
})

describe('voice-call channel', () => {
  it('rejects numbers that are not E.164', async () => {
    await expect(
      payload.create({
        collection: 'notifications',
        overrideAccess: true,
        data: {
          organization: org.id,
          name: 'Bad number',
          type: 'voice-call',
          config: {
            accountSid: ACCOUNT_SID,
            authToken: AUTH_TOKEN,
            fromNumber: '+15005550006',
            toNumber: '0415 555 0123',
          },
        } as never,
      }),
    ).rejects.toThrow(/toNumber/)
  })

  it('places one test call from the channel form and confirms it with 1', async () => {
    stubTwilio()
    const response = await testRoute(
      new Request(`http://localhost/api/orgs/${org.id}/notifications/test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookie,
          Origin: env.NEXT_PUBLIC_SERVER_URL,
        },
        body: JSON.stringify({
          type: 'voice-call',
          name: 'Phone',
          config: channel.config,
          events: ['down', 'up', 'reminder'],
        }),
      }),
      { params: Promise.resolve({ orgId: String(org.id) }) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, events: ['down'] })

    // One call, however many events the channel has.
    expect(twilioCalls).toHaveLength(1)
    const [call] = twilioCalls
    expect(call.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`)
    expect(call.auth).toBe(
      `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
    )
    expect(call.form.get('To')).toBe('+14155550123')
    expect(call.form.get('From')).toBe('+15005550006')
    const callId = callIdOf(call)
    expect(call.form.get('StatusCallback')).toBe(voiceWebhookUrl(callId, 'status'))
    // A test call is never retried, so it needs no answering-machine detection.
    expect(call.form.get('MachineDetection')).toBeNull()

    const answered = await twilio(callId, 'twiml', {
      CallSid: (await loadVoiceCall(callId))!.callSid!,
    })
    expect(answered.status).toBe(200)
    expect(answered.headers.get('content-type')).toMatch(/text\/xml/)
    const twiml = await answered.text()
    expect(twiml).toContain('<Gather input="dtmf" numDigits="1"')
    expect(twiml).toContain(`action="${voiceWebhookUrl(callId, 'gather')}"`)
    expect(twiml).toContain('<Say voice="Polly.Joanna" language="en-US">')
    expect(twiml).toContain('This is a test call from Marmot. Press 1 to confirm')

    const confirmed = await twilio(callId, 'gather', { Digits: '1' })
    expect(await confirmed.text()).toContain('Test confirmed. Goodbye.</Say><Hangup/>')
  })

  it('reports Twilio errors to the form', async () => {
    stubTwilio(400)
    const response = await testRoute(
      new Request(`http://localhost/api/orgs/${org.id}/notifications/test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookie,
          Origin: env.NEXT_PUBLIC_SERVER_URL,
        },
        body: JSON.stringify({ notificationId: channel.id }),
      }),
      { params: Promise.resolve({ orgId: String(org.id) }) },
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/Twilio.*HTTP 400.*Invalid To number/)
  })
})

describe('acknowledging by phone', () => {
  it('reads the alert, repeats it on 2 and acknowledges the incident on 1', async () => {
    const monitor = await createMonitor('API production')
    const { incident: opened, beat } = await goDown(monitor)
    const callId = await alert(monitor, beat)
    expect(twilioCalls[0].form.get('MachineDetection')).toBe('Enable')

    const state = await loadVoiceCall(callId)
    expect(state).toMatchObject({
      incidentId: String(opened.id),
      attempt: 1,
      maxAttempts: 3,
      notificationId: String(channel.id),
    })
    // The auth token stays server-side: it is not in any URL Twilio gets.
    expect(twilioCalls[0].form.toString()).not.toContain(AUTH_TOKEN)

    const sid = state!.callSid!
    const answered = await (await twilio(callId, 'twiml', { CallSid: sid })).text()
    expect(answered).toContain(
      'Marmot alert. API production is down. Reason: HTTP 503. Press 1 to acknowledge the incident, or 2 to hear this message again.',
    )
    const repeated = await (await twilio(callId, 'gather', { CallSid: sid, Digits: '2' })).text()
    expect(repeated).toContain('Marmot alert. API production is down.')
    const invalid = await (await twilio(callId, 'gather', { CallSid: sid, Digits: '7' })).text()
    expect(invalid).toContain('Sorry, that key does nothing.')
    expect((await incident(opened.id)).status).toBe('open')

    const acked = await (await twilio(callId, 'gather', { CallSid: sid, Digits: '1' })).text()
    expect(acked).toContain('The incident is acknowledged. Goodbye.</Say><Hangup/>')
    const doc = await incident(opened.id)
    expect(doc).toMatchObject({ status: 'acknowledged', acknowledgedVia: 'phone' })
    expect(doc.acknowledgedBy ?? null).toBeNull()
    expect(doc.timeline?.at(-1)).toMatchObject({ type: 'acknowledged', via: 'phone' })

    // Pressing 1 again (or on another call) does not acknowledge twice.
    const again = await (await twilio(callId, 'gather', { CallSid: sid, Digits: '1' })).text()
    expect(again).toContain('Someone already acknowledged this incident.')

    // The call ended after the acknowledgement: no retry.
    await twilio(callId, 'status', { CallSid: sid, CallStatus: 'completed' })
    expect(retryJobs).toHaveLength(0)
  })

  it('says goodbye after three readings without a keypress', async () => {
    const monitor = await createMonitor('Quiet line')
    const { beat } = await goDown(monitor)
    const callId = await alert(monitor, beat)
    const sid = (await loadVoiceCall(callId))!.callSid!
    await twilio(callId, 'twiml', { CallSid: sid })
    expect(await (await twilio(callId, 'gather', { CallSid: sid })).text()).toContain('<Gather')
    expect(await (await twilio(callId, 'gather', { CallSid: sid })).text()).toContain('<Gather')
    expect(await (await twilio(callId, 'gather', { CallSid: sid })).text()).toContain(
      'Goodbye.</Say><Hangup/>',
    )
  })

  it('stops the escalation when 1 is pressed on a page', async () => {
    const monitor = await createMonitor('Checkout')
    const policy = await createPolicyRoute(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookie,
          Origin: env.NEXT_PUBLIC_SERVER_URL,
        },
        body: JSON.stringify({
          name: 'Phone first',
          steps: [
            { escalateAfterMinutes: 5, targets: [{ type: 'channel', id: channel.id }] },
            { escalateAfterMinutes: 5, targets: [{ type: 'user', id: admin.user.id }] },
          ],
          monitors: [monitor.id],
        }),
      }),
      { params: Promise.resolve({ orgId: String(org.id) }) },
    )
    expect(policy.status).toBe(201)

    const { incident: opened } = await goDown(monitor)
    expect(opened.escalation).toMatchObject({ status: 'active', step: 0 })
    const first = await queue.getJob(escalationStepJobId(opened.id, 0, 0))
    const step = await processEscalationStep(payload, first!.data as EscalationStepJobData)
    expect(step.targets?.map((target) => target.label)).toEqual(['On-call phone'])
    expect(await (await queue.getJob(escalationStepJobId(opened.id, 0, 1)))?.getState()).toBe(
      'delayed',
    )

    const pages = (await queue.getJobs(['waiting', 'delayed', 'prioritized'])).filter(
      (job) => job.name === 'escalation-page' && job.data.incidentId === String(opened.id),
    )
    stubTwilio()
    expect(await processEscalationPage(payload, pages[0].data as EscalationPageJobData)).toEqual({
      outcome: 'sent',
    })
    expect(twilioCalls).toHaveLength(1)
    const callId = callIdOf(twilioCalls[0])
    const sid = (await loadVoiceCall(callId))!.callSid!
    expect(await (await twilio(callId, 'twiml', { CallSid: sid })).text()).toContain(
      'Marmot alert. Checkout is down. Press 1 to acknowledge',
    )

    await twilio(callId, 'gather', { CallSid: sid, Digits: '1' })
    const doc = await incident(opened.id)
    expect(doc.status).toBe('acknowledged')
    expect(doc.escalation).toMatchObject({ status: 'stopped' })
    // The pending step 2 is gone: nobody else is paged.
    expect(await queue.getJob(escalationStepJobId(opened.id, 0, 1))).toBeUndefined()
  })
})

describe('retries', () => {
  it('calls again when nobody answers, until the attempts run out', async () => {
    const monitor = await createMonitor('Unanswered')
    const { incident: opened, beat } = await goDown(monitor)
    const callId = await alert(monitor, beat)
    const firstSid = (await loadVoiceCall(callId))!.callSid!

    expect(
      (await twilio(callId, 'status', { CallSid: firstSid, CallStatus: 'no-answer' })).status,
    ).toBe(204)
    expect(retryJobs).toHaveLength(1)
    expect(retryJobs[0].data).toEqual({ callId, attempt: 2 })
    expect(retryJobs[0].opts).toMatchObject({ delay: 30_000, jobId: `voice-${callId}-a2` })

    stubTwilio()
    expect(await processVoiceCallRetry(payload, retryJobs[0].data)).toEqual({ outcome: 'called' })
    expect(twilioCalls).toHaveLength(1)
    expect(callIdOf(twilioCalls[0])).toBe(callId)
    // Running the same job twice places no second call.
    expect(await processVoiceCallRetry(payload, retryJobs[0].data)).toMatchObject({
      outcome: 'skipped',
      reason: 'stale',
    })
    const second = (await loadVoiceCall(callId))!
    expect(second).toMatchObject({ attempt: 2, plays: 0 })
    expect(second.callSid).not.toBe(firstSid)

    // A late status of the first attempt is ignored.
    await twilio(callId, 'status', { CallSid: firstSid, CallStatus: 'busy' })
    expect(retryJobs).toHaveLength(1)

    // Voicemail picks up attempt 2: Marmot hangs up and calls a third time.
    const machine = await twilio(callId, 'twiml', {
      CallSid: second.callSid!,
      AnsweredBy: 'machine_start',
    })
    expect(await machine.text()).toContain('<Response><Hangup/></Response>')
    await twilio(callId, 'status', { CallSid: second.callSid!, CallStatus: 'completed' })
    expect(retryJobs.map((job) => job.data.attempt)).toEqual([2, 3])

    stubTwilio()
    await processVoiceCallRetry(payload, retryJobs[1].data)
    const third = (await loadVoiceCall(callId))!
    expect(third.attempt).toBe(3)
    // The last attempt has no retry after it.
    expect(twilioCalls[0].form.get('MachineDetection')).toBeNull()
    await twilio(callId, 'status', { CallSid: third.callSid!, CallStatus: 'no-answer' })
    expect(retryJobs).toHaveLength(2)
    expect((await incident(opened.id)).status).toBe('open')
  })

  it('does not call again once the incident is acknowledged elsewhere', async () => {
    const monitor = await createMonitor('Acked elsewhere')
    const { incident: opened, beat } = await goDown(monitor)
    const callId = await alert(monitor, beat)
    const sid = (await loadVoiceCall(callId))!.callSid!
    await twilio(callId, 'status', { CallSid: sid, CallStatus: 'busy' })
    expect(retryJobs).toHaveLength(1)

    await payload.update({
      collection: 'monitor-incidents',
      id: opened.id,
      overrideAccess: true,
      data: { status: 'acknowledged' },
    })
    stubTwilio()
    expect(await processVoiceCallRetry(payload, retryJobs[0].data)).toEqual({
      outcome: 'skipped',
      reason: 'not-open',
    })
    expect(twilioCalls).toHaveLength(0)
  })
})

describe('Twilio signature', () => {
  it('refuses forged and tampered webhooks', async () => {
    const monitor = await createMonitor('Forgery target')
    const { incident: opened, beat } = await goDown(monitor)
    const callId = await alert(monitor, beat)
    const sid = (await loadVoiceCall(callId))!.callSid!
    const fields = { CallSid: sid, Digits: '1' }

    // No signature, a garbage one, one made with another auth token.
    expect((await twilio(callId, 'gather', fields, { signature: null })).status).toBe(403)
    expect((await twilio(callId, 'gather', fields, { signature: 'bm9wZQ==' })).status).toBe(403)
    expect((await twilio(callId, 'gather', fields, { token: 'someone-elses-token' })).status).toBe(
      403,
    )

    // A genuine signature for Digits=2, replayed with Digits=1.
    const url = voiceWebhookUrl(callId, 'gather')
    const signed = twilioSignature(
      AUTH_TOKEN,
      url,
      new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: sid, Digits: '2' }),
    )
    expect((await twilio(callId, 'gather', fields, { signature: signed })).status).toBe(403)

    // A signature for another call's URL.
    const other = twilioSignature(
      AUTH_TOKEN,
      voiceWebhookUrl('A'.repeat(22), 'gather'),
      new URLSearchParams({ AccountSid: ACCOUNT_SID, ...fields }),
    )
    expect((await twilio(callId, 'gather', fields, { signature: other })).status).toBe(403)

    // Forged status callbacks schedule nothing.
    expect(
      (
        await twilio(
          callId,
          'status',
          { CallSid: sid, CallStatus: 'no-answer' },
          { token: 'someone-elses-token' },
        )
      ).status,
    ).toBe(403)
    expect(retryJobs).toHaveLength(0)

    // Unknown calls are 404 whatever the signature.
    expect((await twilio('B'.repeat(22), 'gather', fields)).status).toBe(404)
    expect((await twilio('not-a-call', 'gather', fields)).status).toBe(404)

    expect((await incident(opened.id)).status).toBe('open')
    // The genuine request still works.
    expect((await twilio(callId, 'gather', fields)).status).toBe(200)
    expect((await incident(opened.id)).status).toBe('acknowledged')
  })
})
