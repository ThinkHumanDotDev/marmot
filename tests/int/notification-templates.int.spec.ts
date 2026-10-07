/**
 * Liquid message templates (#150): templates are checked when a channel is saved or tested, fall
 * back to the default message at send time, email providers send a branded HTML email with a text
 * part, and the preview endpoint renders sample data without sending anything.
 */
import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { POST as previewRoute } from '@/app/api/orgs/[orgId]/notifications/preview/route'
import { POST as testRoute } from '@/app/api/orgs/[orgId]/notifications/test/route'
import type { Heartbeat, Monitor, Notification, Organization, User } from '@/payload-types'
import { setSmtpTransportFactory } from '@/server/notification-providers/smtp'
import { sendNotification } from '@/server/notifications'
import type { NotificationPreview } from '@/server/notifications/preview'

let payload: Payload
let org: Organization
let admin: User
let member: User

const run = Date.now().toString(36)
const PASSWORD = 'password-123'

const mails: Record<string, unknown>[] = []
let fetchBodies: unknown[] = []

async function createUser(name: string): Promise<User> {
  return payload.create({
    collection: 'users',
    data: { email: `tpl-${name}+${run}@marmot.test`, password: PASSWORD, name },
  })
}

async function authHeaders(user: User): Promise<Record<string, string>> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return { Authorization: `JWT ${token}` }
}

const params = () => ({ params: Promise.resolve({ orgId: String(org.id) }) })

async function post(
  route: typeof previewRoute,
  path: string,
  body: unknown,
  user?: User,
): Promise<Response> {
  return route(
    new Request(`http://localhost/api/orgs/${org.id}/notifications/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(user ? await authHeaders(user) : {}) },
      body: JSON.stringify(body),
    }),
    params(),
  )
}

function stubFetch() {
  fetchBodies = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      fetchBodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body)
      return new Response('ok', { status: 200 })
    }),
  )
}

async function createChannel(name: string, type: string, cfg: Record<string, unknown>) {
  return (await payload.create({
    collection: 'notifications',
    overrideAccess: true,
    depth: 0,
    data: { organization: org.id, name: `${name}-${run}`, type, config: cfg } as never,
  })) as Notification
}

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX'

const monitor = {
  id: 42,
  name: 'Checkout',
  type: 'http',
  url: 'https://shop.example.com/health',
} as unknown as Monitor
const down = {
  id: 1,
  status: 'down',
  msg: 'HTTP 502 <gateway>',
  time: '2026-03-10T10:30:00.000Z',
} as unknown as Heartbeat

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Template Co', slug: `templates-${run}` },
  })
  admin = await createUser('admin')
  member = await createUser('member')
  await addOrgMembership({ payload, userId: admin.id, orgId: org.id, role: 'admin' })
  await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
  setSmtpTransportFactory(
    () =>
      ({
        sendMail: async (mail: Record<string, unknown>) => {
          mails.push(mail)
          return {}
        },
      }) as never,
  )
})

afterEach(() => {
  mails.length = 0
  vi.unstubAllGlobals()
})

afterAll(() => {
  setSmtpTransportFactory(null)
})

describe('saving a channel', () => {
  it('rejects invalid templates and unknown variables as field errors', async () => {
    await expect(
      createChannel('broken', 'slack', {
        webhookUrl: SLACK,
        useTemplate: true,
        template: '{% if event == "down" %}down',
      }),
    ).rejects.toMatchObject({
      data: { errors: [expect.objectContaining({ path: 'config.template' })] },
    })
    await expect(
      createChannel('typo', 'smtp', { to: 'ops@example.com', subject: '{{ monitor.nmae }}' }),
    ).rejects.toMatchObject({
      data: {
        errors: [
          {
            path: 'config.subject',
            message: 'Unknown template variable "monitor.nmae".',
          },
        ],
      },
    })
    await expect(
      createChannel('include', 'webhook', {
        url: 'https://example.com/hook',
        contentType: 'custom',
        customBody: '{% include "/etc/passwd" %}',
      }),
    ).rejects.toMatchObject({
      data: { errors: [expect.objectContaining({ path: 'config.customBody' })] },
    })

    const ok = await createChannel('ok', 'slack', {
      webhookUrl: SLACK,
      useTemplate: true,
      template: '{% if event == "down" %}🔴{% else %}🟢{% endif %} {{ name }}: {{ msg }}',
    })
    expect(ok.id).toBeDefined()
  })

  it('keeps a channel with a template saved before the rules working (default message)', async () => {
    const legacy = await createChannel('legacy', 'slack', {
      webhookUrl: SLACK,
      useTemplate: true,
      template: '{{ name }}',
    })
    // A template stored before Liquid that does not parse as Liquid.
    await payload.db.updateOne({
      collection: 'notifications',
      id: legacy.id,
      data: {
        config: { webhookUrl: SLACK, useTemplate: true, template: '{{ 1 + 1 }} {{ name }}' },
      },
    })
    // Unrelated updates (the worker's delivery bookkeeping) do not re-check the template.
    await payload.update({
      collection: 'notifications',
      id: legacy.id,
      overrideAccess: true,
      data: { lastSentAt: new Date().toISOString() },
    })
    const stored = (await payload.findByID({
      collection: 'notifications',
      id: legacy.id,
      depth: 0,
    })) as Notification

    stubFetch()
    await sendNotification(payload, stored, { monitor, heartbeat: down, event: 'down' })
    expect(fetchBodies).toHaveLength(1)
    expect((fetchBodies[0] as { text: string }).text).toBe(
      '[Checkout] [🔴 Down] HTTP 502 <gateway>',
    )
  })

  it('tests unsaved templates like saving them', async () => {
    stubFetch()
    const res = await post(
      testRoute,
      'test',
      {
        type: 'slack',
        config: { webhookUrl: SLACK, useTemplate: true, template: '{{ heartbeat.nope }}' },
      },
      admin,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown template variable "heartbeat.nope"'),
    })
    expect(fetchBodies).toHaveLength(0)
  })
})

describe('sending', () => {
  it('renders {% if %} templates with the organization and a monitor link', async () => {
    const channel = await createChannel('slack-if', 'slack', {
      webhookUrl: SLACK,
      useTemplate: true,
      template:
        '{% if event == "down" %}DOWN{% else %}UP{% endif %} {{ name }} ({{ organization.name }}) {{ monitor.dashboardUrl }}',
    })
    stubFetch()
    await sendNotification(payload, channel, { monitor, heartbeat: down, event: 'down' })
    await sendNotification(payload, channel, {
      monitor,
      heartbeat: { ...down, status: 'up' } as Heartbeat,
      event: 'up',
    })
    const texts = fetchBodies.map((body) => (body as { text: string }).text)
    expect(texts[0]).toMatch(
      new RegExp(`^DOWN Checkout \\(Template Co\\) https?://.+/templates-${run}/monitors/42$`),
    )
    expect(texts[1]).toMatch(/^UP Checkout/)
  })

  it('sends a branded HTML email with a text part, and escapes custom HTML', async () => {
    const plain = await createChannel('smtp', 'smtp', {
      host: '127.0.0.1',
      from: 'alerts@example.com',
      to: 'ops@example.com',
    })
    await sendNotification(payload, plain, { monitor, heartbeat: down, event: 'down' })
    expect(mails).toHaveLength(1)
    expect(mails[0].subject).toBe('[Checkout] [🔴 Down] HTTP 502 <gateway>')
    expect(mails[0].html).toEqual(expect.stringContaining('HTTP 502 &lt;gateway&gt;'))
    expect(mails[0].html).toEqual(expect.stringContaining('Template Co'))
    expect(mails[0].text).toEqual(
      expect.stringContaining(
        '[Checkout] [🔴 Down] HTTP 502 <gateway>\nTime: 2026-03-10 10:30:00 (UTC)',
      ),
    )

    const custom = await createChannel('smtp-html', 'smtp', {
      host: '127.0.0.1',
      from: 'alerts@example.com',
      to: 'ops@example.com',
      subject: '{{ name }} is {{ heartbeat.status }}',
      body: '<p>{{ heartbeat.msg }}</p>',
      htmlBody: true,
    })
    await sendNotification(payload, custom, { monitor, heartbeat: down, event: 'down' })
    expect(mails[1]).toMatchObject({
      subject: 'Checkout is down',
      html: '<p>HTTP 502 &lt;gateway&gt;</p>',
      text: 'HTTP 502 <gateway>',
    })
  })
})

describe('preview endpoint', () => {
  it('needs notification:read', async () => {
    expect((await post(previewRoute, 'preview', { type: 'slack' })).status).toBe(401)
    const res = await post(previewRoute, 'preview', { type: 'slack', config: {} }, member)
    expect(res.status).toBe(200)
  })

  it('renders templates and the email for a sample event without sending', async () => {
    stubFetch()
    const res = await post(
      previewRoute,
      'preview',
      {
        type: 'smtp',
        // Incomplete settings are fine: only the templates matter.
        config: { subject: '{% if event == "up" %}Recovered{% endif %}: {{ name }}' },
        event: 'up',
      },
      admin,
    )
    expect(res.status).toBe(200)
    const preview = (await res.json()) as NotificationPreview
    expect(preview.event).toBe('up')
    expect(preview.message).toBe('[Example API] [✅ Up] 200 - OK (down for 7 minutes 3 seconds)')
    expect(preview.fields).toEqual([
      { name: 'subject', mode: 'text', output: 'Recovered: Example API', error: null },
    ])
    expect(preview.email?.subject).toBe('Recovered: Example API')
    expect(preview.email?.html).toContain('#16a34a')
    expect(preview.email?.html).toContain('Template Co')
    expect(preview.email?.text).toContain('Down for: 7 minutes 3 seconds')
    expect(fetchBodies).toHaveLength(0)
    expect(mails).toHaveLength(0)

    const broken = (await (
      await post(
        previewRoute,
        'preview',
        { type: 'slack', config: { template: '{{ monitor.nope }}' }, event: 'maintenance' },
        admin,
      )
    ).json()) as NotificationPreview
    expect(broken.message).toMatch(/Maintenance "Database upgrade" started for Example API/)
    expect(broken.fields).toEqual([
      {
        name: 'template',
        mode: 'text',
        output: null,
        error: 'Unknown template variable "monitor.nope".',
      },
    ])
    expect(broken.email).toBeNull()
  })
})
