/**
 * Endpoint management behind `/api/orgs/:orgId/webhooks/**` and Settings → Webhooks. The routes
 * authorise (`webhook:read` / `webhook:manage`); these functions load documents as the user, so
 * an endpoint of another organization is "not found", and write server-only fields (the secret)
 * with `overrideAccess: true` while still naming the user as the audit actor.
 */
import type { Payload, Where } from 'payload'
import { z } from 'zod'

import type { OrgId } from '@/access/permissions'
import { WEBHOOK_TEST_EVENT, isWebhookEventSelector } from '@/lib/webhook-events'
import type { WebhookDeliveryRow, WebhookEndpointRow } from '@/lib/webhooks'
import type { User, WebhookDelivery, WebhookEndpoint } from '@/payload-types'

import { deliverNow, SECRET_ROTATION_GRACE_MS, type WebhookEnvelope } from './deliver'
import { buildEnvelope, createDelivery, toDocId } from './events'
import { toDeliveryRow, toEndpointRow } from './rows'
import { generateWebhookSecret } from './signature'
import { WEBHOOK_URL_MAX_LENGTH } from './url'

type RequestUser = User & { collection: 'users' }

export interface WebhookContext {
  payload: Payload
  user: RequestUser
  orgId: OrgId
}

const events = z
  .array(z.string().refine(isWebhookEventSelector, { message: 'unknown event type' }))
  .min(1, 'select at least one event')
  .max(500)

export const createEndpointSchema = z.object({
  url: z.string().trim().min(1).max(WEBHOOK_URL_MAX_LENGTH),
  description: z.string().trim().max(200).nullable().optional(),
  events,
  active: z.boolean().optional(),
})

export const updateEndpointSchema = z.object({
  url: z.string().trim().min(1).max(WEBHOOK_URL_MAX_LENGTH).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  events: events.optional(),
  active: z.boolean().optional(),
})

const same = (a: unknown, b: unknown) => String(a) === String(b)

const orgOf = (doc: { organization: unknown }) =>
  typeof doc.organization === 'object' && doc.organization !== null
    ? (doc.organization as { id: OrgId }).id
    : (doc.organization as OrgId)

/** The endpoint when the user may read it and it belongs to the organization in the URL. */
export async function loadOrgEndpoint(
  ctx: WebhookContext,
  rawId: string,
): Promise<WebhookEndpoint | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'webhook-endpoints',
      id: toDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as WebhookEndpoint
    return same(orgOf(doc), ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

export async function listEndpoints(ctx: WebhookContext): Promise<WebhookEndpointRow[]> {
  const { docs } = await ctx.payload.find({
    collection: 'webhook-endpoints',
    where: { organization: { equals: ctx.orgId } },
    sort: '-createdAt',
    depth: 0,
    limit: 200,
    user: ctx.user,
    overrideAccess: false,
  })
  return (docs as WebhookEndpoint[]).map(toEndpointRow)
}

/** Creates an endpoint; the response is the only time its secret is shown. */
export async function createEndpoint(
  ctx: WebhookContext,
  input: z.infer<typeof createEndpointSchema>,
): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
  const secret = generateWebhookSecret()
  const doc = (await ctx.payload.create({
    collection: 'webhook-endpoints',
    data: {
      organization: ctx.orgId as WebhookEndpoint['organization'],
      url: input.url,
      description: input.description ?? null,
      events: input.events,
      active: input.active ?? true,
      secret,
      createdBy: ctx.user.id as WebhookEndpoint['createdBy'],
    },
    depth: 0,
    // The permission was checked by the route; `secret` and `createdBy` are server-only fields.
    user: ctx.user,
    overrideAccess: true,
  })) as WebhookEndpoint
  return { endpoint: toEndpointRow(doc), secret }
}

export async function updateEndpoint(
  ctx: WebhookContext,
  endpoint: WebhookEndpoint,
  input: z.infer<typeof updateEndpointSchema>,
): Promise<WebhookEndpointRow> {
  const doc = (await ctx.payload.update({
    collection: 'webhook-endpoints',
    id: endpoint.id,
    data: input,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })) as WebhookEndpoint
  return toEndpointRow(doc)
}

export async function deleteEndpoint(ctx: WebhookContext, endpoint: WebhookEndpoint) {
  await ctx.payload.delete({
    collection: 'webhook-endpoints',
    id: endpoint.id,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
}

/**
 * New signing secret, shown once. The previous one keeps signing next to it for
 * `SECRET_ROTATION_GRACE_MS` (24 h) so receivers can switch without dropping deliveries.
 */
export async function rotateSecret(
  ctx: WebhookContext,
  endpoint: WebhookEndpoint,
): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
  const current = (await ctx.payload.findByID({
    collection: 'webhook-endpoints',
    id: endpoint.id,
    depth: 0,
    overrideAccess: true,
  })) as WebhookEndpoint
  const secret = generateWebhookSecret()
  const doc = (await ctx.payload.update({
    collection: 'webhook-endpoints',
    id: endpoint.id,
    data: {
      secret,
      previousSecret: current.secret ?? null,
      previousSecretExpiresAt: new Date(Date.now() + SECRET_ROTATION_GRACE_MS).toISOString(),
    },
    depth: 0,
    user: ctx.user,
    overrideAccess: true,
  })) as WebhookEndpoint
  return { endpoint: toEndpointRow(doc), secret }
}

/** Sends a `webhook.test` event now and returns its log entry. */
export async function sendTestEvent(
  ctx: WebhookContext,
  endpoint: WebhookEndpoint,
): Promise<WebhookDeliveryRow | null> {
  const envelope = buildEnvelope({
    type: WEBHOOK_TEST_EVENT,
    orgId: ctx.orgId,
    data: { endpoint: { id: String(endpoint.id), url: endpoint.url }, test: true },
  })
  const delivery = await createDelivery(ctx.payload, endpoint, envelope, 'test')
  const doc = await deliverNow(ctx.payload, delivery.id)
  return doc ? toDeliveryRow(doc) : null
}

/** Sends the event of a logged delivery again (same event id, new delivery id). */
export async function redeliver(
  ctx: WebhookContext,
  endpoint: WebhookEndpoint,
  original: WebhookDelivery,
): Promise<WebhookDeliveryRow | null> {
  const delivery = await createDelivery(
    ctx.payload,
    endpoint,
    original.body as unknown as WebhookEnvelope,
    'redelivery',
    original.id,
  )
  const doc = await deliverNow(ctx.payload, delivery.id)
  return doc ? toDeliveryRow(doc) : null
}

/** A delivery of `endpoint`, read as the user. */
export async function loadEndpointDelivery(
  ctx: WebhookContext,
  endpoint: WebhookEndpoint,
  rawId: string,
): Promise<WebhookDelivery | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'webhook-deliveries',
      id: toDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as WebhookDelivery
    const owner =
      typeof doc.endpoint === 'object' && doc.endpoint !== null ? doc.endpoint.id : doc.endpoint
    return same(owner, endpoint.id) ? doc : null
  } catch {
    return null
  }
}

export const DELIVERY_PAGE_SIZE = 25

export async function listDeliveries(
  ctx: WebhookContext,
  endpoint: WebhookEndpoint,
  { page = 1, state }: { page?: number; state?: string | null } = {},
): Promise<{ docs: WebhookDeliveryRow[]; page: number; totalPages: number; totalDocs: number }> {
  const where: Where = { endpoint: { equals: endpoint.id } }
  const result = await ctx.payload.find({
    collection: 'webhook-deliveries',
    where: state ? { and: [where, { state: { equals: state } }] } : where,
    sort: '-createdAt',
    depth: 0,
    page,
    limit: DELIVERY_PAGE_SIZE,
    user: ctx.user,
    overrideAccess: false,
  })
  return {
    docs: (result.docs as WebhookDelivery[]).map(toDeliveryRow),
    page: result.page ?? page,
    totalPages: result.totalPages,
    totalDocs: result.totalDocs,
  }
}
