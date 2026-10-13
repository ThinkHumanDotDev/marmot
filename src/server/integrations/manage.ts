/**
 * Integration management behind `/api/orgs/:orgId/integrations/**` and Settings → Integrations
 * (#152). The routes authorise (`integration:read` / `integration:manage`); these functions load
 * documents as the user, so an integration of another organization is "not found", and write the
 * server-only token fields with `overrideAccess: true`.
 */
import type { Payload } from 'payload'
import { z } from 'zod'

import type { OrgId } from '@/access/permissions'
import { env } from '@/env'
import { DECLARED_INCIDENT_SEVERITIES } from '@/lib/declared-incidents'
import {
  INTEGRATION_FORMATS,
  MAX_RULES,
  RULE_IMPACTS,
  RULE_INCIDENT_MODES,
  RULE_MATCH_OPERATORS,
  type IntegrationEventRow,
  type IntegrationRow,
} from '@/lib/inbound-alerts'
import type { Integration, IntegrationEvent, User } from '@/payload-types'
import { AUDIT_VERB_CONTEXT } from '@/server/audit/context'
import { pushEmailAddress } from '@/lib/push-email'
import { inboundEmailDomain } from '@/server/push/inbound-config'

import { generateIntegrationToken } from './token'

type RequestUser = User & { collection: 'users' }

export interface IntegrationContext {
  payload: Payload
  user: RequestUser
  orgId: OrgId
}

const id = z.union([z.string().trim().min(1).max(64), z.number().int()])
const path = z.string().trim().max(200)

const ruleSchema = z.object({
  id: z.string().trim().max(64).nullable().optional(),
  name: z.string().trim().max(100).nullable().optional(),
  enabled: z.boolean().optional(),
  matchField: z.string().trim().max(100).nullable().optional(),
  matchOperator: z.enum(RULE_MATCH_OPERATORS).optional(),
  matchValue: z.string().trim().max(200).nullable().optional(),
  updateComponent: z.boolean().optional(),
  statusPage: id.nullable().optional(),
  component: z.string().trim().max(64).nullable().optional(),
  impact: z.enum(RULE_IMPACTS).optional(),
  incident: z.enum(RULE_INCIDENT_MODES).optional(),
  severity: z.enum(DECLARED_INCIDENT_SEVERITIES).optional(),
  monitor: id.nullable().optional(),
})

const genericSchema = z.object({
  alertsPath: path.optional(),
  titlePath: path.optional(),
  statusPath: path.optional(),
  severityPath: path.optional(),
  dedupKeyPath: path.optional(),
  descriptionPath: path.optional(),
  resolvedValues: z.string().trim().max(200).optional(),
})

export const createIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  format: z.enum(INTEGRATION_FORMATS),
  active: z.boolean().optional(),
  generic: genericSchema.optional(),
  emailResolvedKeyword: z.string().trim().max(100).optional(),
  rules: z.array(ruleSchema).max(MAX_RULES).optional(),
})

export const updateIntegrationSchema = createIntegrationSchema.partial()

export type IntegrationInput = z.infer<typeof createIntegrationSchema>

const relKey = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return 'id' in value ? String((value as { id: unknown }).id) : null
  return String(value)
}

export function toIntegrationRow(doc: Integration): IntegrationRow {
  return {
    id: String(doc.id),
    name: doc.name,
    format: doc.format,
    active: doc.active !== false,
    tokenPrefix: doc.tokenPrefix,
    generic: doc.generic ?? {},
    emailResolvedKeyword: doc.emailResolvedKeyword ?? '',
    rules: (doc.rules ?? []).map((rule) => ({
      id: String(rule.id ?? ''),
      name: rule.name ?? '',
      enabled: rule.enabled !== false,
      matchField: rule.matchField ?? '',
      matchOperator: rule.matchOperator ?? 'equals',
      matchValue: rule.matchValue ?? '',
      updateComponent: rule.updateComponent === true,
      statusPage: relKey(rule.statusPage),
      component: rule.component ?? null,
      impact: rule.impact ?? 'partial_outage',
      incident: rule.incident ?? 'none',
      severity: rule.severity ?? 'major',
      monitor: relKey(rule.monitor),
    })),
    lastEventAt: doc.lastEventAt ?? null,
    createdAt: doc.createdAt,
  }
}

const toEventRow = (doc: IntegrationEvent): IntegrationEventRow => ({
  id: String(doc.id),
  receivedAt: doc.receivedAt,
  source: doc.source,
  alertCount: doc.alertCount ?? 0,
  droppedCount: doc.droppedCount ?? 0,
  payload: doc.payload ?? '',
  results: doc.results ?? [],
})

/** Where the integration receives alerts (shown with the token, once). */
export function integrationEndpoints(token: string): { url: string; email: string | null } {
  return {
    url: `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/api/inbound/${token}`,
    email: pushEmailAddress(token, inboundEmailDomain()),
  }
}

/** JSON ids: numbers pass, numeric strings become numbers on Postgres. */
const docId = (payload: Payload, value: string | number | null | undefined) =>
  value === null || value === undefined || value === ''
    ? null
    : typeof value === 'number'
      ? value
      : payload.db.defaultIDType === 'number' && /^\d+$/.test(value)
        ? Number(value)
        : value

function toData(payload: Payload, input: Partial<IntegrationInput>) {
  const data: Record<string, unknown> = {}
  for (const key of ['name', 'format', 'active', 'generic', 'emailResolvedKeyword'] as const) {
    if (input[key] !== undefined) data[key] = input[key]
  }
  if (input.rules !== undefined) {
    data.rules = input.rules.map(({ id: rowId, statusPage, monitor, ...rule }) => ({
      ...(rowId ? { id: rowId } : {}),
      ...rule,
      statusPage: docId(payload, statusPage),
      monitor: docId(payload, monitor),
      component: rule.component || null,
    }))
  }
  return data
}

const same = (a: unknown, b: unknown) => relKey(a) === relKey(b)

export async function loadOrgIntegration(
  ctx: IntegrationContext,
  rawId: string,
): Promise<Integration | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'integrations',
      id: docId(ctx.payload, rawId) as string | number,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as Integration
    return same(doc.organization, ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

export async function listIntegrations(ctx: IntegrationContext): Promise<IntegrationRow[]> {
  const { docs } = await ctx.payload.find({
    collection: 'integrations',
    where: { organization: { equals: ctx.orgId } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: ctx.user,
    overrideAccess: false,
  })
  return (docs as Integration[]).map(toIntegrationRow)
}

/** Creates an integration; the response is the only time its token is shown. */
export async function createIntegration(
  ctx: IntegrationContext,
  input: IntegrationInput,
): Promise<{ integration: IntegrationRow; token: string }> {
  const generated = generateIntegrationToken()
  const doc = (await ctx.payload.create({
    collection: 'integrations',
    data: {
      ...toData(ctx.payload, input),
      organization: ctx.orgId,
      tokenHash: generated.hash,
      tokenPrefix: generated.prefix,
      createdBy: ctx.user.id,
    } as Partial<Integration> as Integration,
    depth: 0,
    // The permission was checked by the route; the token fields are server-only.
    user: ctx.user,
    overrideAccess: true,
  })) as Integration
  return { integration: toIntegrationRow(doc), token: generated.token }
}

export async function updateIntegration(
  ctx: IntegrationContext,
  integration: Integration,
  input: Partial<IntegrationInput>,
): Promise<IntegrationRow> {
  const doc = (await ctx.payload.update({
    collection: 'integrations',
    id: integration.id,
    data: toData(ctx.payload, input),
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })) as Integration
  return toIntegrationRow(doc)
}

export async function deleteIntegration(ctx: IntegrationContext, integration: Integration) {
  for (const collection of ['integration-events', 'integration-alerts'] as const) {
    await ctx.payload.delete({
      collection,
      where: { integration: { equals: integration.id } },
      depth: 0,
      overrideAccess: true,
    })
  }
  await ctx.payload.delete({
    collection: 'integrations',
    id: integration.id,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
}

/** A new token, shown once; the old one stops working immediately. */
export async function rotateIntegrationToken(
  ctx: IntegrationContext,
  integration: Integration,
): Promise<{ integration: IntegrationRow; token: string }> {
  const generated = generateIntegrationToken()
  const doc = (await ctx.payload.update({
    collection: 'integrations',
    id: integration.id,
    data: { tokenHash: generated.hash, tokenPrefix: generated.prefix },
    depth: 0,
    user: ctx.user,
    overrideAccess: true,
    context: {
      integrationBookkeeping: true,
      [AUDIT_VERB_CONTEXT]: { integration: 'integration.token_rotated' },
    },
  })) as Integration
  return { integration: toIntegrationRow(doc), token: generated.token }
}

export async function listIntegrationEvents(
  ctx: IntegrationContext,
  integration: Integration,
  page = 1,
): Promise<{ docs: IntegrationEventRow[]; page: number; totalPages: number; totalDocs: number }> {
  const result = await ctx.payload.find({
    collection: 'integration-events',
    where: { integration: { equals: integration.id } },
    sort: '-receivedAt',
    depth: 0,
    limit: 25,
    page,
    user: ctx.user,
    overrideAccess: false,
  })
  return {
    docs: (result.docs as IntegrationEvent[]).map(toEventRow),
    page: result.page ?? page,
    totalPages: result.totalPages,
    totalDocs: result.totalDocs,
  }
}
