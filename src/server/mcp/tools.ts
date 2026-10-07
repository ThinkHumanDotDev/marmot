/**
 * The tools of Marmot's MCP server (#119). Every tool maps onto one or more management API route
 * handlers (`callRoute`), so scopes, permissions, validation, rate limits and the audit log are the
 * REST API's own. Input schemas are the API's zod validators (`maintenanceFormSchema`, the incident
 * bodies of `src/server/api/openapi.ts`) or built from the same constants.
 *
 * `scope: 'write'` tools are only listed for keys with the write scope; the routes refuse them for
 * read keys anyway.
 */
import { z } from 'zod'

import { canWithOverrides, type OrgLike, type Permission } from '@/access/permissions'

import {
  GET as listMaintenanceRoute,
  POST as createMaintenanceRoute,
} from '@/app/api/orgs/[orgId]/maintenance/route'
import { POST as checkMonitorRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/check/route'
import { GET as heartbeatsRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/heartbeats/route'
import { POST as pauseMonitorRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/pause/route'
import { POST as resumeMonitorRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/resume/route'
import { GET as getMonitorRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/route'
import { GET as monitorStatsRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/stats/route'
import { GET as listMonitorsRoute } from '@/app/api/orgs/[orgId]/monitors/route'
import { GET as listNotificationsRoute } from '@/app/api/orgs/[orgId]/notifications/route'
import { POST as incidentUpdatesRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/[incidentId]/updates/route'
import {
  GET as listIncidentsRoute,
  POST as createIncidentRoute,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/route'
import { GET as getStatusPageRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/route'
import { GET as listStatusPagesRoute } from '@/app/api/orgs/[orgId]/status-pages/route'
import { HEARTBEAT_STATUSES } from '@/collections/Heartbeats'
import type { ApiKeyScope } from '@/lib/api-key-scopes'
import { maintenanceFormSchema } from '@/lib/validation/maintenance'
import { MONITOR_TYPE_NAMES } from '@/lib/validation/monitor'
import type { Incident, Monitor, Notification, StatusPage } from '@/payload-types'
import { incidentCreateBody, incidentUpdateBody } from '@/server/api/openapi'
import type { ApiKeyPrincipal } from '@/server/auth/request-auth'
import { STATS_RANGES } from '@/server/stats/uptime-calculator'

import { callRoute, type DispatchContext, type RouteCall, type RouteHandler } from './dispatch'

export interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpTool<S extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  /** Key scope the tool needs; `write` tools are hidden from read keys. */
  scope: ApiKeyScope
  /**
   * Organization permission the underlying route checks. Tools whose permission the key's role
   * lacks (after the organization's overrides) are not listed.
   */
  permission: Permission
  inputSchema: S
  annotations: ToolAnnotations
  run(args: z.output<S>, ctx: DispatchContext): Promise<ToolResult>
}

const tool = <S extends z.ZodObject>(definition: McpTool<S>): McpTool => definition as never

// ---------------------------------------------------------------------------------------------
// Results

const json = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
})

const failure = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
})

type Call = Omit<RouteCall, 'tool' | 'handler'> & { handler: unknown }

/** Call one route; `map` shapes a successful response for the agent. */
async function viaRoute(
  ctx: DispatchContext,
  tool: string,
  call: Call,
  map: (data: never) => unknown = (data) => data,
): Promise<ToolResult> {
  const result = await callRoute(ctx, { ...call, tool, handler: call.handler as RouteHandler })
  return result.ok ? json(map(result.data as never)) : failure(result.message)
}

// ---------------------------------------------------------------------------------------------
// Shapes the agent sees (lists are summarized; `get_*` tools return full documents)

type Id = string | number

const relationId = (value: unknown): Id | null =>
  value && typeof value === 'object' ? ((value as { id?: Id }).id ?? null) : ((value as Id) ?? null)

const monitorStatus = (m: Monitor) => ({
  status: m.active === false ? 'paused' : (m.status?.lastStatus ?? 'unknown'),
  lastCheckAt: m.status?.lastCheckAt ?? null,
  responseTimeMs: m.status?.lastPing ?? null,
  message: m.status?.lastMsg ?? null,
})

const monitorSummary = (m: Monitor) => ({
  id: m.id,
  name: m.name,
  type: m.type,
  active: m.active !== false,
  target: m.url ?? m.hostname ?? null,
  ...monitorStatus(m),
})

const statusPageSummary = (page: StatusPage) => ({
  id: page.id,
  title: page.title,
  slug: page.slug,
  published: page.published ?? false,
  access: page.access ?? 'public',
})

const incidentSummary = (incident: Incident) => {
  const updates = [...(incident.updates ?? [])].sort((a, b) =>
    String(b.postedAt).localeCompare(String(a.postedAt)),
  )
  return {
    id: incident.id,
    statusPageId: relationId(incident.statusPage),
    title: incident.title,
    status: incident.status ?? null,
    impact: incident.impact ?? null,
    active: incident.active !== false,
    pinned: incident.pinned ?? false,
    createdAt: incident.createdAt,
    resolvedAt: incident.resolvedAt ?? null,
    latestUpdate: updates[0]
      ? {
          status: updates[0].status,
          message: updates[0].message ?? '',
          postedAt: updates[0].postedAt,
        }
      : null,
  }
}

const components = (page: StatusPage) =>
  (page.groups ?? []).flatMap((group) =>
    (group.monitors ?? []).map((row) => ({
      componentId: row.id ?? null,
      group: group.name,
      name:
        row.name ||
        (row.monitor && typeof row.monitor === 'object' ? row.monitor.name : null) ||
        null,
      type: row.type ?? 'monitor',
      monitorId: relationId(row.monitor),
    })),
  )

// ---------------------------------------------------------------------------------------------
// Input schemas

const id = z.union([z.string().min(1), z.number().int()])
const monitorId = id.describe('Monitor id (see list_monitors)')
const statusPageId = id.describe('Status page id (see list_status_pages)')
const incidentId = id.describe('Incident id (see list_incidents)')

const {
  title: _legacyTitle,
  content: _legacyContent,
  style: _legacyStyle,
  ...incidentFields
} = incidentCreateBody.shape

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

// ---------------------------------------------------------------------------------------------
// Tools

export const MCP_TOOLS: McpTool[] = [
  // Monitors
  tool({
    name: 'list_monitors',
    title: 'List monitors',
    description:
      'Monitors of the organization with their current status (up, down, degraded, pending, maintenance or paused), last check time and response time.',
    scope: 'read',
    permission: 'monitor:read',
    inputSchema: z.object({
      type: z.enum(MONITOR_TYPE_NAMES).optional().describe('Only monitors of this type'),
      active: z.boolean().optional().describe('false for paused monitors only'),
      limit: z.number().int().min(1).max(500).optional().describe('Page size (default 100)'),
      page: z.number().int().min(1).optional(),
    }),
    annotations: READ,
    run: (args, ctx) =>
      viaRoute(
        ctx,
        'list_monitors',
        { handler: listMonitorsRoute, method: 'GET', path: 'monitors', query: args },
        (data: { docs: Monitor[]; totalDocs: number; page: number; totalPages: number }) => ({
          monitors: data.docs.map(monitorSummary),
          totalDocs: data.totalDocs,
          page: data.page,
          totalPages: data.totalPages,
        }),
      ),
  }),
  tool({
    name: 'get_monitor',
    title: 'Get a monitor',
    description: 'The full configuration and status cache of one monitor.',
    scope: 'read',
    permission: 'monitor:read',
    inputSchema: z.object({ monitorId }),
    annotations: READ,
    run: ({ monitorId }, ctx) =>
      viaRoute(ctx, 'get_monitor', {
        handler: getMonitorRoute,
        method: 'GET',
        path: `monitors/${monitorId}`,
        params: { id: String(monitorId) },
      }),
  }),
  tool({
    name: 'get_monitor_status',
    title: 'Get monitor status',
    description:
      'Is this monitor up? Current status, last check time, response time and the last check message.',
    scope: 'read',
    permission: 'monitor:read',
    inputSchema: z.object({ monitorId }),
    annotations: READ,
    run: ({ monitorId }, ctx) =>
      viaRoute(
        ctx,
        'get_monitor_status',
        {
          handler: getMonitorRoute,
          method: 'GET',
          path: `monitors/${monitorId}`,
          params: { id: String(monitorId) },
        },
        (monitor: Monitor) => ({ id: monitor.id, name: monitor.name, ...monitorStatus(monitor) }),
      ),
  }),
  tool({
    name: 'get_monitor_stats',
    title: 'Get monitor statistics',
    description:
      'Uptime (0..1), average response time in ms and degraded checks of a monitor over 24h, 30d or 1y.',
    scope: 'read',
    permission: 'monitor:read',
    inputSchema: z.object({
      monitorId,
      range: z.enum(STATS_RANGES).default('24h'),
      includeBuckets: z
        .boolean()
        .default(false)
        .describe('Also return the per-minute/hour/day buckets of the range'),
    }),
    annotations: READ,
    run: ({ monitorId, range, includeBuckets }, ctx) =>
      viaRoute(
        ctx,
        'get_monitor_stats',
        {
          handler: monitorStatsRoute,
          method: 'GET',
          path: `monitors/${monitorId}/stats`,
          params: { id: String(monitorId) },
          query: { range },
        },
        (stats: { buckets?: unknown[] }) => {
          if (includeBuckets) return stats
          const { buckets: _buckets, ...summary } = stats
          return summary
        },
      ),
  }),
  tool({
    name: 'list_heartbeats',
    title: 'List heartbeats',
    description:
      'Latest check results of a monitor (status, message, response time), newest first. Raw results are kept for 24 hours; status changes (importantOnly) much longer.',
    scope: 'read',
    permission: 'monitor:read',
    inputSchema: z.object({
      monitorId,
      limit: z.number().int().min(1).max(500).default(50),
      status: z.enum(HEARTBEAT_STATUSES).optional(),
      importantOnly: z.boolean().default(false).describe('Only status changes'),
    }),
    annotations: READ,
    run: ({ monitorId, limit, status, importantOnly }, ctx) =>
      viaRoute(
        ctx,
        'list_heartbeats',
        {
          handler: heartbeatsRoute,
          method: 'GET',
          path: `monitors/${monitorId}/heartbeats`,
          params: { id: String(monitorId) },
          query: { limit, status, important: importantOnly ? true : undefined },
        },
        (data: { docs: Record<string, unknown>[] }) => ({
          heartbeats: data.docs.map((beat) => ({
            time: beat.time,
            status: beat.status,
            responseTimeMs: beat.ping ?? null,
            message: beat.msg ?? null,
            important: beat.important ?? false,
          })),
        }),
      ),
  }),
  tool({
    name: 'check_monitor_now',
    title: 'Check a monitor now',
    description:
      'Queue an immediate check of an active monitor. The result arrives as a heartbeat a few seconds later (see list_heartbeats).',
    scope: 'write',
    permission: 'monitor:update',
    inputSchema: z.object({ monitorId }),
    annotations: { ...WRITE, openWorldHint: true },
    run: ({ monitorId }, ctx) =>
      viaRoute(ctx, 'check_monitor_now', {
        handler: checkMonitorRoute,
        method: 'POST',
        path: `monitors/${monitorId}/check`,
        params: { id: String(monitorId) },
      }),
  }),
  tool({
    name: 'pause_monitor',
    title: 'Pause a monitor',
    description: 'Stop checking a monitor until it is resumed.',
    scope: 'write',
    permission: 'monitor:update',
    inputSchema: z.object({ monitorId }),
    annotations: { ...WRITE, idempotentHint: true },
    run: ({ monitorId }, ctx) =>
      viaRoute(
        ctx,
        'pause_monitor',
        {
          handler: pauseMonitorRoute,
          method: 'POST',
          path: `monitors/${monitorId}/pause`,
          params: { id: String(monitorId) },
        },
        monitorSummary,
      ),
  }),
  tool({
    name: 'resume_monitor',
    title: 'Resume a monitor',
    description: 'Start checking a paused monitor again.',
    scope: 'write',
    permission: 'monitor:update',
    inputSchema: z.object({ monitorId }),
    annotations: { ...WRITE, idempotentHint: true },
    run: ({ monitorId }, ctx) =>
      viaRoute(
        ctx,
        'resume_monitor',
        {
          handler: resumeMonitorRoute,
          method: 'POST',
          path: `monitors/${monitorId}/resume`,
          params: { id: String(monitorId) },
        },
        monitorSummary,
      ),
  }),

  // Status pages
  tool({
    name: 'list_status_pages',
    title: 'List status pages',
    description: 'Status pages of the organization (drafts included).',
    scope: 'read',
    permission: 'status-page:read',
    inputSchema: z.object({}),
    annotations: READ,
    run: (_args, ctx) =>
      viaRoute(
        ctx,
        'list_status_pages',
        { handler: listStatusPagesRoute, method: 'GET', path: 'status-pages' },
        (data: { docs: StatusPage[] }) => ({ statusPages: data.docs.map(statusPageSummary) }),
      ),
  }),
  tool({
    name: 'list_components',
    title: 'List status page components',
    description:
      'Components of a status page by group. Use their componentId in create_incident and add_incident_update.',
    scope: 'read',
    permission: 'status-page:read',
    inputSchema: z.object({ statusPageId }),
    annotations: READ,
    run: ({ statusPageId }, ctx) =>
      viaRoute(
        ctx,
        'list_components',
        {
          handler: getStatusPageRoute,
          method: 'GET',
          path: `status-pages/${statusPageId}`,
          params: { id: String(statusPageId) },
        },
        (data: { doc: StatusPage }) => ({
          statusPage: statusPageSummary(data.doc),
          components: components(data.doc),
        }),
      ),
  }),

  // Incidents
  tool({
    name: 'list_incidents',
    title: 'List incidents',
    description:
      'Incidents of one status page, or of every status page when statusPageId is left out, newest first.',
    scope: 'read',
    permission: 'status-page:read',
    inputSchema: z.object({
      statusPageId: statusPageId.optional(),
      activeOnly: z.boolean().default(false).describe('Only unresolved incidents'),
    }),
    annotations: READ,
    run: async ({ statusPageId, activeOnly }, ctx) => {
      let pageIds: Id[]
      if (statusPageId !== undefined) {
        pageIds = [statusPageId]
      } else {
        const pages = await callRoute(ctx, {
          tool: 'list_incidents',
          handler: listStatusPagesRoute as RouteHandler,
          method: 'GET',
          path: 'status-pages',
        })
        if (!pages.ok) return failure(pages.message)
        pageIds = (pages.data as { docs: StatusPage[] }).docs.map((page) => page.id)
      }
      const incidents: ReturnType<typeof incidentSummary>[] = []
      for (const pageId of pageIds) {
        const result = await callRoute(ctx, {
          tool: 'list_incidents',
          handler: listIncidentsRoute as RouteHandler,
          method: 'GET',
          path: `status-pages/${pageId}/incidents`,
          params: { id: String(pageId) },
        })
        if (!result.ok) return failure(result.message)
        incidents.push(...(result.data as { docs: Incident[] }).docs.map(incidentSummary))
      }
      return json({
        incidents: incidents
          .filter((incident) => !activeOnly || incident.active)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      })
    },
  }),
  tool({
    name: 'create_incident',
    title: 'Create an incident',
    description:
      'Open an incident on a status page. The first update is posted with status (default investigating) and message, and reaches the page subscribers.',
    scope: 'write',
    permission: 'status-page:update',
    inputSchema: z.object({
      statusPageId,
      title: z.string().trim().min(1).describe('Incident title'),
      ...incidentFields,
    }),
    annotations: WRITE,
    run: ({ statusPageId, ...body }, ctx) =>
      viaRoute(
        ctx,
        'create_incident',
        {
          handler: createIncidentRoute,
          method: 'POST',
          path: `status-pages/${statusPageId}/incidents`,
          params: { id: String(statusPageId) },
          body: { status: 'investigating', ...body },
        },
        (data: { doc: Incident }) => incidentSummary(data.doc),
      ),
  }),
  tool({
    name: 'add_incident_update',
    title: 'Post an incident update',
    description:
      'Post an update (investigating, identified, monitoring or resolved) to an incident. Subscribers of the status page are notified.',
    scope: 'write',
    permission: 'status-page:update',
    inputSchema: z.object({ statusPageId, incidentId, ...incidentUpdateBody.shape }),
    annotations: WRITE,
    run: ({ statusPageId, incidentId, ...body }, ctx) =>
      viaRoute(
        ctx,
        'add_incident_update',
        {
          handler: incidentUpdatesRoute,
          method: 'POST',
          path: `status-pages/${statusPageId}/incidents/${incidentId}/updates`,
          params: { id: String(statusPageId), incidentId: String(incidentId) },
          body,
        },
        (data: { doc: Incident }) => incidentSummary(data.doc),
      ),
  }),
  tool({
    name: 'resolve_incident',
    title: 'Resolve an incident',
    description:
      'Post a resolved update to an incident; every affected component returns to operational.',
    scope: 'write',
    permission: 'status-page:update',
    inputSchema: z.object({
      statusPageId,
      incidentId,
      message: z.string().optional().describe('Closing message for subscribers'),
    }),
    annotations: { ...WRITE, idempotentHint: true },
    run: ({ statusPageId, incidentId, message }, ctx) =>
      viaRoute(
        ctx,
        'resolve_incident',
        {
          handler: incidentUpdatesRoute,
          method: 'POST',
          path: `status-pages/${statusPageId}/incidents/${incidentId}/updates`,
          params: { id: String(statusPageId), incidentId: String(incidentId) },
          body: { status: 'resolved', message: message ?? '' },
        },
        (data: { doc: Incident }) => incidentSummary(data.doc),
      ),
  }),

  // Maintenance
  tool({
    name: 'list_maintenance',
    title: 'List maintenance',
    description:
      'Maintenance windows of the organization with their status (scheduled, under-maintenance, ended, inactive) and upcoming windows, running ones first.',
    scope: 'read',
    permission: 'maintenance:read',
    inputSchema: z.object({}),
    annotations: READ,
    run: (_args, ctx) =>
      viaRoute(
        ctx,
        'list_maintenance',
        { handler: listMaintenanceRoute, method: 'GET', path: 'maintenance' },
        (data: { docs: unknown[] }) => ({ maintenance: data.docs }),
      ),
  }),
  tool({
    name: 'create_maintenance',
    title: 'Schedule maintenance',
    description:
      'Schedule a maintenance window. Use strategy "single" with dateRange.start/end (ISO 8601, or local time in timezone) for a one-off window; affected monitors are not alerted while it runs.',
    scope: 'write',
    permission: 'maintenance:create',
    inputSchema: maintenanceFormSchema,
    annotations: WRITE,
    run: (body, ctx) =>
      viaRoute(ctx, 'create_maintenance', {
        handler: createMaintenanceRoute,
        method: 'POST',
        path: 'maintenance',
        body,
      }),
  }),

  // Notifications
  tool({
    name: 'list_notification_channels',
    title: 'List notification channels',
    description: 'Notification channels of the organization (secrets are never returned).',
    scope: 'read',
    permission: 'notification:read',
    inputSchema: z.object({}),
    annotations: READ,
    run: (_args, ctx) =>
      viaRoute(
        ctx,
        'list_notification_channels',
        { handler: listNotificationsRoute, method: 'GET', path: 'notifications' },
        (data: { docs: Notification[] }) => ({
          channels: data.docs.map((channel) => ({
            id: channel.id,
            name: channel.name,
            type: channel.type,
            active: channel.active !== false,
            isDefault: channel.isDefault ?? false,
          })),
        }),
      ),
  }),
]

/**
 * The tools `principal` may see and call: `write` tools for write keys only, and only tools whose
 * permission the key's role holds in `org` (with the organization's permission overrides).
 */
export const toolsFor = (principal: ApiKeyPrincipal, org: OrgLike): McpTool[] =>
  MCP_TOOLS.filter(
    (t) =>
      (t.scope === 'read' || principal.apiKey.scope === 'write') &&
      canWithOverrides(principal, org, t.permission),
  )
