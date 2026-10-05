/**
 * Helpers shared by the `/api/orgs/[orgId]/notifications/**` route handlers.
 */
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { canInOrg } from '@/access/overrides'
import { can, isSuperadmin, type OrgId, type Permission } from '@/access/permissions'
import type { Notification, User } from '@/payload-types'
import {
  describeNotificationProviders,
  type NotificationProviderDescriptor,
} from '@/server/notification-providers'

export type OrgRequestUser = User & { collection: 'users' }

export interface OrgRequestContext {
  payload: Payload
  user: OrgRequestUser
  orgId: OrgId
}

export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return Response.json({ error: message, ...extra }, { status })
}

/** Postgres/SQLite use numeric ids, MongoDB uses strings. */
export function parseDocId(payload: Payload, raw: string): OrgId {
  return payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw
}

/**
 * Authenticate the request and check `permission` inside the organization named in the URL.
 * Returns a `Response` (401/403) when the caller may not proceed.
 */
export async function resolveOrgRequest(
  request: Request,
  rawOrgId: string,
  permission: Permission,
): Promise<OrgRequestContext | Response> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: request.headers })
  if (!user || user.collection !== 'users') return jsonError(401, 'Unauthorized')

  const orgId = parseDocId(payload, rawOrgId)
  if (!(await canInOrg(payload, user, orgId, permission))) return jsonError(403, 'Forbidden')

  return { payload, user: user as OrgRequestUser, orgId }
}

/** Read a JSON body, or `null` when it is missing/invalid. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === 'object' ? (body as T) : null
  } catch {
    return null
  }
}

let descriptorCache: NotificationProviderDescriptor[] | undefined

export function getProviderDescriptors(): NotificationProviderDescriptor[] {
  descriptorCache ??= describeNotificationProviders()
  return descriptorCache
}

/** Secret config keys per provider (webhook URLs, tokens, passwords). */
function secretKeys(type: string): string[] {
  const descriptor = getProviderDescriptors().find((d) => d.name === type)
  return descriptor ? descriptor.fields.filter((f) => f.secret).map((f) => f.name) : []
}

/** Value sent instead of a secret to users who may read but not edit channels. */
export const REDACTED = '••••••••'

/**
 * Channel document as the UI receives it. Secrets are masked for users without
 * `notification:update` (members may see channels exist, admins may edit them).
 */
export function toClientNotification(
  doc: Notification,
  user: OrgRequestUser,
  orgId: OrgId,
): Notification {
  const canEdit = isSuperadmin(user) || can(user, orgId, 'notification:update')
  if (canEdit) return doc
  const config =
    doc.config && typeof doc.config === 'object' && !Array.isArray(doc.config)
      ? { ...(doc.config as Record<string, unknown>) }
      : {}
  for (const key of secretKeys(doc.type)) {
    if (config[key] !== undefined && config[key] !== '') config[key] = REDACTED
  }
  return { ...doc, config }
}

/** Payload REST-style error body → first message, for 400 responses. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const data = (error as { data?: { errors?: { message?: string; path?: string }[] } }).data
    const first = data?.errors?.[0]
    if (first?.message) return first.path ? `${first.path}: ${first.message}` : first.message
    if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
  }
  return String(error)
}

/** HTTP status for a thrown Payload error (`APIError.status`), defaulting to 400. */
export function errorStatus(error: unknown, fallback = 400): number {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' && status >= 400 && status < 600 ? status : fallback
}

/** Fields a client may set; everything else (`lastSentAt`, `organization`, …) is server-owned. */
export type NotificationInput = Partial<
  Pick<Notification, 'name' | 'type' | 'config' | 'isDefault' | 'applyExisting' | 'active'>
>

export function pickInput(body: Record<string, unknown>): NotificationInput {
  const input: NotificationInput = {}
  if (typeof body.name === 'string') input.name = body.name.trim()
  if (typeof body.type === 'string') input.type = body.type
  if (body.config !== undefined) input.config = body.config as Notification['config']
  if (typeof body.isDefault === 'boolean') input.isDefault = body.isDefault
  if (typeof body.applyExisting === 'boolean') input.applyExisting = body.applyExisting
  if (typeof body.active === 'boolean') input.active = body.active
  return input
}
