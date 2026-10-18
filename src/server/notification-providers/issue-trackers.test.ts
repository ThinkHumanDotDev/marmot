/**
 * Issue-tracker providers (#149): exact request payloads of GitHub, GitLab, Gitea, Jira and Linear
 * with `fetch` mocked, and the open → comment → close lifecycle against an in-memory issue store.
 */
import { generateKeyPairSync, createVerify } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChannelEvent } from '@/lib/notification-events'
import type { Heartbeat, Monitor } from '@/payload-types'
import { createMemoryIssueState } from '@/server/notifications/issue-state'
import { validateNotificationConfig } from '@/server/notifications/send'
import { githubAppJwt } from './github-issues'
import { getNotificationProvider, OK_MESSAGE } from './index'
import { issueAction, NO_ACTION_MESSAGE } from './issue-tracker'
import { jiraAdf, jiraWiki } from './jira'
import { LINEAR_QUERIES } from './linear'

const monitor = {
  id: 7,
  name: 'API',
  type: 'http',
  url: 'https://api.example.com/health',
} as unknown as Monitor

const beat = (status: 'down' | 'up', msg: string) =>
  ({ id: 99, monitor: 7, status, msg, time: '2026-03-10T10:30:00.000Z' }) as unknown as Heartbeat

const DOWN = '[API] [🔴 Down] HTTP 503'
const REMINDER = '[API] [🔴 Down] HTTP 503 (still down)'
const UP = '[API] [✅ Up] 200 - OK (down for 7 minutes)'
const LINK = 'http://localhost:3000/acme/monitors/7'
const md = (text: string) => `${text}\n\n[Open API](${LINK})`

type Call = { url: string; method: string; headers: Headers; body: unknown }
let calls: Call[]
/** Responses by `METHOD url` (exact) or `METHOD url-prefix*`; default `{}`. */
let routes: Record<string, { status?: number; body: unknown } | ((body: unknown) => unknown)>

beforeEach(() => {
  calls = []
  routes = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
      calls.push({ url, method, headers: new Headers(init?.headers), body })
      const route = routes[`${method} ${url}`]
      const resolved = typeof route === 'function' ? { body: route(body) } : route
      return new Response(JSON.stringify(resolved?.body ?? {}), {
        status: resolved?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const store = createMemoryIssueState()
beforeEach(() => store.rows.clear())

function send(
  type: string,
  config: Record<string, unknown>,
  event: ChannelEvent | null,
  options: { message?: string; monitor?: Monitor | null; heartbeat?: Heartbeat | null } = {},
) {
  const message = options.message ?? (event === 'up' ? UP : event === 'reminder' ? REMINDER : DOWN)
  const heartbeat =
    options.heartbeat !== undefined
      ? options.heartbeat
      : beat(event === 'up' ? 'up' : 'down', message)
  return getNotificationProvider(type)!.send({
    config: validateNotificationConfig(type, config),
    message,
    monitor: options.monitor !== undefined ? options.monitor : monitor,
    heartbeat,
    event,
    organization: { name: 'Acme', slug: 'acme', logoUrl: null },
    issues: store,
  })
}

const summary = () => calls.map((c) => `${c.method} ${c.url}`)

describe('issue action', () => {
  it('opens on DOWN and reminders, closes on UP, comments otherwise', () => {
    const down = beat('down', DOWN)
    const up = beat('up', UP)
    expect(issueAction({ monitor, heartbeat: down, event: 'down' })).toBe('open')
    expect(issueAction({ monitor, heartbeat: down, event: 'reminder' })).toBe('open')
    expect(issueAction({ monitor, heartbeat: down, event: null })).toBe('open')
    expect(issueAction({ monitor, heartbeat: up, event: 'up' })).toBe('close')
    expect(issueAction({ monitor, heartbeat: up, event: null })).toBe('close')
    expect(issueAction({ monitor, heartbeat: null, event: 'acknowledged' })).toBe('comment')
    expect(issueAction({ monitor: null, heartbeat: null, event: 'down' })).toBe('test')
    expect(issueAction({ monitor: null, heartbeat: null, event: 'up' })).toBe('verify')
    expect(issueAction({ monitor: null, heartbeat: null, event: 'maintenance' })).toBe('none')
    expect(issueAction({ monitor: null, heartbeat: null, event: 'incident' })).toBe('none')
  })
})

describe('github-issues', () => {
  const config = { repository: 'acme/status', token: 'ghp_x', labels: 'outage, marmot' }
  const repo = 'https://api.github.com/repos/acme/status'

  it('opens one issue on DOWN, comments on reminders, comments and closes on UP', async () => {
    routes[`POST ${repo}/issues`] = { status: 201, body: { number: 42 } }

    expect(await send('github-issues', config, 'down')).toBe(OK_MESSAGE)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${repo}/issues`)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.get('authorization')).toBe('Bearer ghp_x')
    expect(calls[0].headers.get('accept')).toBe('application/vnd.github+json')
    expect(calls[0].headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(calls[0].body).toEqual({
      title: 'alert(marmot): API',
      body: md(DOWN),
      labels: ['outage', 'marmot'],
    })
    expect([...store.rows.values()]).toEqual(['42'])

    await send('github-issues', config, 'reminder')
    await send('github-issues', config, 'down')
    expect(summary().slice(1)).toEqual([
      `POST ${repo}/issues/42/comments`,
      `POST ${repo}/issues/42/comments`,
    ])
    expect(calls[1].body).toEqual({ body: md(REMINDER) })

    await send('github-issues', config, 'up')
    expect(summary().slice(3)).toEqual([
      `POST ${repo}/issues/42/comments`,
      `PATCH ${repo}/issues/42`,
    ])
    expect(calls[3].body).toEqual({ body: md(UP) })
    expect(calls[4].body).toEqual({ state: 'closed', state_reason: 'completed' })
    expect(store.rows.size).toBe(0)

    // A second recovery has nothing left to close.
    expect(await send('github-issues', config, 'up')).toBe(NO_ACTION_MESSAGE)
    expect(calls).toHaveLength(5)
  })

  it('uses the Enterprise API URL, title and body templates, and no link when the body has one', async () => {
    routes['POST https://ghe.example.com/api/v3/repos/acme/status/issues'] = {
      body: { number: 3 },
    }
    await send(
      'github-issues',
      {
        apiUrl: 'https://ghe.example.com/api/v3/',
        repository: 'acme/status',
        token: 't',
        assignees: 'octocat',
        titleTemplate: '{{ name }} is {{ heartbeat.status }}',
        bodyTemplate: '{{ heartbeat.msg }} – {{ monitor.dashboardUrl }}',
      },
      'down',
      { message: DOWN, heartbeat: beat('down', 'HTTP 503') },
    )
    expect(calls[0].url).toBe('https://ghe.example.com/api/v3/repos/acme/status/issues')
    expect(calls[0].body).toEqual({
      title: 'API is down',
      body: `HTTP 503 – ${LINK}`,
      assignees: ['octocat'],
    })
  })

  it('authenticates as a GitHub App installation', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    routes['POST https://api.github.com/app/installations/555/access_tokens'] = {
      body: { token: 'ghs_installation' },
    }
    routes[`POST ${repo}/issues`] = { body: { number: 1 } }
    await send(
      'github-issues',
      {
        repository: 'acme/status',
        authMethod: 'app',
        appId: '12345',
        installationId: '555',
        privateKey: pem.replace(/\n/g, '\\n'),
      },
      'down',
    )
    expect(summary()).toEqual([
      'POST https://api.github.com/app/installations/555/access_tokens',
      `POST ${repo}/issues`,
    ])
    const jwt = calls[0].headers.get('authorization')!.replace(/^Bearer /, '')
    const [header, claims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString())
    expect(parsed.iss).toBe('12345')
    expect(parsed.exp - parsed.iat).toBe(600)
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, signature, 'base64url'),
    ).toBe(true)
    expect(calls[1].headers.get('authorization')).toBe('Bearer ghs_installation')
    expect(() => githubAppJwt('1', 'not a key')).toThrow('not a valid PEM key')
  })

  it('validates the repository and the credentials of the chosen method', () => {
    expect(() =>
      validateNotificationConfig('github-issues', { repository: 'acme', token: 't' }),
    ).toThrow(/repository: Use the form owner\/repository/)
    expect(() =>
      validateNotificationConfig('github-issues', { repository: 'acme/status' }),
    ).toThrow(/token: Required/)
    expect(() =>
      validateNotificationConfig('github-issues', { repository: 'acme/status', authMethod: 'app' }),
    ).toThrow(/appId: Required; installationId: Required; privateKey: Required/)
  })

  it('opens a new issue when the stored one was deleted', async () => {
    store.rows.set('https://api.github.com/acme/status', '41')
    routes[`POST ${repo}/issues/41/comments`] = { status: 404, body: { message: 'Not Found' } }
    routes[`POST ${repo}/issues`] = { body: { number: 43 } }
    await send('github-issues', config, 'reminder')
    expect(summary()).toEqual([`POST ${repo}/issues/41/comments`, `POST ${repo}/issues`])
    expect([...store.rows.values()]).toEqual(['43'])
  })

  it('Test opens and closes a test issue for the down sample, reads the repository otherwise', async () => {
    routes[`POST ${repo}/issues`] = { body: { number: 9 } }
    const testMessage = '[Marmot] [⚠️ Test] Down: "issues" is configured correctly.'
    await send('github-issues', config, 'down', {
      monitor: null,
      heartbeat: null,
      message: testMessage,
    })
    expect(summary()).toEqual([
      `POST ${repo}/issues`,
      `POST ${repo}/issues/9/comments`,
      `PATCH ${repo}/issues/9`,
    ])
    expect(calls[0].body).toEqual({
      title: 'alert(marmot): Test',
      body: testMessage,
      labels: ['outage', 'marmot'],
    })
    calls = []
    await send('github-issues', config, 'up', { monitor: null, heartbeat: null, message: 'x' })
    expect(summary()).toEqual([`GET ${repo}`])
    expect(store.rows.size).toBe(0)
  })
})

describe('gitlab-issues', () => {
  it('opens, comments and closes through the projects API of a self-managed instance', async () => {
    const config = {
      baseUrl: 'https://git.example.com/',
      token: 'glpat-x',
      projectId: 'ops/status',
      labels: 'outage,marmot',
    }
    const project = 'https://git.example.com/api/v4/projects/ops%2Fstatus'
    routes[`POST ${project}/issues`] = { status: 201, body: { id: 900, iid: 5 } }

    await send('gitlab-issues', config, 'down')
    await send('gitlab-issues', config, 'reminder')
    await send('gitlab-issues', config, 'up')
    expect(summary()).toEqual([
      `POST ${project}/issues`,
      `POST ${project}/issues/5/notes`,
      `POST ${project}/issues/5/notes`,
      `PUT ${project}/issues/5`,
    ])
    expect(calls[0].headers.get('private-token')).toBe('glpat-x')
    expect(calls[0].body).toEqual({
      title: 'alert(marmot): API',
      description: md(DOWN),
      labels: 'outage,marmot',
    })
    expect(calls[1].body).toEqual({ body: md(REMINDER) })
    expect(calls[2].body).toEqual({ body: md(UP) })
    expect(calls[3].body).toEqual({ state_event: 'close' })
    expect(store.rows.size).toBe(0)
  })

  it('defaults to gitlab.com', async () => {
    routes['POST https://gitlab.com/api/v4/projects/123/issues'] = { body: { iid: 1 } }
    await send('gitlab-issues', { token: 't', projectId: '123' }, 'down')
    expect(calls[0].url).toBe('https://gitlab.com/api/v4/projects/123/issues')
    expect(calls[0].body).toEqual({ title: 'alert(marmot): API', description: md(DOWN) })
  })
})

describe('gitea-issues', () => {
  it('opens, comments and closes through the repository API', async () => {
    const config = {
      baseUrl: 'https://gitea.example.com',
      token: 'gtea',
      repository: 'acme/status',
    }
    const repo = 'https://gitea.example.com/api/v1/repos/acme/status'
    routes[`POST ${repo}/issues`] = { status: 201, body: { id: 77, number: 12 } }

    await send('gitea-issues', config, 'down')
    await send('gitea-issues', config, 'reminder')
    await send('gitea-issues', config, 'up')
    expect(summary()).toEqual([
      `POST ${repo}/issues`,
      `POST ${repo}/issues/12/comments`,
      `POST ${repo}/issues/12/comments`,
      `PATCH ${repo}/issues/12`,
    ])
    expect(calls[0].headers.get('authorization')).toBe('token gtea')
    expect(calls[0].body).toEqual({ title: 'alert(marmot): API', body: md(DOWN) })
    expect(calls[1].body).toEqual({ body: md(REMINDER) })
    expect(calls[2].body).toEqual({ body: md(UP) })
    expect(calls[3].body).toEqual({ state: 'closed' })
  })
})

describe('jira', () => {
  const cloud = {
    baseUrl: 'https://acme.atlassian.net',
    email: 'ops@acme.test',
    apiToken: 'atl',
    projectKey: 'OPS',
    labels: 'outage',
  }
  const api = 'https://acme.atlassian.net/rest/api/3'
  const adf = (text: string) => ({
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Open API', marks: [{ type: 'link', attrs: { href: LINK } }] },
        ],
      },
    ],
  })

  it('Cloud: creates an issue, comments, and transitions it to Done', async () => {
    routes[`POST ${api}/issue`] = { status: 201, body: { id: '10001', key: 'OPS-7' } }
    routes[`GET ${api}/issue/OPS-7/transitions`] = {
      body: {
        transitions: [
          { id: '11', name: 'Start', to: { name: 'In Progress' } },
          { id: '31', name: 'Resolve', to: { name: 'Done' } },
        ],
      },
    }

    await send('jira', cloud, 'down')
    await send('jira', cloud, 'reminder')
    await send('jira', cloud, 'up')
    expect(summary()).toEqual([
      `POST ${api}/issue`,
      `POST ${api}/issue/OPS-7/comment`,
      `POST ${api}/issue/OPS-7/comment`,
      `GET ${api}/issue/OPS-7/transitions`,
      `POST ${api}/issue/OPS-7/transitions`,
    ])
    expect(calls[0].headers.get('authorization')).toBe(
      `Basic ${Buffer.from('ops@acme.test:atl').toString('base64')}`,
    )
    expect(calls[0].body).toEqual({
      fields: {
        project: { key: 'OPS' },
        issuetype: { name: 'Bug' },
        summary: 'alert(marmot): API',
        description: adf(DOWN),
        labels: ['outage'],
      },
    })
    expect(calls[1].body).toEqual({ body: adf(REMINDER) })
    expect(calls[2].body).toEqual({ body: adf(UP) })
    expect(calls[4].body).toEqual({ transition: { id: '31' } })
    expect(store.rows.size).toBe(0)
  })

  it('Data Center: v2 API, bearer token and wiki markup, custom issue type and status', async () => {
    const dc = {
      deployment: 'datacenter',
      baseUrl: 'https://jira.example.com',
      apiToken: 'pat',
      projectKey: 'OPS',
      issueType: 'Incident',
      doneStatus: 'closed',
    }
    const v2 = 'https://jira.example.com/rest/api/2'
    routes[`POST ${v2}/issue`] = { body: { key: 'OPS-1' } }
    routes[`GET ${v2}/issue/OPS-1/transitions`] = {
      body: { transitions: [{ id: '2', name: 'Close Issue', to: { name: 'Closed' } }] },
    }
    await send('jira', dc, 'down')
    await send('jira', dc, 'up')
    expect(calls[0].headers.get('authorization')).toBe('Bearer pat')
    expect(calls[0].body).toEqual({
      fields: {
        project: { key: 'OPS' },
        issuetype: { name: 'Incident' },
        summary: 'alert(marmot): API',
        description: `${DOWN}\n\n[Open API|${LINK}]`,
      },
    })
    expect(calls[1].body).toEqual({ body: `${UP}\n\n[Open API|${LINK}]` })
    expect(calls.at(-1)!.body).toEqual({ transition: { id: '2' } })
  })

  it('reports the available transitions when the status is unreachable', async () => {
    store.rows.set('https://acme.atlassian.net/OPS', 'OPS-2')
    routes[`GET ${api}/issue/OPS-2/transitions`] = {
      body: { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }] },
    }
    routes[`GET ${api}/issue/OPS-2?fields=status`] = {
      body: { fields: { status: { name: 'Open' } } },
    }
    await expect(send('jira', cloud, 'up')).rejects.toThrow(
      'Jira has no transition from OPS-2 to "Done" (available: In Progress)',
    )
    // Retried later: the row stays.
    expect(store.rows.get('https://acme.atlassian.net/OPS')).toBe('OPS-2')

    // Already moved to Done by hand: nothing to transition.
    routes[`GET ${api}/issue/OPS-2?fields=status`] = {
      body: { fields: { status: { name: 'Done' } } },
    }
    expect(await send('jira', cloud, 'up')).toBe(OK_MESSAGE)
    expect(store.rows.size).toBe(0)
  })

  it('requires the account email on Jira Cloud and links URLs in ADF', () => {
    expect(() => validateNotificationConfig('jira', { ...cloud, email: undefined })).toThrow(
      /email: Required/,
    )
    expect(
      jiraAdf({ title: '', body: 'see https://x.test/a now', link: '', linkLabel: '' }),
    ).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see ' },
            {
              type: 'text',
              text: 'https://x.test/a',
              marks: [{ type: 'link', attrs: { href: 'https://x.test/a' } }],
            },
            { type: 'text', text: ' now' },
          ],
        },
      ],
    })
    expect(jiraWiki({ title: '', body: `at ${LINK}`, link: LINK, linkLabel: 'Open API' })).toBe(
      `at ${LINK}`,
    )
  })
})

describe('linear', () => {
  const API = 'https://api.linear.app/graphql'
  const config = { apiKey: 'lin_api_x', team: 'eng', priority: '1' }
  const states = {
    team: {
      states: {
        nodes: [
          { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
          { id: 's-dup', name: 'Duplicate', type: 'canceled', position: 3 },
          { id: 's-shipped', name: 'Shipped', type: 'completed', position: 5 },
          { id: 's-done', name: 'Done', type: 'completed', position: 4 },
        ],
      },
    },
  }

  beforeEach(() => {
    routes[`POST ${API}`] = (body) => {
      const { query } = body as { query: string }
      if (query === LINEAR_QUERIES.teamByKey) return { data: { teams: { nodes: [{ id: 't-1' }] } } }
      if (query === LINEAR_QUERIES.issueCreate) {
        return {
          data: { issueCreate: { success: true, issue: { id: 'i-1', identifier: 'ENG-4' } } },
        }
      }
      if (query === LINEAR_QUERIES.commentCreate)
        return { data: { commentCreate: { success: true } } }
      if (query === LINEAR_QUERIES.states) return { data: states }
      if (query === LINEAR_QUERIES.issueUpdate) return { data: { issueUpdate: { success: true } } }
      return { errors: [{ message: 'unexpected query' }] }
    }
  })

  it('creates an issue, comments, and moves it to the first completed state', async () => {
    await send('linear', config, 'down')
    await send('linear', config, 'reminder')
    await send('linear', config, 'up')
    expect(calls.every((c) => c.url === API && c.method === 'POST')).toBe(true)
    expect(calls[0].headers.get('authorization')).toBe('lin_api_x')
    expect(calls.map((c) => c.body)).toEqual([
      { query: LINEAR_QUERIES.teamByKey, variables: { key: 'ENG' } },
      {
        query: LINEAR_QUERIES.issueCreate,
        variables: {
          input: { teamId: 't-1', title: 'alert(marmot): API', description: md(DOWN), priority: 1 },
        },
      },
      {
        query: LINEAR_QUERIES.commentCreate,
        variables: { input: { issueId: 'i-1', body: md(REMINDER) } },
      },
      {
        query: LINEAR_QUERIES.commentCreate,
        variables: { input: { issueId: 'i-1', body: md(UP) } },
      },
      { query: LINEAR_QUERIES.teamByKey, variables: { key: 'ENG' } },
      { query: LINEAR_QUERIES.states, variables: { id: 't-1' } },
      {
        query: LINEAR_QUERIES.issueUpdate,
        variables: { id: 'i-1', input: { stateId: 's-done' } },
      },
    ])
    expect(store.rows.size).toBe(0)
  })

  it('uses a named state and a team id, and throws GraphQL errors', async () => {
    const teamId = '6f1c1d3e-2a4b-4c5d-8e9f-0a1b2c3d4e5f'
    store.rows.set(teamId, 'i-9')
    await send('linear', { apiKey: 'k', team: teamId, doneState: 'shipped' }, 'up')
    expect(calls.map((c) => (c.body as { query: string }).query)).toEqual([
      LINEAR_QUERIES.commentCreate,
      LINEAR_QUERIES.states,
      LINEAR_QUERIES.issueUpdate,
    ])
    expect(calls[1].body).toEqual({ query: LINEAR_QUERIES.states, variables: { id: teamId } })
    expect(calls[2].body).toMatchObject({
      variables: { id: 'i-9', input: { stateId: 's-shipped' } },
    })

    routes[`POST ${API}`] = { body: { errors: [{ message: 'Authentication required' }] } }
    await expect(send('linear', config, 'down')).rejects.toThrow(
      'Linear API error: Authentication required',
    )
  })
})
