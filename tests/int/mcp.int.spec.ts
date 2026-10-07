import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { POST as pauseRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/pause/route'
import { GET as discoveryRoute } from '@/app/.well-known/mcp.json/route'
import { POST as mcpRoute } from '@/app/api/mcp/route'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { AuditLog, Incident, Monitor, Organization, StatusPage } from '@/payload-types'
import { authenticateApiKeyValue, generateApiKey } from '@/server/api-keys'
import { apiKeyPrincipal, authenticateRequest } from '@/server/auth/request-auth'
import { callRoute, type RouteHandler } from '@/server/mcp/dispatch'
import { handleMcpRequest } from '@/server/mcp/handler'
import { MCP_TOOLS } from '@/server/mcp/tools'
import { setIncidentJobSink } from '@/server/incidents/notify'
import {
  onIncidentUpdatePosted,
  type IncidentUpdatePostedEvent,
} from '@/server/status-pages/incident-events'

let payload: Payload

const run = Date.now().toString(36)
const BASE = 'http://localhost:3000'

let orgA: Organization
let orgB: Organization
let monitor: Monitor
let foreignMonitor: Monitor
let page: StatusPage
let incident: Incident
let readKey: string
let writeKey: string

const posted: IncidentUpdatePostedEvent[] = []
let unsubscribe: () => void = () => undefined

async function mintKey(org: Organization, scope: 'read' | 'write') {
  const generated = generateApiKey()
  await payload.create({
    collection: 'api-keys',
    overrideAccess: true,
    data: {
      organization: org.id,
      name: `mcp ${scope}`,
      scope,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
    },
  })
  return generated.key
}

const keyDoc = async (key: string) => {
  const auth = await authenticateApiKeyValue(payload, key)
  return auth!.apiKey
}

/** An MCP SDK client whose HTTP requests go straight to the `/api/mcp` route handler. */
async function connect(key: string | null): Promise<Client> {
  const client = new Client({ name: 'marmot-tests', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
    requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : undefined,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      return request.method === 'POST' ? mcpRoute(request) : handleMcpRequest(request)
    },
  })
  await client.connect(transport)
  return client
}

type TextResult = { content: { type: string; text: string }[]; isError?: boolean }

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as TextResult
  const text = result.content[0]?.text ?? ''
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // error results carry a plain message
  }
  return { isError: result.isError === true, text, data }
}

const createMonitor = async (org: Organization, name: string, active = true) =>
  (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      ...defaultMonitorValues('http'),
      name,
      url: 'http://localhost:3000/api/health',
      active,
      organization: org.id,
    } as never,
  })) as Monitor

const reload = (id: string | number) =>
  payload.findByID({ collection: 'monitors', id, depth: 0, overrideAccess: true })

describe('MCP server', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    // Monitor incident notifications go to a queue; nothing to deliver in this suite.
    setIncidentJobSink(async () => undefined)
    unsubscribe = onIncidentUpdatePosted((event) => {
      posted.push(event)
    })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'MCP A', slug: `mcp-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'MCP B', slug: `mcp-b-${run}` },
    })
    monitor = await createMonitor(orgA, 'API')
    foreignMonitor = await createMonitor(orgB, 'Foreign')

    const now = Date.now()
    for (const [offset, status] of [
      [120_000, 'up'],
      [60_000, 'down'],
      [0, 'up'],
    ] as const) {
      await payload.create({
        collection: 'heartbeats',
        overrideAccess: true,
        data: {
          monitor: monitor.id,
          organization: orgA.id,
          status,
          msg: status === 'down' ? 'connect ECONNREFUSED' : '200 - OK',
          ping: 42,
          important: offset !== 0,
          time: new Date(now - offset).toISOString(),
        } as never,
      })
    }

    page = await payload.create({
      collection: 'status-pages',
      overrideAccess: true,
      data: {
        organization: orgA.id,
        title: 'MCP Status',
        slug: `mcp-${run}`,
        published: true,
        groups: [{ name: 'Core', monitors: [{ monitor: monitor.id }] }],
      } as never,
    })
    incident = (await payload.create({
      collection: 'incidents',
      overrideAccess: true,
      depth: 0,
      data: {
        organization: orgA.id,
        statusPage: page.id,
        title: 'API errors',
        updates: [{ status: 'investigating', message: 'Looking into it' }],
      } as never,
    })) as Incident

    readKey = await mintKey(orgA, 'read')
    writeKey = await mintKey(orgA, 'write')
  })

  afterAll(async () => {
    unsubscribe()
    setIncidentJobSink(null)
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      const where = { organization: { in: orgIds } }
      await payload.delete({ collection: 'incidents', where })
      await payload.delete({ collection: 'status-pages', where })
      await payload.delete({ collection: 'maintenance', where })
      await payload.delete({ collection: 'monitor-incidents', where })
      await payload.delete({ collection: 'heartbeats', where })
      await payload.delete({ collection: 'monitors', where })
      await payload.delete({ collection: 'api-keys', where })
      await payload.delete({ collection: 'audit-logs', where })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
  })

  it('refuses requests without a valid API key', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }

    const anonymous = await mcpRoute(
      new Request(`${BASE}/api/mcp`, { method: 'POST', headers, body }),
    )
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Bearer/)

    const bogus = await mcpRoute(
      new Request(`${BASE}/api/mcp`, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer mk_AAAAAAAA_${'x'.repeat(43)}` },
        body,
      }),
    )
    expect(bogus.status).toBe(401)

    await expect(connect(null)).rejects.toThrow()
  })

  it('is stateless: GET and DELETE answer 405', async () => {
    const get = await handleMcpRequest(
      new Request(`${BASE}/api/mcp`, { headers: { authorization: `Bearer ${readKey}` } }),
    )
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
  })

  it('initializes and hides mutation tools from read keys', async () => {
    const client = await connect(readKey)
    expect(client.getServerVersion()?.name).toBe('marmot')
    expect(client.getInstructions()).toContain('status monitor')

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      MCP_TOOLS.filter((t) => t.scope === 'read' && t.permission !== 'notification:read')
        .map((t) => t.name)
        .sort(),
    )
    // Viewers (read keys) may not see notification channels, as in the REST API.
    expect(names).not.toContain('list_notification_channels')
    expect(names).not.toContain('pause_monitor')
    expect(names).not.toContain('add_incident_update')
    const listMonitors = tools.find((t) => t.name === 'list_monitors')!
    expect(listMonitors.annotations?.readOnlyHint).toBe(true)
    expect(listMonitors.inputSchema.properties).toHaveProperty('type')

    const pause = await client
      .callTool({ name: 'pause_monitor', arguments: { monitorId: monitor.id } })
      .then((result) => (result as TextResult).isError === true)
      .catch(() => true)
    expect(pause).toBe(true)
    expect((await reload(monitor.id)).active).toBe(true)
    await client.close()
  })

  it('read keys list monitors, status, stats and heartbeats of their organization only', async () => {
    const client = await connect(readKey)

    const list = await call(client, 'list_monitors')
    expect(list.isError).toBe(false)
    const monitors = (list.data as { monitors: { id: unknown; name: string; status: string }[] })
      .monitors
    expect(monitors.map((m) => String(m.id))).toEqual([String(monitor.id)])

    const status = await call(client, 'get_monitor_status', { monitorId: monitor.id })
    expect(status.data).toMatchObject({ name: 'API' })

    const stats = await call(client, 'get_monitor_stats', { monitorId: monitor.id, range: '24h' })
    expect(stats.isError).toBe(false)
    expect(stats.data).toMatchObject({ range: '24h', granularity: 'minute' })
    expect(stats.data).toHaveProperty('uptime')
    expect(stats.data).not.toHaveProperty('buckets')

    const beats = await call(client, 'list_heartbeats', { monitorId: monitor.id })
    const heartbeats = (beats.data as { heartbeats: { status: string }[] }).heartbeats
    expect(heartbeats.map((b) => b.status)).toEqual(['up', 'down', 'up'])
    const changes = await call(client, 'list_heartbeats', {
      monitorId: monitor.id,
      importantOnly: true,
    })
    expect((changes.data as { heartbeats: unknown[] }).heartbeats).toHaveLength(2)

    const foreign = await call(client, 'get_monitor', { monitorId: foreignMonitor.id })
    expect(foreign.isError).toBe(true)
    expect(foreign.text).toMatch(/not found/i)

    const invalid = await call(client, 'get_monitor_stats', { monitorId: monitor.id, range: '7d' })
    expect(invalid.isError).toBe(true)
    await client.close()
  })

  it('read keys list status pages, components, incidents, maintenance and channels', async () => {
    const client = await connect(readKey)

    const pages = await call(client, 'list_status_pages')
    expect((pages.data as { statusPages: { slug: string }[] }).statusPages).toEqual([
      expect.objectContaining({ slug: `mcp-${run}` }),
    ])

    const comps = await call(client, 'list_components', { statusPageId: page.id })
    const components = (comps.data as { components: { monitorId: unknown; name: string }[] })
      .components
    expect(components).toHaveLength(1)
    expect(String(components[0].monitorId)).toBe(String(monitor.id))
    expect(components[0].name).toBe('API')

    const incidents = await call(client, 'list_incidents', { activeOnly: true })
    expect((incidents.data as { incidents: { title: string }[] }).incidents).toEqual([
      expect.objectContaining({ title: 'API errors', status: 'investigating' }),
    ])

    expect((await call(client, 'list_maintenance')).isError).toBe(false)
    await client.close()
  })

  it('write keys pause and resume monitors, audited as MCP', async () => {
    const client = await connect(writeKey)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'pause_monitor',
        'add_incident_update',
        'list_notification_channels',
      ]),
    )
    expect((await call(client, 'list_notification_channels')).data).toEqual({ channels: [] })

    const paused = await call(client, 'pause_monitor', { monitorId: monitor.id })
    expect(paused.isError).toBe(false)
    expect(paused.data).toMatchObject({ active: false, status: 'paused' })
    expect((await reload(monitor.id)).active).toBe(false)

    const check = await call(client, 'check_monitor_now', { monitorId: monitor.id })
    expect(check.isError).toBe(true)
    expect(check.text).toMatch(/paused/i)

    const resumed = await call(client, 'resume_monitor', { monitorId: monitor.id })
    expect(resumed.data).toMatchObject({ active: true })
    expect((await reload(monitor.id)).active).toBe(true)

    // The collection audit hooks (#225) record the changes with the MCP client as the actor.
    const { docs } = await payload.find({
      collection: 'audit-logs',
      where: {
        and: [
          { organization: { equals: orgA.id } },
          { entityType: { equals: 'monitor' } },
          { entityId: { equals: String(monitor.id) } },
        ],
      },
      sort: 'createdAt',
      depth: 0,
      overrideAccess: true,
    })
    const rows = (docs as AuditLog[]).map((row) => ({
      action: row.action,
      actorType: row.actorType,
      actorRef: row.actorRef,
      actorLabel: row.actorLabel,
      actor: row.actor ?? null,
    }))
    const key = await keyDoc(writeKey)
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          action: 'monitor.paused',
          actorType: 'mcp',
          actorRef: String(key.id),
          actorLabel: 'mcp write · pause_monitor',
          actor: null,
        },
        expect.objectContaining({ action: 'monitor.resumed', actorType: 'mcp' }),
      ]),
    )
    await client.close()
  })

  it('write keys post incident updates that reach subscribers, and resolve incidents', async () => {
    const client = await connect(writeKey)
    posted.length = 0

    const update = await call(client, 'add_incident_update', {
      statusPageId: page.id,
      incidentId: incident.id,
      status: 'identified',
      message: 'A bad deploy; rolling back.',
    })
    expect(update.isError).toBe(false)
    expect(update.data).toMatchObject({
      status: 'identified',
      latestUpdate: { status: 'identified', message: 'A bad deploy; rolling back.' },
    })
    expect(posted.map((event) => event.update.message)).toContain('A bad deploy; rolling back.')

    const bad = await call(client, 'add_incident_update', {
      statusPageId: page.id,
      incidentId: incident.id,
      status: 'fixed',
    })
    expect(bad.isError).toBe(true)

    const resolved = await call(client, 'resolve_incident', {
      statusPageId: page.id,
      incidentId: incident.id,
      message: 'Fixed.',
    })
    expect(resolved.data).toMatchObject({ status: 'resolved', active: false })

    const created = await call(client, 'create_incident', {
      statusPageId: page.id,
      title: 'Elevated latency',
      message: 'We are investigating slow responses.',
    })
    expect(created.isError).toBe(false)
    expect(created.data).toMatchObject({ title: 'Elevated latency', status: 'investigating' })
    await client.close()
  })

  it('write keys schedule maintenance with the form schema', async () => {
    const client = await connect(writeKey)
    const created = await call(client, 'create_maintenance', {
      title: 'Database upgrade',
      strategy: 'single',
      dateRange: { start: '2030-01-06T02:00:00Z', end: '2030-01-06T03:00:00Z' },
      monitors: [monitor.id],
    })
    expect(created.isError).toBe(false)
    expect(created.data).toMatchObject({ title: 'Database upgrade', strategy: 'single' })

    const invalid = await call(client, 'create_maintenance', {
      title: 'No window',
      strategy: 'single',
    })
    expect(invalid.isError).toBe(true)
    await client.close()
  })

  it('delegated route calls keep the scope rules of the REST API', async () => {
    const auth = await authenticateApiKeyValue(payload, readKey)
    const principal = apiKeyPrincipal(auth!)
    const result = await callRoute(
      { principal, origin: BASE },
      {
        tool: 'pause_monitor',
        handler: pauseRoute as RouteHandler,
        method: 'POST',
        path: `monitors/${monitor.id}/pause`,
        params: { id: String(monitor.id) },
      },
    )
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect((await reload(monitor.id)).active).toBe(true)

    // A look-alike request that was not delegated in-process is just anonymous.
    const plain = await authenticateRequest(
      payload,
      new Request(`${BASE}/api/orgs/${orgA.id}/monitors`),
    )
    expect(plain.user).toBeNull()
  })

  it('lists, acknowledges and resolves monitor incidents, audited as MCP', async () => {
    const open = await payload.create({
      collection: 'monitor-incidents',
      overrideAccess: true,
      depth: 0,
      data: {
        organization: orgA.id,
        monitor: monitor.id,
        status: 'open',
        cause: 'connect ECONNREFUSED',
        startedAt: new Date().toISOString(),
        timeline: [{ type: 'opened', at: new Date().toISOString() }],
      } as never,
    })

    const reader = await connect(readKey)
    const list = await call(reader, 'list_monitor_incidents', { status: 'active' })
    expect(list.isError).toBe(false)
    const ids = (list.data as { docs: { id: unknown }[] }).docs.map((d) => String(d.id))
    expect(ids).toContain(String(open.id))
    const one = await call(reader, 'get_monitor_incident', { monitorIncidentId: open.id })
    expect(one.data).toMatchObject({ status: 'open' })
    const readerTools = (await reader.listTools()).tools.map((t) => t.name)
    expect(readerTools).not.toContain('acknowledge_monitor_incident')
    await reader.close()

    const writer = await connect(writeKey)
    const ack = await call(writer, 'acknowledge_monitor_incident', {
      monitorIncidentId: open.id,
      note: 'On it',
    })
    expect(ack.isError).toBe(false)
    expect(ack.data).toMatchObject({ status: 'acknowledged' })
    const again = await call(writer, 'acknowledge_monitor_incident', { monitorIncidentId: open.id })
    expect(again.isError).toBe(true)
    const resolved = await call(writer, 'resolve_monitor_incident', { monitorIncidentId: open.id })
    expect(resolved.data).toMatchObject({ status: 'resolved' })
    await writer.close()

    const { docs } = await payload.find({
      collection: 'audit-logs',
      where: {
        and: [
          { organization: { equals: orgA.id } },
          { entityType: { equals: 'monitor_incident' } },
          { entityId: { equals: String(open.id) } },
        ],
      },
      depth: 0,
      overrideAccess: true,
    })
    expect(
      (docs as AuditLog[]).map((row) => [row.action, row.actorType, row.actorLabel]).sort(),
    ).toEqual([
      ['monitor_incident.acknowledged', 'mcp', 'mcp write · acknowledge_monitor_incident'],
      ['monitor_incident.resolved', 'mcp', 'mcp write · resolve_monitor_incident'],
    ])
  })

  it('publishes a discovery document', async () => {
    const response = discoveryRoute()
    const doc = (await response.json()) as {
      transport: { type: string; url: string }
      tools: { name: string; scope: string }[]
    }
    expect(doc.transport.type).toBe('streamable-http')
    expect(doc.transport.url).toMatch(/\/api\/mcp$/)
    expect(doc.tools).toContainEqual(
      expect.objectContaining({ name: 'pause_monitor', scope: 'write' }),
    )
  })
})
