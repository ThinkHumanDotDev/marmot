/**
 * Issue-tracker alerts (#149) through the notification worker: for GitHub, GitLab, Gitea, Jira and
 * Linear (APIs mocked), a DOWN opens exactly one issue, reminders comment on it and the recovery
 * comments and closes the same issue. The open ticket lives in `notification-sent-history`.
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import type { Heartbeat, Monitor, Notification, Organization } from '@/payload-types'
import { LINEAR_QUERIES } from '@/server/notification-providers/linear'
import { processNotificationJob, sendTestNotification } from '@/server/notifications'
import { issueFingerprint } from '@/server/notifications/issue-state'

let payload: Payload
let org: Organization

const run = Date.now().toString(36)
const slug = `issue-alerts-${run}`

type Call = { url: string; method: string; headers: Headers; body: unknown }
let calls: Call[]
let respond: (call: Call) => unknown

beforeEach(() => {
  calls = []
  respond = () => ({})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      }
      calls.push(call)
      return new Response(JSON.stringify(respond(call)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Issue alerts', slug },
  })
})

afterAll(async () => {
  if (!org) return
  await payload.delete({
    collection: 'monitors',
    where: { organization: { equals: org.id } },
    overrideAccess: true,
  })
  await payload.delete({
    collection: 'notifications',
    where: { organization: { equals: org.id } },
    overrideAccess: true,
  })
  await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
})

async function createChannel(name: string, type: string, cfg: object): Promise<Notification> {
  return (await payload.create({
    collection: 'notifications',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      name: `${name}-${run}`,
      type,
      config: cfg,
      active: true,
      events: ['down', 'up', 'reminder'],
    } as never,
  })) as Notification
}

async function createMonitor(name: string, channel: Notification): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    context: { skipEngineSync: true, explicitNotifications: true },
    data: {
      organization: org.id,
      name,
      type: 'http',
      url: 'https://example.com/',
      interval: 60,
      active: false,
      notifications: [channel.id],
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

const T0 = Date.parse('2026-03-10T10:00:00.000Z')

async function notify(
  channel: Notification,
  monitor: Monitor,
  event: 'down' | 'up' | 'reminder',
  minutes: number,
): Promise<void> {
  const status = event === 'up' ? 'up' : 'down'
  const beat = (await payload.create({
    collection: 'heartbeats',
    overrideAccess: true,
    depth: 0,
    data: {
      monitor: monitor.id,
      organization: org.id,
      status,
      important: event !== 'reminder',
      msg: status === 'up' ? '200 - OK' : 'HTTP 503',
      time: new Date(T0 + minutes * 60_000).toISOString(),
    } as never,
  })) as Heartbeat
  const result = await processNotificationJob(payload, {
    data: {
      notificationId: String(channel.id),
      monitorId: String(monitor.id),
      heartbeatId: String(beat.id),
      organizationId: String(org.id),
      notificationEvent: event,
    },
  })
  expect(result.outcome).toBe('sent')
}

/** The stored tickets of a channel and monitor. */
async function openTickets(channel: Notification, monitor: Monitor) {
  const { docs } = await payload.find({
    collection: 'notification-sent-history',
    where: {
      and: [{ type: { equals: 'issue' } }, { monitor: { equals: monitor.id } }],
    },
    depth: 0,
    overrideAccess: true,
  })
  return docs
    .filter((doc) => doc.fingerprint?.startsWith(`${String(channel.id)}:`))
    .map((doc) => ({
      fingerprint: doc.fingerprint,
      externalId: doc.externalId,
      organization: String(doc.organization),
    }))
}

/** DOWN, two reminders, UP; returns the messages each step rendered. */
async function lifecycle(channel: Notification, monitor: Monitor, target: string, id: string) {
  await notify(channel, monitor, 'down', 0)
  expect(await openTickets(channel, monitor)).toEqual([
    {
      fingerprint: issueFingerprint(channel.id, target),
      externalId: id,
      organization: String(org.id),
    },
  ])
  await notify(channel, monitor, 'reminder', 5)
  await notify(channel, monitor, 'reminder', 10)
  expect((await openTickets(channel, monitor)).map((t) => t.externalId)).toEqual([id])
  await notify(channel, monitor, 'up', 12)
  expect(await openTickets(channel, monitor)).toEqual([])
}

const link = (monitor: Monitor) => `http://localhost:3000/${slug}/monitors/${monitor.id}`
const DOWN = (name: string) => `[${name}] [🔴 Down] HTTP 503`
const UP = (name: string) => `[${name}] [✅ Up] 200 - OK (down for 12 minutes)`
const md = (text: string, monitor: Monitor) => `${text}\n\n[Open ${monitor.name}](${link(monitor)})`

const summary = () => calls.map((c) => `${c.method} ${c.url}`)

describe('issue-tracker channels', () => {
  it('GitHub: one issue per outage, comments on reminders, closed on recovery', async () => {
    const channel = await createChannel('github', 'github-issues', {
      repository: 'acme/status',
      token: 'ghp_secret',
      labels: 'outage',
    })
    const monitor = await createMonitor('GitHub API', channel)
    respond = (call) => (call.url.endsWith('/issues') ? { number: 17 } : {})
    const repo = 'https://api.github.com/repos/acme/status'

    await lifecycle(channel, monitor, 'https://api.github.com/acme/status', '17')

    expect(summary()).toEqual([
      `POST ${repo}/issues`,
      `POST ${repo}/issues/17/comments`,
      `POST ${repo}/issues/17/comments`,
      `POST ${repo}/issues/17/comments`,
      `PATCH ${repo}/issues/17`,
    ])
    expect(calls[0].headers.get('authorization')).toBe('Bearer ghp_secret')
    expect(calls[0].body).toEqual({
      title: 'alert(marmot): GitHub API',
      body: md(DOWN('GitHub API'), monitor),
      labels: ['outage'],
    })
    expect(calls[1].body).toEqual({ body: md(DOWN('GitHub API'), monitor) })
    expect(calls[3].body).toEqual({ body: md(UP('GitHub API'), monitor) })
    expect(calls[4].body).toEqual({ state: 'closed', state_reason: 'completed' })

    // The next outage opens a new issue.
    calls = []
    respond = () => ({ number: 18 })
    await notify(channel, monitor, 'down', 30)
    expect(summary()).toEqual([`POST ${repo}/issues`])
    expect((await openTickets(channel, monitor)).map((t) => t.externalId)).toEqual(['18'])
  })

  it('GitLab (self-managed): opens, comments and closes the same issue', async () => {
    const channel = await createChannel('gitlab', 'gitlab-issues', {
      baseUrl: 'https://gitlab.example.com',
      token: 'glpat',
      projectId: '42',
    })
    const monitor = await createMonitor('GitLab API', channel)
    respond = (call) => (call.url.endsWith('/issues') ? { id: 1000, iid: 3 } : {})
    const project = 'https://gitlab.example.com/api/v4/projects/42'

    await lifecycle(channel, monitor, 'https://gitlab.example.com/42', '3')

    expect(summary()).toEqual([
      `POST ${project}/issues`,
      `POST ${project}/issues/3/notes`,
      `POST ${project}/issues/3/notes`,
      `POST ${project}/issues/3/notes`,
      `PUT ${project}/issues/3`,
    ])
    expect(calls[0].headers.get('private-token')).toBe('glpat')
    expect(calls[0].body).toEqual({
      title: 'alert(marmot): GitLab API',
      description: md(DOWN('GitLab API'), monitor),
    })
    expect(calls[3].body).toEqual({ body: md(UP('GitLab API'), monitor) })
    expect(calls[4].body).toEqual({ state_event: 'close' })
  })

  it('Gitea: opens, comments and closes the same issue', async () => {
    const channel = await createChannel('gitea', 'gitea-issues', {
      baseUrl: 'https://gitea.example.com/',
      token: 'gtea',
      repository: 'ops/status',
    })
    const monitor = await createMonitor('Gitea API', channel)
    respond = (call) => (call.url.endsWith('/issues') ? { number: 8 } : {})
    const repo = 'https://gitea.example.com/api/v1/repos/ops/status'

    await lifecycle(channel, monitor, 'https://gitea.example.com/ops/status', '8')

    expect(summary()).toEqual([
      `POST ${repo}/issues`,
      `POST ${repo}/issues/8/comments`,
      `POST ${repo}/issues/8/comments`,
      `POST ${repo}/issues/8/comments`,
      `PATCH ${repo}/issues/8`,
    ])
    expect(calls[0].body).toEqual({
      title: 'alert(marmot): Gitea API',
      body: md(DOWN('Gitea API'), monitor),
    })
    expect(calls[4].body).toEqual({ state: 'closed' })
  })

  it('Jira Data Center: creates, comments and transitions the same issue', async () => {
    const channel = await createChannel('jira', 'jira', {
      deployment: 'datacenter',
      baseUrl: 'https://jira.example.com',
      apiToken: 'pat',
      projectKey: 'OPS',
      issueType: 'Incident',
      doneStatus: 'Resolved',
    })
    const monitor = await createMonitor('Jira API', channel)
    const api = 'https://jira.example.com/rest/api/2'
    respond = (call) => {
      if (call.url === `${api}/issue`) return { id: '100', key: 'OPS-5' }
      if (call.method === 'GET') {
        return { transitions: [{ id: '5', name: 'Resolve Issue', to: { name: 'Resolved' } }] }
      }
      return {}
    }
    const wiki = (text: string) => `${text}\n\n[Open Jira API|${link(monitor)}]`

    await lifecycle(channel, monitor, 'https://jira.example.com/OPS', 'OPS-5')

    expect(summary()).toEqual([
      `POST ${api}/issue`,
      `POST ${api}/issue/OPS-5/comment`,
      `POST ${api}/issue/OPS-5/comment`,
      `POST ${api}/issue/OPS-5/comment`,
      `GET ${api}/issue/OPS-5/transitions`,
      `POST ${api}/issue/OPS-5/transitions`,
    ])
    expect(calls[0].headers.get('authorization')).toBe('Bearer pat')
    expect(calls[0].body).toEqual({
      fields: {
        project: { key: 'OPS' },
        issuetype: { name: 'Incident' },
        summary: 'alert(marmot): Jira API',
        description: wiki(DOWN('Jira API')),
      },
    })
    expect(calls[3].body).toEqual({ body: wiki(UP('Jira API')) })
    expect(calls[5].body).toEqual({ transition: { id: '5' } })
  })

  it('Linear: creates, comments and completes the same issue', async () => {
    const channel = await createChannel('linear', 'linear', { apiKey: 'lin_api', team: 'OPS' })
    const monitor = await createMonitor('Linear API', channel)
    respond = (call) => {
      const { query } = call.body as { query: string }
      switch (query) {
        case LINEAR_QUERIES.teamByKey:
          return { data: { teams: { nodes: [{ id: 'team-1' }] } } }
        case LINEAR_QUERIES.issueCreate:
          return { data: { issueCreate: { success: true, issue: { id: 'issue-1' } } } }
        case LINEAR_QUERIES.commentCreate:
          return { data: { commentCreate: { success: true } } }
        case LINEAR_QUERIES.states:
          return {
            data: {
              team: {
                states: { nodes: [{ id: 'done', name: 'Done', type: 'completed', position: 1 }] },
              },
            },
          }
        default:
          return { data: { issueUpdate: { success: true } } }
      }
    }

    await lifecycle(channel, monitor, 'OPS', 'issue-1')

    expect(calls.map((c) => (c.body as { query: string }).query)).toEqual([
      LINEAR_QUERIES.teamByKey,
      LINEAR_QUERIES.issueCreate,
      LINEAR_QUERIES.commentCreate,
      LINEAR_QUERIES.commentCreate,
      LINEAR_QUERIES.commentCreate,
      LINEAR_QUERIES.teamByKey,
      LINEAR_QUERIES.states,
      LINEAR_QUERIES.issueUpdate,
    ])
    expect(calls[1].body).toEqual({
      query: LINEAR_QUERIES.issueCreate,
      variables: {
        input: {
          teamId: 'team-1',
          title: 'alert(marmot): Linear API',
          description: md(DOWN('Linear API'), monitor),
        },
      },
    })
    expect(calls[4].body).toEqual({
      query: LINEAR_QUERIES.commentCreate,
      variables: { input: { issueId: 'issue-1', body: md(UP('Linear API'), monitor) } },
    })
    expect(calls[7].body).toEqual({
      query: LINEAR_QUERIES.issueUpdate,
      variables: { id: 'issue-1', input: { stateId: 'done' } },
    })
  })

  it('Test opens and closes a test issue without touching the open tickets', async () => {
    const channel = await createChannel('github-test', 'github-issues', {
      repository: 'acme/test',
      token: 't',
    })
    respond = (call) => (call.url.endsWith('/issues') ? { number: 1 } : {})
    const result = await sendTestNotification(payload, channel)
    expect(result.events).toEqual(['down', 'up', 'reminder'])
    const repo = 'https://api.github.com/repos/acme/test'
    expect(summary()).toEqual([
      `POST ${repo}/issues`,
      `POST ${repo}/issues/1/comments`,
      `PATCH ${repo}/issues/1`,
      `GET ${repo}`,
      `GET ${repo}`,
    ])
    expect(calls[0].body).toEqual({
      title: 'alert(marmot): Test',
      body: `[Marmot] [⚠️ Test] Down: "github-test-${run}" is configured correctly.`,
    })
    const { totalDocs } = await payload.count({
      collection: 'notification-sent-history',
      where: { organization: { equals: org.id }, type: { equals: 'issue' } },
      overrideAccess: true,
    })
    // Only the rows of the outages still open in the tests above (GitHub's second outage).
    expect(totalDocs).toBe(1)
  })
})
