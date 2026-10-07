/**
 * OpenAPI 3.1 description of Marmot's management API: every route handler under
 * `/api/orgs/:orgId/**` (#115). Served at `/api/openapi.json` with a reference page at `/api/docs`.
 *
 * Request bodies are JSON Schemas generated from zod (`z.toJSONSchema`, draft 2020-12, which is the
 * dialect OpenAPI 3.1 uses). Where a route validates with a zod schema (monitors, maintenance, API
 * keys, SSO, …) that very schema is used, so the document cannot drift from validation; the other
 * routes are described with documentation-only zod schemas below.
 *
 * Which credentials an operation accepts is derived from the same rules `authenticateRequest`
 * enforces (`src/server/auth/request-auth.ts`): `GET` needs a `read` or `write` key, other methods a
 * `write` key, and the sections in `API_KEY_FORBIDDEN_SECTIONS` accept a signed-in session only.
 * `tests/int/management-api.int.spec.ts` fails when a route handler is missing from `OPERATIONS`
 * (or the other way round).
 *
 * The public read-only API of a status page has its own document (`/status/<slug>/api/openapi.json`,
 * `src/server/status-pages/openapi.ts`); both share the conventions (3.1, `components`, error
 * envelopes, `429` with `Retry-After`).
 */
import { z } from 'zod'

import { PERMISSIONS, type Permission, ROLES } from '@/access/permissions'
import { connectionSchema } from '@/app/api/orgs/[orgId]/sso/connections/route'
import { HEARTBEAT_STATUSES } from '@/collections/Heartbeats'
import { API_KEY_SCOPES } from '@/lib/api-key-scopes'
import { COMPONENT_IMPACTS, INCIDENT_STATUSES } from '@/lib/incident-timeline'
import { occurrenceUpdateSchema } from '@/lib/maintenance-announcements'
import { DOCKER_CONNECTION_TYPES } from '@/lib/monitor-resources'
import { SUBSCRIBER_CHANNELS } from '@/lib/status-page-subscribers'
import { maintenanceFormSchema } from '@/lib/validation/maintenance'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import { apiKeyCreateSchema, apiKeyPatchSchema } from '@/server/api-keys/schemas'
import { API_KEY_FORBIDDEN_SECTIONS, isWriteMethod } from '@/server/auth/request-auth'
import { STATS_RANGES } from '@/server/stats/uptime-calculator'
import { createEndpointSchema, updateEndpointSchema } from '@/server/webhooks/manage'

/** Version of the management API contract. Breaking changes bump the major version. */
export const MANAGEMENT_API_VERSION = '1.0.0'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type JsonSchema = Record<string, unknown>

interface Body {
  /** zod schema of a JSON body, or a ready JSON Schema for other content types. */
  schema: z.ZodType | JsonSchema
  contentType?: string
  description?: string
  required?: boolean
}

interface QueryParam {
  name: string
  description: string
  schema: JsonSchema
}

export interface OperationSpec {
  method: HttpMethod
  /** OpenAPI path template, e.g. `/api/orgs/{orgId}/monitors/{id}`. */
  path: string
  operationId: string
  summary: string
  description?: string
  tag: string
  /** Organization permission the handler checks (documentation; enforced by the handler). */
  permission?: Permission
  body?: Body
  query?: QueryParam[]
  /** Success status (default 200) and what it returns. */
  status?: number
  response?: { description: string; schema?: JsonSchema; contentType?: string }
}

// ---------------------------------------------------------------------------------------------
// Documentation-only schemas for routes that validate by hand.

const id = z.union([z.string(), z.number().int()])
const impact = z.enum(COMPONENT_IMPACTS)

const componentImpacts = z
  .array(z.object({ component: z.string().describe('Component (group row) id'), impact }))
  .describe('Affected components and their impact')

export const incidentUpdateBody = z.object({
  status: z.enum(INCIDENT_STATUSES),
  message: z.string().nullable().optional(),
  components: componentImpacts.optional(),
  postedAt: z.iso.datetime({ offset: true }).optional().describe('Backdate the update'),
  impact: impact.optional().describe('Incident impact when no component is affected'),
})

export const incidentCreateBody = z.object({
  title: z.string().min(1),
  pinned: z.boolean().optional(),
  impact: impact.optional(),
  status: z.enum(INCIDENT_STATUSES).optional().describe('First update status (investigating)'),
  message: z.string().optional().describe('First update text'),
  components: componentImpacts.optional(),
  content: z.string().optional().describe('Legacy: first update text'),
  style: z.string().optional().describe('Legacy: info, warning, danger or primary'),
})

const incidentPatchBody = z.object({
  title: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  active: z.boolean().optional().describe('false posts a resolved update'),
  impact: impact.optional(),
  affectedComponents: componentImpacts.optional(),
})

const statusPageBody = z
  .object({
    title: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().nullable().optional(),
    published: z.boolean().optional(),
    access: z.enum(['public', 'password', 'email', 'ip']).optional(),
    password: z.string().optional().describe('Write-only; stored hashed'),
    groups: z.array(z.record(z.string(), z.unknown())).optional().describe('Component groups'),
    domains: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .catchall(z.unknown())
  .describe(
    'Any writable status page field (see docs/Status-Pages.md); `organization` and other server fields are ignored.',
  )

const notificationBody = z.object({
  name: z.string().min(1),
  type: z.string().min(1).describe('Provider name, see GET …/notifications/providers'),
  config: z.record(z.string(), z.unknown()).describe('Provider settings'),
  isDefault: z.boolean().optional(),
  applyExisting: z.boolean().optional(),
  active: z.boolean().optional(),
})

const notificationTestBody = z.object({
  notificationId: id.optional(),
  type: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  name: z.string().optional(),
})

const notificationMonitorsBody = z.object({ monitors: z.array(id).max(10_000) })

const subscriberHeaders = z.array(z.object({ name: z.string(), value: z.string() }))

const subscriberCreateBody = z.object({
  channel: z.enum(SUBSCRIBER_CHANNELS),
  target: z.string().describe('Address, phone number or URL'),
  components: z.array(z.string()).optional(),
  headers: subscriberHeaders.optional().describe('Webhook headers'),
})

const subscriberPatchBody = z.object({
  components: z.array(z.string()).optional(),
  headers: subscriberHeaders.optional(),
})

const batchActionBody = z.object({ action: z.enum(['send', 'discard', 'retry']) })
const viewerPatchBody = z.object({ status: z.enum(['active', 'revoked']) })
const updateMessageBody = z.object({ message: z.string() })

const dockerTestBody = z.object({
  dockerHostId: id.optional(),
  connectionType: z.enum(DOCKER_CONNECTION_TYPES).optional(),
  socketPath: z.string().optional(),
  url: z.string().optional(),
})

export const incidentNoteBody = z.object({ note: z.string().max(2000).optional() })
const publishIncidentBody = z.object({
  statusPageId: id,
  title: z.string().optional(),
  message: z.string().optional(),
  status: z.enum(INCIDENT_STATUSES).optional(),
  impact: impact.optional(),
})
const notificationPreviewBody = z.object({
  notificationId: id.optional(),
  type: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  event: z.string().optional().describe('Sample event, `down` by default'),
})
const checkQuery: QueryParam[] = [
  {
    name: 'wait',
    description: '`false` answers `202 { jobId }` at once instead of waiting for the result',
    schema: { type: 'string', enum: ['true', 'false'] },
  },
  {
    name: 'record',
    description: '`false` runs the check without storing a heartbeat',
    schema: { type: 'string', enum: ['true', 'false'] },
  },
]
const auditQuery: QueryParam[] = [
  'actorType',
  'actorId',
  'entityType',
  'entityId',
  'action',
  'from',
  'to',
  'page',
  'limit',
].map((name) => ({ name, description: `Filter: \`${name}\``, schema: { type: 'string' } }))

const roleBody = z.object({ role: z.enum(ROLES) })
const inviteLinkBody = z.object({ role: z.enum(ROLES).optional() })
const transferBody = z.object({ userId: id })
const permissionsBody = z.object({
  overrides: z.partialRecord(z.enum(Object.keys(PERMISSIONS) as [Permission]), z.enum(ROLES)),
})
const checkoutBody = z.object({
  plan: z.string().describe('A purchasable plan, e.g. team or pro'),
  interval: z.enum(['month', 'year']).optional(),
})
const ssoDomainBody = z.object({ domain: z.string().trim().min(3).max(253) })
const ssoEnforcementBody = z.object({ enforceSso: z.boolean() })
const ssoMetadataBody = z.union([
  z.object({ url: z.string().url() }),
  z.object({ xml: z.string().min(1) }),
])
const importBody = z
  .record(z.string(), z.unknown())
  .describe('A Marmot export (GET …/export) or an Uptime Kuma backup JSON')

const imageUpload: JsonSchema = {
  type: 'object',
  properties: { file: { type: 'string', format: 'binary' } },
  required: ['file'],
}
const csvUpload: JsonSchema = { type: 'string', description: 'CSV with channel,target,components' }

const anyObject: JsonSchema = { type: 'object', additionalProperties: true }
const docsPage: JsonSchema = {
  type: 'object',
  description: 'Payload pagination envelope',
  properties: {
    docs: { type: 'array', items: anyObject },
    totalDocs: { type: 'integer' },
    limit: { type: 'integer' },
    page: { type: 'integer' },
    totalPages: { type: 'integer' },
    hasNextPage: { type: 'boolean' },
    hasPrevPage: { type: 'boolean' },
  },
  required: ['docs'],
}
const docsList: JsonSchema = {
  type: 'object',
  properties: { docs: { type: 'array', items: anyObject } },
  required: ['docs'],
}

const dryRun: QueryParam = {
  name: 'dryRun',
  description: '`1` validates and reports without writing anything',
  schema: { type: 'string', enum: ['0', '1', 'true', 'false'] },
}

// ---------------------------------------------------------------------------------------------
// Operations. Keep sorted by path; one entry per exported handler.

const ORG = '/api/orgs/{orgId}'

export const OPERATIONS: OperationSpec[] = [
  // API keys (signed-in admins only; keys cannot manage keys)
  {
    method: 'GET',
    path: `${ORG}/api-keys`,
    operationId: 'listApiKeys',
    summary: "List the organization's API keys",
    tag: 'API keys',
    permission: 'api-key:read',
    response: { description: 'Keys, newest first (never the secret)', schema: docsList },
  },
  {
    method: 'POST',
    path: `${ORG}/api-keys`,
    operationId: 'createApiKey',
    summary: 'Create an API key',
    description: 'The response carries the plaintext `key` exactly once; only its hash is stored.',
    tag: 'API keys',
    permission: 'api-key:create',
    body: { schema: apiKeyCreateSchema },
    status: 201,
    response: { description: '`{ doc, key }`', schema: { $ref: '#/components/schemas/NewApiKey' } },
  },
  {
    method: 'PATCH',
    path: `${ORG}/api-keys/{id}`,
    operationId: 'updateApiKey',
    summary: 'Disable or re-enable an API key',
    tag: 'API keys',
    permission: 'api-key:delete',
    body: { schema: apiKeyPatchSchema },
    response: { description: '`{ doc }`', schema: anyObject },
  },
  {
    method: 'DELETE',
    path: `${ORG}/api-keys/{id}`,
    operationId: 'revokeApiKey',
    summary: 'Revoke an API key permanently',
    tag: 'API keys',
    permission: 'api-key:delete',
    response: { description: '`{ deleted }`', schema: anyObject },
  },

  // Audit log (signed-in admins only)
  {
    method: 'GET',
    path: `${ORG}/audit-logs`,
    operationId: 'listAuditLog',
    summary: "The organization's audit log, newest first",
    tag: 'Audit log',
    permission: 'audit-log:read',
    query: auditQuery,
  },
  {
    method: 'GET',
    path: `${ORG}/audit-logs/export`,
    operationId: 'exportAuditLog',
    summary: 'The filtered audit log as CSV',
    tag: 'Audit log',
    permission: 'audit-log:read',
    query: auditQuery,
    response: { description: 'CSV', contentType: 'text/csv', schema: { type: 'string' } },
  },

  // Billing
  {
    method: 'GET',
    path: `${ORG}/billing`,
    operationId: 'getBilling',
    summary: 'Plan, subscription, entitlements and usage',
    tag: 'Billing',
    permission: 'organization:update',
  },
  {
    method: 'POST',
    path: `${ORG}/billing/checkout`,
    operationId: 'createCheckout',
    summary: 'Start a Stripe Checkout session',
    tag: 'Billing',
    permission: 'organization:update',
    body: { schema: checkoutBody },
  },
  {
    method: 'POST',
    path: `${ORG}/billing/portal`,
    operationId: 'openBillingPortal',
    summary: 'Open the Stripe Billing Portal',
    tag: 'Billing',
    permission: 'organization:update',
  },

  // On-demand checks
  {
    method: 'POST',
    path: `${ORG}/checks`,
    operationId: 'runAdhocCheck',
    summary: 'Run a check of an unsaved monitor configuration',
    description:
      'Nothing is stored. Push, group and manual monitors cannot be tested (400); 504 when no result arrives in time. Shares the per-organization on-demand budget (`ON_DEMAND_CHECKS_PER_MINUTE`).',
    tag: 'Monitors',
    permission: 'monitor:update',
    body: { schema: monitorFormSchema },
    response: { description: 'Check result', schema: anyObject },
  },

  // Docker hosts
  {
    method: 'POST',
    path: `${ORG}/docker-hosts/test`,
    operationId: 'testDockerHost',
    summary: 'Check that a Docker daemon answers',
    tag: 'Docker hosts',
    permission: 'docker-host:update',
    body: { schema: dockerTestBody },
  },

  // Import / export
  {
    method: 'GET',
    path: `${ORG}/export`,
    operationId: 'exportOrganization',
    summary: 'Download monitors, channels, status pages and maintenance as JSON',
    tag: 'Import and export',
    permission: 'organization:update',
  },
  {
    method: 'POST',
    path: `${ORG}/import`,
    operationId: 'importOrganization',
    summary: 'Import a Marmot export or an Uptime Kuma backup',
    tag: 'Import and export',
    permission: 'monitor:create',
    body: { schema: importBody },
    query: [dryRun],
    status: 201,
    response: { description: 'Import report (200 on a dry run)', schema: anyObject },
  },
  {
    method: 'POST',
    path: `${ORG}/import/uptime-kuma`,
    operationId: 'importUptimeKuma',
    summary: 'Import an Uptime Kuma backup',
    tag: 'Import and export',
    permission: 'monitor:create',
    body: { schema: importBody },
    query: [dryRun],
    status: 201,
    response: { description: 'Import report (200 on a dry run)', schema: anyObject },
  },

  // Members and invitations (signed-in users only)
  {
    method: 'POST',
    path: `${ORG}/invitations/{invitationId}/resend`,
    operationId: 'resendInvitation',
    summary: 'Resend an invitation email',
    tag: 'Members',
    permission: 'member:invite',
  },
  {
    method: 'POST',
    path: `${ORG}/invite-link`,
    operationId: 'createInviteLink',
    summary: 'Create or rotate the invite link',
    tag: 'Members',
    permission: 'member:invite',
    body: { schema: inviteLinkBody, required: false },
  },
  {
    method: 'DELETE',
    path: `${ORG}/invite-link`,
    operationId: 'deleteInviteLink',
    summary: 'Turn the invite link off',
    tag: 'Members',
    permission: 'member:invite',
  },
  {
    method: 'PATCH',
    path: `${ORG}/members/{userId}`,
    operationId: 'changeMemberRole',
    summary: "Change a member's role",
    tag: 'Members',
    permission: 'member:update-role',
    body: { schema: roleBody },
  },
  {
    method: 'DELETE',
    path: `${ORG}/members/{userId}`,
    operationId: 'removeMember',
    summary: 'Remove a member (or leave)',
    tag: 'Members',
    permission: 'member:remove',
  },
  {
    method: 'GET',
    path: `${ORG}/permissions`,
    operationId: 'getPermissions',
    summary: 'Default, overridden and effective minimum roles',
    tag: 'Members',
    permission: 'organization:read',
  },
  {
    method: 'PUT',
    path: `${ORG}/permissions`,
    operationId: 'setPermissionOverrides',
    summary: 'Replace the permission overrides (owners)',
    tag: 'Members',
    body: { schema: permissionsBody },
  },
  {
    method: 'POST',
    path: `${ORG}/transfer-ownership`,
    operationId: 'transferOwnership',
    summary: 'Hand the organization to another member (owner)',
    tag: 'Members',
    body: { schema: transferBody },
  },

  // Maintenance
  {
    method: 'GET',
    path: `${ORG}/maintenance`,
    operationId: 'listMaintenance',
    summary: 'List maintenance windows with their current state',
    tag: 'Maintenance',
    permission: 'maintenance:read',
  },
  {
    method: 'POST',
    path: `${ORG}/maintenance`,
    operationId: 'createMaintenance',
    summary: 'Schedule a maintenance window',
    tag: 'Maintenance',
    permission: 'maintenance:create',
    body: { schema: maintenanceFormSchema },
    status: 201,
  },
  {
    method: 'GET',
    path: `${ORG}/maintenance/{id}`,
    operationId: 'getMaintenance',
    summary: 'Get a maintenance window',
    tag: 'Maintenance',
    permission: 'maintenance:read',
  },
  {
    method: 'PATCH',
    path: `${ORG}/maintenance/{id}`,
    operationId: 'updateMaintenance',
    summary: 'Update a maintenance window (partial body, merged and validated as a whole)',
    tag: 'Maintenance',
    permission: 'maintenance:update',
    body: { schema: maintenanceFormSchema, description: 'Any subset of the fields' },
  },
  {
    method: 'DELETE',
    path: `${ORG}/maintenance/{id}`,
    operationId: 'deleteMaintenance',
    summary: 'Delete a maintenance window',
    tag: 'Maintenance',
    permission: 'maintenance:delete',
  },
  {
    method: 'GET',
    path: `${ORG}/maintenance/{id}/occurrences`,
    operationId: 'listMaintenanceOccurrences',
    summary: 'Occurrences of a maintenance window',
    tag: 'Maintenance',
    permission: 'maintenance:read',
  },
  {
    method: 'POST',
    path: `${ORG}/maintenance/{id}/occurrences/{occurrenceId}/updates`,
    operationId: 'postMaintenanceUpdate',
    summary: 'Post a status update on an occurrence',
    tag: 'Maintenance',
    permission: 'maintenance:update',
    body: { schema: occurrenceUpdateSchema },
    status: 201,
  },
  {
    method: 'POST',
    path: `${ORG}/maintenance/{id}/pause`,
    operationId: 'pauseMaintenance',
    summary: 'Pause a maintenance window',
    tag: 'Maintenance',
    permission: 'maintenance:update',
  },
  {
    method: 'POST',
    path: `${ORG}/maintenance/{id}/resume`,
    operationId: 'resumeMaintenance',
    summary: 'Resume a paused maintenance window',
    tag: 'Maintenance',
    permission: 'maintenance:update',
  },

  // Monitor incidents
  {
    method: 'GET',
    path: `${ORG}/monitor-incidents`,
    operationId: 'listMonitorIncidents',
    summary: 'Monitor incidents with MTTA/MTTR statistics',
    tag: 'Monitor incidents',
    permission: 'monitor-incident:read',
    query: [
      {
        name: 'status',
        description: 'active, all, open, acknowledged or resolved',
        schema: { type: 'string' },
      },
      { name: 'monitor', description: 'Monitor id', schema: { type: 'string' } },
      { name: 'range', description: '24h, 7d, 30d, 90d or all', schema: { type: 'string' } },
      { name: 'page', description: 'Page number', schema: { type: 'integer' } },
      { name: 'limit', description: 'At most 100', schema: { type: 'integer' } },
    ],
  },
  {
    method: 'GET',
    path: `${ORG}/monitor-incidents/{id}`,
    operationId: 'getMonitorIncident',
    summary: 'A monitor incident with its timeline',
    tag: 'Monitor incidents',
    permission: 'monitor-incident:read',
  },
  {
    method: 'POST',
    path: `${ORG}/monitor-incidents/{id}/acknowledge`,
    operationId: 'acknowledgeMonitorIncident',
    summary: 'Acknowledge an incident',
    tag: 'Monitor incidents',
    permission: 'monitor-incident:acknowledge',
    body: { schema: incidentNoteBody, required: false },
  },
  {
    method: 'POST',
    path: `${ORG}/monitor-incidents/{id}/resolve`,
    operationId: 'resolveMonitorIncident',
    summary: 'Resolve an incident by hand',
    tag: 'Monitor incidents',
    permission: 'monitor-incident:resolve',
    body: { schema: incidentNoteBody, required: false },
  },
  {
    method: 'POST',
    path: `${ORG}/monitor-incidents/{id}/publish`,
    operationId: 'publishMonitorIncident',
    summary: 'Publish an incident on a status page',
    tag: 'Monitor incidents',
    permission: 'status-page:update',
    body: { schema: publishIncidentBody },
    status: 201,
  },

  // Monitors
  {
    method: 'GET',
    path: `${ORG}/monitors`,
    operationId: 'listMonitors',
    summary: 'List monitors',
    tag: 'Monitors',
    permission: 'monitor:read',
    query: [
      { name: 'limit', description: '1–500, default 100', schema: { type: 'integer' } },
      { name: 'page', description: 'Page number, default 1', schema: { type: 'integer' } },
      { name: 'type', description: 'Only monitors of this type', schema: { type: 'string' } },
      {
        name: 'active',
        description: 'Only active (`true`) or paused (`false`) monitors',
        schema: { type: 'string', enum: ['true', 'false'] },
      },
    ],
    response: { description: 'Monitors, sorted by name', schema: docsPage },
  },
  {
    method: 'POST',
    path: `${ORG}/monitors`,
    operationId: 'createMonitor',
    summary: 'Create a monitor',
    description:
      'Without a `notifications` key the organization’s default channels are attached; an explicit list (even empty) is used as is.',
    tag: 'Monitors',
    permission: 'monitor:create',
    body: { schema: monitorFormSchema },
    status: 201,
    response: { description: 'The created monitor', schema: anyObject },
  },
  {
    method: 'GET',
    path: `${ORG}/monitors/{id}`,
    operationId: 'getMonitor',
    summary: 'Get a monitor',
    tag: 'Monitors',
    permission: 'monitor:read',
  },
  {
    method: 'PATCH',
    path: `${ORG}/monitors/{id}`,
    operationId: 'updateMonitor',
    summary: 'Update a monitor (partial body, merged and validated as a whole)',
    tag: 'Monitors',
    permission: 'monitor:update',
    body: { schema: monitorFormSchema, description: 'Any subset of the fields' },
  },
  {
    method: 'DELETE',
    path: `${ORG}/monitors/{id}`,
    operationId: 'deleteMonitor',
    summary: 'Delete a monitor with its heartbeats and statistics',
    tag: 'Monitors',
    permission: 'monitor:delete',
  },
  {
    method: 'POST',
    path: `${ORG}/monitors/{id}/check`,
    operationId: 'checkMonitorNow',
    summary: 'Run the monitor check now',
    description:
      'Stores a heartbeat with `trigger: manual` unless `record=false`. Paused and push monitors answer 409; rate limited per organization (`ON_DEMAND_CHECKS_PER_MINUTE`).',
    tag: 'Monitors',
    permission: 'monitor:update',
    query: checkQuery,
    response: {
      description: 'Check result (202 `{ jobId }` with `wait=false`)',
      schema: anyObject,
    },
  },
  {
    method: 'POST',
    path: `${ORG}/monitors/{id}/clone`,
    operationId: 'cloneMonitor',
    summary: 'Duplicate a monitor (paused)',
    tag: 'Monitors',
    permission: 'monitor:create',
    status: 201,
  },
  {
    method: 'POST',
    path: `${ORG}/monitors/{id}/pause`,
    operationId: 'pauseMonitor',
    summary: 'Pause a monitor',
    tag: 'Monitors',
    permission: 'monitor:update',
  },
  {
    method: 'POST',
    path: `${ORG}/monitors/{id}/resume`,
    operationId: 'resumeMonitor',
    summary: 'Resume a monitor',
    tag: 'Monitors',
    permission: 'monitor:update',
  },
  {
    method: 'GET',
    path: `${ORG}/monitors/{id}/heartbeats`,
    operationId: 'listHeartbeats',
    summary: "A monitor's latest check results",
    description:
      'Newest first. Raw beats are kept for 24 hours, status changes (`important`) for `KEEP_DATA_PERIOD_DAYS`.',
    tag: 'Monitors',
    permission: 'monitor:read',
    query: [
      {
        name: 'limit',
        description: 'Number of beats (1–500, default 50)',
        schema: { type: 'integer', minimum: 1, maximum: 500 },
      },
      {
        name: 'status',
        description: 'Only beats with this status',
        schema: { type: 'string', enum: [...HEARTBEAT_STATUSES] },
      },
      {
        name: 'important',
        description: '`true` for status changes only',
        schema: { type: 'boolean' },
      },
    ],
    response: { description: '`{ docs }`', schema: anyObject },
  },
  {
    method: 'GET',
    path: `${ORG}/monitors/{id}/stats`,
    operationId: 'getMonitorStats',
    summary: 'Uptime and response time of a monitor',
    tag: 'Monitors',
    permission: 'monitor:read',
    query: [
      {
        name: 'range',
        description: 'Time range (default 24h)',
        schema: { type: 'string', enum: [...STATS_RANGES] },
      },
    ],
    response: {
      description: '`{ uptime, avgPing, degraded, range, granularity, buckets }`',
      schema: anyObject,
    },
  },

  // Notification channels
  {
    method: 'GET',
    path: `${ORG}/notifications`,
    operationId: 'listNotificationChannels',
    summary: 'List notification channels (secrets masked below admin)',
    tag: 'Notifications',
    permission: 'notification:read',
    response: { description: 'Channels', schema: docsList },
  },
  {
    method: 'POST',
    path: `${ORG}/notifications`,
    operationId: 'createNotificationChannel',
    summary: 'Create a notification channel',
    tag: 'Notifications',
    permission: 'notification:create',
    body: { schema: notificationBody },
    status: 201,
  },
  {
    method: 'PATCH',
    path: `${ORG}/notifications/{id}`,
    operationId: 'updateNotificationChannel',
    summary: 'Update a notification channel',
    tag: 'Notifications',
    permission: 'notification:update',
    body: { schema: notificationBody.partial() },
  },
  {
    method: 'DELETE',
    path: `${ORG}/notifications/{id}`,
    operationId: 'deleteNotificationChannel',
    summary: 'Delete a notification channel',
    tag: 'Notifications',
    permission: 'notification:delete',
  },
  {
    method: 'GET',
    path: `${ORG}/notifications/{id}/monitors`,
    operationId: 'listChannelMonitors',
    summary: 'Monitors and whether each alerts through the channel',
    tag: 'Notifications',
    permission: 'notification:read',
  },
  {
    method: 'PUT',
    path: `${ORG}/notifications/{id}/monitors`,
    operationId: 'setChannelMonitors',
    summary: 'Set which monitors alert through the channel',
    tag: 'Notifications',
    permission: 'notification:update',
    body: { schema: notificationMonitorsBody },
  },
  {
    method: 'GET',
    path: `${ORG}/notifications/providers`,
    operationId: 'listNotificationProviders',
    summary: 'Notification providers and their settings forms',
    tag: 'Notifications',
    permission: 'notification:read',
  },
  {
    method: 'POST',
    path: `${ORG}/notifications/preview`,
    operationId: 'previewNotification',
    summary: 'Render message templates against sample data (nothing is sent)',
    tag: 'Notifications',
    permission: 'notification:read',
    body: { schema: notificationPreviewBody },
  },
  {
    method: 'POST',
    path: `${ORG}/notifications/test`,
    operationId: 'testNotificationChannel',
    summary: 'Send a test message',
    tag: 'Notifications',
    permission: 'notification:update',
    body: { schema: notificationTestBody },
  },

  // Single sign-on (signed-in owners and admins only)
  {
    method: 'GET',
    path: `${ORG}/sso/connections`,
    operationId: 'listSsoConnections',
    summary: 'List SSO connections',
    tag: 'Single sign-on',
    permission: 'sso:read',
  },
  {
    method: 'POST',
    path: `${ORG}/sso/connections`,
    operationId: 'createSsoConnection',
    summary: 'Create an SSO connection',
    tag: 'Single sign-on',
    permission: 'sso:manage',
    body: { schema: connectionSchema },
    status: 201,
  },
  {
    method: 'PATCH',
    path: `${ORG}/sso/connections/{id}`,
    operationId: 'updateSsoConnection',
    summary: 'Update an SSO connection',
    tag: 'Single sign-on',
    permission: 'sso:manage',
    body: { schema: connectionSchema.partial() },
  },
  {
    method: 'DELETE',
    path: `${ORG}/sso/connections/{id}`,
    operationId: 'deleteSsoConnection',
    summary: 'Delete an SSO connection',
    tag: 'Single sign-on',
    permission: 'sso:manage',
  },
  {
    method: 'GET',
    path: `${ORG}/sso/domains`,
    operationId: 'listSsoDomains',
    summary: 'List claimed domains',
    tag: 'Single sign-on',
    permission: 'sso:read',
  },
  {
    method: 'POST',
    path: `${ORG}/sso/domains`,
    operationId: 'claimSsoDomain',
    summary: 'Claim a domain (verified by a DNS TXT record)',
    tag: 'Single sign-on',
    permission: 'sso:manage',
    body: { schema: ssoDomainBody },
    status: 201,
  },
  {
    method: 'DELETE',
    path: `${ORG}/sso/domains/{id}`,
    operationId: 'deleteSsoDomain',
    summary: 'Release a domain',
    tag: 'Single sign-on',
    permission: 'sso:manage',
  },
  {
    method: 'POST',
    path: `${ORG}/sso/domains/{id}/verify`,
    operationId: 'verifySsoDomain',
    summary: 'Look the DNS TXT record up now',
    tag: 'Single sign-on',
    permission: 'sso:manage',
  },
  {
    method: 'PATCH',
    path: `${ORG}/sso/enforcement`,
    operationId: 'setSsoEnforcement',
    summary: 'Require SSO for verified domains',
    tag: 'Single sign-on',
    permission: 'sso:manage',
    body: { schema: ssoEnforcementBody },
  },
  {
    method: 'POST',
    path: `${ORG}/sso/metadata`,
    operationId: 'parseSamlMetadata',
    summary: 'Parse SAML identity-provider metadata',
    tag: 'Single sign-on',
    permission: 'sso:manage',
    body: { schema: ssoMetadataBody },
  },

  // Status pages
  {
    method: 'GET',
    path: `${ORG}/status-pages`,
    operationId: 'listStatusPages',
    summary: 'List status pages',
    tag: 'Status pages',
    permission: 'status-page:read',
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages`,
    operationId: 'createStatusPage',
    summary: 'Create a status page',
    tag: 'Status pages',
    permission: 'status-page:create',
    body: { schema: statusPageBody },
    status: 201,
  },
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}`,
    operationId: 'getStatusPage',
    summary: 'Get a status page',
    tag: 'Status pages',
    permission: 'status-page:read',
  },
  {
    method: 'PATCH',
    path: `${ORG}/status-pages/{id}`,
    operationId: 'updateStatusPage',
    summary: 'Update a status page',
    tag: 'Status pages',
    permission: 'status-page:update',
    body: { schema: statusPageBody.partial() },
  },
  {
    method: 'DELETE',
    path: `${ORG}/status-pages/{id}`,
    operationId: 'deleteStatusPage',
    summary: 'Delete a status page',
    tag: 'Status pages',
    permission: 'status-page:delete',
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/favicon`,
    operationId: 'uploadStatusPageFavicon',
    summary: 'Upload the favicon (PNG, ICO or SVG, ≤ 100 KB)',
    tag: 'Status pages',
    permission: 'status-page:update',
    body: { schema: imageUpload, contentType: 'multipart/form-data' },
  },
  {
    method: 'DELETE',
    path: `${ORG}/status-pages/{id}/favicon`,
    operationId: 'removeStatusPageFavicon',
    summary: 'Remove the favicon',
    tag: 'Status pages',
    permission: 'status-page:update',
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/logo`,
    operationId: 'uploadStatusPageLogo',
    summary: 'Upload the logo',
    tag: 'Status pages',
    permission: 'status-page:update',
    body: { schema: imageUpload, contentType: 'multipart/form-data' },
  },
  {
    method: 'DELETE',
    path: `${ORG}/status-pages/{id}/logo`,
    operationId: 'removeStatusPageLogo',
    summary: 'Remove the logo',
    tag: 'Status pages',
    permission: 'status-page:update',
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/logo-dark`,
    operationId: 'uploadStatusPageDarkLogo',
    summary: 'Upload the dark-mode logo',
    tag: 'Status pages',
    permission: 'status-page:update',
    body: { schema: imageUpload, contentType: 'multipart/form-data' },
  },
  {
    method: 'DELETE',
    path: `${ORG}/status-pages/{id}/logo-dark`,
    operationId: 'removeStatusPageDarkLogo',
    summary: 'Remove the dark-mode logo',
    tag: 'Status pages',
    permission: 'status-page:update',
  },

  // Incidents
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/incidents`,
    operationId: 'listIncidents',
    summary: "List a status page's incidents",
    tag: 'Incidents',
    permission: 'status-page:read',
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/incidents`,
    operationId: 'createIncident',
    summary: 'Open an incident',
    tag: 'Incidents',
    permission: 'status-page:update',
    body: { schema: incidentCreateBody },
    status: 201,
  },
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/incidents/{incidentId}`,
    operationId: 'getIncident',
    summary: 'Get an incident with its timeline',
    tag: 'Incidents',
    permission: 'status-page:read',
  },
  {
    method: 'PATCH',
    path: `${ORG}/status-pages/{id}/incidents/{incidentId}`,
    operationId: 'updateIncident',
    summary: 'Update an incident (title, pin, resolve)',
    tag: 'Incidents',
    permission: 'status-page:update',
    body: { schema: incidentPatchBody },
  },
  {
    method: 'DELETE',
    path: `${ORG}/status-pages/{id}/incidents/{incidentId}`,
    operationId: 'deleteIncident',
    summary: 'Delete an incident',
    tag: 'Incidents',
    permission: 'status-page:update',
  },
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/incidents/{incidentId}/updates`,
    operationId: 'listIncidentUpdates',
    summary: "An incident's timeline",
    tag: 'Incidents',
    permission: 'status-page:read',
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/incidents/{incidentId}/updates`,
    operationId: 'postIncidentUpdate',
    summary: 'Post an incident update',
    tag: 'Incidents',
    permission: 'status-page:update',
    body: { schema: incidentUpdateBody },
    status: 201,
  },
  {
    method: 'PATCH',
    path: `${ORG}/status-pages/{id}/incidents/{incidentId}/updates/{updateId}`,
    operationId: 'editIncidentUpdate',
    summary: 'Edit the text of a posted update',
    tag: 'Incidents',
    permission: 'status-page:update',
    body: { schema: updateMessageBody },
  },

  // Subscribers and their notifications
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/notifications`,
    operationId: 'listSubscriberNotifications',
    summary: 'Subscriber notifications of a page (drafts included)',
    tag: 'Subscribers',
    permission: 'subscriber:read',
  },
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/notifications/{notificationId}`,
    operationId: 'getSubscriberNotification',
    summary: 'A subscriber notification with rendering, recipients and deliveries',
    tag: 'Subscribers',
    permission: 'subscriber:read',
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/notifications/{notificationId}`,
    operationId: 'actOnSubscriberNotification',
    summary: 'Send, discard or retry a subscriber notification',
    tag: 'Subscribers',
    permission: 'subscriber:send',
    body: { schema: batchActionBody },
  },
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/subscribers`,
    operationId: 'listSubscribers',
    summary: "A page's subscribers, 50 per page",
    tag: 'Subscribers',
    permission: 'subscriber:read',
    query: [
      { name: 'page', description: 'Page number', schema: { type: 'integer' } },
      { name: 'q', description: 'Search the target', schema: { type: 'string' } },
      { name: 'channel', description: 'Only this channel', schema: { type: 'string' } },
    ],
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/subscribers`,
    operationId: 'addSubscriber',
    summary: 'Add a confirmed subscriber',
    tag: 'Subscribers',
    permission: 'subscriber:manage',
    body: { schema: subscriberCreateBody },
    status: 201,
  },
  {
    method: 'PATCH',
    path: `${ORG}/status-pages/{id}/subscribers/{subscriberId}`,
    operationId: 'updateSubscriber',
    summary: "Change a subscriber's components or webhook headers",
    tag: 'Subscribers',
    permission: 'subscriber:manage',
    body: { schema: subscriberPatchBody },
  },
  {
    method: 'DELETE',
    path: `${ORG}/status-pages/{id}/subscribers/{subscriberId}`,
    operationId: 'removeSubscriber',
    summary: 'Remove a subscriber',
    tag: 'Subscribers',
    permission: 'subscriber:manage',
  },
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/subscribers/export`,
    operationId: 'exportSubscribers',
    summary: 'Every subscriber of the page as CSV',
    tag: 'Subscribers',
    permission: 'subscriber:read',
    response: { description: 'CSV', contentType: 'text/csv', schema: { type: 'string' } },
  },
  {
    method: 'POST',
    path: `${ORG}/status-pages/{id}/subscribers/import`,
    operationId: 'importSubscribers',
    summary: 'Import subscribers from CSV',
    tag: 'Subscribers',
    permission: 'subscriber:manage',
    body: { schema: csvUpload, contentType: 'text/csv' },
  },

  // Viewers of restricted pages
  {
    method: 'GET',
    path: `${ORG}/status-pages/{id}/viewers`,
    operationId: 'listStatusPageViewers',
    summary: 'Visitors who signed in to a restricted page',
    tag: 'Status pages',
    permission: 'status-page:update',
  },
  {
    method: 'PATCH',
    path: `${ORG}/status-pages/{id}/viewers/{viewerId}`,
    operationId: 'updateStatusPageViewer',
    summary: 'Revoke or restore a visitor',
    tag: 'Status pages',
    permission: 'status-page:update',
    body: { schema: viewerPatchBody },
  },
  {
    method: 'DELETE',
    path: `${ORG}/status-pages/{id}/viewers/{viewerId}`,
    operationId: 'deleteStatusPageViewer',
    summary: 'Forget a visitor',
    tag: 'Status pages',
    permission: 'status-page:update',
  },

  // Outbound webhooks (admins by default; keys only where the organization lowered `webhook:*`)
  {
    method: 'GET',
    path: `${ORG}/webhooks`,
    operationId: 'listWebhookEndpoints',
    summary: 'Webhook endpoints (without secrets) and the event catalogue',
    tag: 'Webhooks',
    permission: 'webhook:read',
  },
  {
    method: 'POST',
    path: `${ORG}/webhooks`,
    operationId: 'createWebhookEndpoint',
    summary: 'Create a webhook endpoint',
    description: 'The response carries the signing `secret` exactly once.',
    tag: 'Webhooks',
    permission: 'webhook:manage',
    body: { schema: createEndpointSchema },
    status: 201,
    response: { description: '`{ doc, secret }`', schema: anyObject },
  },
  {
    method: 'GET',
    path: `${ORG}/webhooks/{id}`,
    operationId: 'getWebhookEndpoint',
    summary: 'A webhook endpoint (without its secret)',
    tag: 'Webhooks',
    permission: 'webhook:read',
  },
  {
    method: 'PATCH',
    path: `${ORG}/webhooks/{id}`,
    operationId: 'updateWebhookEndpoint',
    summary: 'Update a webhook endpoint (re-enabling resets its failure streak)',
    tag: 'Webhooks',
    permission: 'webhook:manage',
    body: { schema: updateEndpointSchema },
  },
  {
    method: 'DELETE',
    path: `${ORG}/webhooks/{id}`,
    operationId: 'deleteWebhookEndpoint',
    summary: 'Delete a webhook endpoint',
    tag: 'Webhooks',
    permission: 'webhook:manage',
  },
  {
    method: 'GET',
    path: `${ORG}/webhooks/{id}/deliveries`,
    operationId: 'listWebhookDeliveries',
    summary: "An endpoint's delivery log, 25 per page",
    tag: 'Webhooks',
    permission: 'webhook:read',
    query: [
      { name: 'page', description: 'Page number', schema: { type: 'integer' } },
      { name: 'state', description: 'Only deliveries in this state', schema: { type: 'string' } },
    ],
  },
  {
    method: 'POST',
    path: `${ORG}/webhooks/{id}/deliveries/{deliveryId}/redeliver`,
    operationId: 'redeliverWebhookDelivery',
    summary: 'Send a logged event again',
    tag: 'Webhooks',
    permission: 'webhook:manage',
  },
  {
    method: 'POST',
    path: `${ORG}/webhooks/{id}/rotate-secret`,
    operationId: 'rotateWebhookSecret',
    summary: 'Rotate the signing secret (the old one keeps signing for 24 hours)',
    tag: 'Webhooks',
    permission: 'webhook:manage',
    response: { description: '`{ doc, secret }`, the secret shown once', schema: anyObject },
  },
  {
    method: 'POST',
    path: `${ORG}/webhooks/{id}/test`,
    operationId: 'testWebhookEndpoint',
    summary: 'Send a signed `webhook.test` event now',
    tag: 'Webhooks',
    permission: 'webhook:manage',
  },

  // Not organization-scoped
  {
    method: 'GET',
    path: '/api/orgs/slug-available',
    operationId: 'checkOrganizationSlug',
    summary: 'Whether an organization slug is free',
    tag: 'Organizations',
    query: [{ name: 'slug', description: 'Slug to check', schema: { type: 'string' } }],
  },
]

// ---------------------------------------------------------------------------------------------
// Document assembly

/** How an operation may be called with an API key (`null`: signed-in users only). */
export function requiredScope(op: Pick<OperationSpec, 'method' | 'path'>): 'read' | 'write' | null {
  const match = /^\/api\/orgs\/\{orgId\}\/([^/]+)/.exec(op.path)
  if (!match || API_KEY_FORBIDDEN_SECTIONS.includes(match[1])) return null
  return isWriteMethod(op.method) ? 'write' : 'read'
}

const toSchema = (schema: z.ZodType | JsonSchema): JsonSchema => {
  if (schema instanceof z.ZodType) {
    const json = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchema
    delete json.$schema
    return json
  }
  return schema
}

const pathParams = (path: string) =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
    description: m[1] === 'orgId' ? 'Organization id' : undefined,
  }))

const errorRef = (name: string) => ({ $ref: `#/components/responses/${name}` })

function buildOperation(op: OperationSpec): Record<string, unknown> {
  const scope = requiredScope(op)
  const security = scope
    ? [{ session: [] }, { apiKeyBearer: [] }, { apiKeyHeader: [] }]
    : [{ session: [] }]
  const status = String(op.status ?? 200)
  const response = op.response ?? { description: 'Success', schema: anyObject }
  const responses: Record<string, unknown> = {
    [status]: {
      description: response.description,
      content: {
        [response.contentType ?? 'application/json']: { schema: response.schema ?? anyObject },
      },
    },
    ...(op.body ? { '400': errorRef('BadRequest') } : {}),
    '401': errorRef('Unauthorized'),
    '403': errorRef('Forbidden'),
    ...(/\{(?!orgId)[^}]+\}/.test(op.path) ? { '404': errorRef('NotFound') } : {}),
    '429': errorRef('TooManyRequests'),
  }

  const keyNote =
    scope === null
      ? 'API keys are refused here (403): sign in.'
      : `API keys need the \`${scope}\` scope.`
  return {
    operationId: op.operationId,
    summary: op.summary,
    description: [op.description, keyNote, op.permission ? `Permission: \`${op.permission}\`.` : '']
      .filter(Boolean)
      .join('\n\n'),
    tags: [op.tag],
    security,
    'x-marmot-api-key-scope': scope,
    ...(op.permission ? { 'x-marmot-permission': op.permission } : {}),
    parameters: [
      ...pathParams(op.path),
      ...(op.query ?? []).map((q) => ({ ...q, in: 'query', required: false })),
    ],
    ...(op.body
      ? {
          requestBody: {
            required: op.body.required ?? true,
            ...(op.body.description ? { description: op.body.description } : {}),
            content: {
              [op.body.contentType ?? 'application/json']: { schema: toSchema(op.body.schema) },
            },
          },
        }
      : {}),
    responses,
  }
}

const errorEnvelope: JsonSchema = {
  description:
    'Route handlers answer `{ errors: [{ message }] }` (Payload style) or `{ error }`; both carry a human-readable message in the request locale.',
  oneOf: [
    {
      type: 'object',
      properties: {
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: { message: { type: 'string' }, data: {} },
            required: ['message'],
          },
        },
      },
      required: ['errors'],
    },
    {
      type: 'object',
      properties: { error: { type: 'string' }, details: {} },
      required: ['error'],
    },
  ],
}

const errorResponse = (description: string, headers?: Record<string, unknown>) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
})

/** The management API document for an instance reachable at `serverUrl`. */
export function buildManagementOpenApi(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const op of OPERATIONS) {
    paths[op.path] ??= {}
    paths[op.path][op.method.toLowerCase()] = buildOperation(op)
  }
  const tags = [...new Set(OPERATIONS.map((op) => op.tag))].map((name) => ({ name }))

  return {
    openapi: '3.1.0',
    info: {
      title: 'Marmot management API',
      version: MANAGEMENT_API_VERSION,
      description: [
        'Organization-scoped endpoints behind the Marmot UI, usable by automation (CI, the CLI, Terraform, MCP).',
        'Authenticate with an organization API key (`Authorization: Bearer mk_…` or `X-API-Key: mk_…`, created under Settings → API keys) or a signed-in session.',
        '`read` keys may call `GET` operations and act as an organization viewer; `write` keys may also change things and act as a member. Keys never manage members, invitations, keys, single sign-on, billing or ownership.',
        'Each key may send `API_KEY_RATE_LIMIT` requests per minute (default 600), of which `API_KEY_WRITE_RATE_LIMIT` (default 60) may be writes; above that the API answers `429` with `Retry-After`.',
      ].join('\n\n'),
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: serverUrl.replace(/\/+$/, '') }],
    tags,
    paths,
    components: {
      securitySchemes: {
        apiKeyBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'mk_<prefix>_<secret>',
          description: 'Organization API key as a bearer token.',
        },
        apiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Organization API key in the X-API-Key header.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'payload-token',
          description:
            'Signed-in browser session (cookie requests must come from an allowed Origin). `Authorization: JWT <token>` from `POST /api/users/login` works too.',
        },
      },
      schemas: {
        Error: errorEnvelope,
        ApiKeyScope: { type: 'string', enum: [...API_KEY_SCOPES] },
        NewApiKey: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Plaintext key, shown exactly once' },
            doc: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                prefix: { type: 'string' },
                display: { type: 'string' },
                scope: { $ref: '#/components/schemas/ApiKeyScope' },
                active: { type: 'boolean' },
                status: { type: 'string', enum: ['active', 'inactive', 'expired'] },
                expiresAt: { type: ['string', 'null'], format: 'date-time' },
                lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
          required: ['key', 'doc'],
        },
      },
      responses: {
        BadRequest: errorResponse('The body or a parameter is invalid.'),
        Unauthorized: errorResponse(
          'No session or API key, or the key is unknown, disabled, expired or revoked.',
          { 'WWW-Authenticate': { schema: { type: 'string' } } },
        ),
        Forbidden: errorResponse(
          'Missing permission, a `read` key on a write operation, a key of another organization, or a route keys may not call.',
        ),
        NotFound: errorResponse('Unknown id, or one of another organization.'),
        TooManyRequests: errorResponse('Rate limit exceeded.', {
          'Retry-After': {
            description: 'Seconds until the next request may succeed.',
            schema: { type: 'integer' },
          },
          'X-RateLimit-Limit': { schema: { type: 'integer' } },
          'X-RateLimit-Remaining': { schema: { type: 'integer' } },
        }),
      },
    },
  }
}
