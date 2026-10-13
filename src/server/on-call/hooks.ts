/**
 * Collection hooks of `on-call-schedules` and `escalation-policies` (#145). The `beforeChange`
 * hooks keep every writer (route handlers, the REST API, the admin panel) honest: the organization
 * never changes, times and zones are valid, members are members of the organization, and schedules
 * and channels named by a policy belong to it. The `afterChange` / `afterDelete` hooks announce the
 * change over realtime once the transaction commits.
 */
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  PayloadRequest,
} from 'payload'

import { getUserRole } from '@/access/permissions'
import { afterCommit } from '@/db/after-commit'
import {
  isHandoffTime,
  isRestrictionEnd,
  isValidDateOnly,
  isValidTimeZone,
  type EscalationTargetType,
} from '@/lib/on-call'
import { childLogger } from '@/lib/logger'
import type { EscalationPolicy, OnCallSchedule } from '@/payload-types'
import { apiError } from '@/server/errors'
import { emitOnCall } from '@/server/realtime/emitter'

import { relId, type Id } from './ids'

const log = childLogger('on-call:hooks')

const invalid = () => apiError('onCallInvalid', 400)

function organizationOf(
  data: { organization?: unknown },
  originalDoc: { organization?: unknown } | undefined,
): Id {
  const orgId = relId(originalDoc ? originalDoc.organization : data.organization)
  if (orgId === null) throw apiError('validationFailed', 400)
  return orgId
}

const sameId = (a: unknown, b: unknown) => String(relId(a) ?? '') === String(relId(b) ?? '')

/** Throws unless every user id belongs to a member of `orgId`. */
async function assertMembers(req: PayloadRequest, orgId: Id, ids: unknown[]): Promise<void> {
  const wanted = [...new Set(ids.map((value) => relId(value)).filter((id) => id !== null))]
  if (wanted.length === 0) return
  const { docs } = await req.payload.find({
    collection: 'users',
    where: { id: { in: wanted } },
    limit: wanted.length,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    req,
  })
  const members = new Set(
    docs.filter((user) => getUserRole(user, orgId)).map((user) => String(user.id)),
  )
  if (wanted.some((id) => !members.has(String(id)))) throw apiError('onCallNotMember', 400)
}

async function assertInOrg(
  req: PayloadRequest,
  collection: 'on-call-schedules' | 'notifications',
  id: unknown,
  orgId: Id,
): Promise<void> {
  const docId = relId(id)
  if (docId === null) throw invalid()
  const doc = await req.payload
    .findByID({ collection, id: docId, depth: 0, overrideAccess: true, req })
    .catch(() => null)
  if (!doc || !sameId(doc.organization, orgId)) throw invalid()
}

export const onCallScheduleBeforeChange: CollectionBeforeChangeHook<OnCallSchedule> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  const prev = operation === 'update' ? originalDoc : undefined
  const orgId = organizationOf(data, prev)
  if (prev) data.organization = prev.organization
  const timezone = data.timezone ?? prev?.timezone
  if (!isValidTimeZone(timezone)) throw invalid()

  const layers = data.layers ?? prev?.layers ?? []
  const users: unknown[] = []
  for (const layer of layers) {
    if (layer.timezone && !isValidTimeZone(layer.timezone)) throw invalid()
    if (!isHandoffTime(layer.handoffTime) || !isValidDateOnly(layer.startDate)) throw invalid()
    if (layer.rotation === 'custom' && !(layer.customLength && layer.customLength >= 1)) {
      throw invalid()
    }
    for (const window of layer.restrictions ?? []) {
      if (!isHandoffTime(window.start) || !isRestrictionEnd(window.end)) throw invalid()
      if (!window.days?.length) throw invalid()
    }
    users.push(...(layer.members ?? []))
  }
  for (const override of data.overrides ?? []) {
    if (Date.parse(override.end) <= Date.parse(override.start)) throw invalid()
    users.push(override.user)
  }
  if (data.layers || data.overrides) await assertMembers(req, orgId, users)
  return data
}

const TARGET_FIELD: Record<EscalationTargetType, 'schedule' | 'user' | 'channel'> = {
  schedule: 'schedule',
  user: 'user',
  channel: 'channel',
}

export const escalationPolicyBeforeChange: CollectionBeforeChangeHook<EscalationPolicy> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  const prev = operation === 'update' ? originalDoc : undefined
  const orgId = organizationOf(data, prev)
  if (prev) data.organization = prev.organization
  if (!data.steps) return data
  if (data.steps.length === 0) throw invalid()
  const users: unknown[] = []
  for (const step of data.steps) {
    if (!step.targets?.length) throw invalid()
    for (const target of step.targets) {
      const field = TARGET_FIELD[target.type as EscalationTargetType]
      if (!field || relId(target[field]) === null) throw invalid()
      // Only the field of the target's type is kept.
      for (const other of Object.values(TARGET_FIELD)) if (other !== field) target[other] = null
      if (field === 'user') users.push(target.user)
      else if (field === 'schedule')
        await assertInOrg(req, 'on-call-schedules', target.schedule, orgId)
      else await assertInOrg(req, 'notifications', target.channel, orgId)
    }
  }
  await assertMembers(req, orgId, users)
  return data
}

export const onCallAfterChange =
  (kind: 'schedule' | 'policy'): CollectionAfterChangeHook =>
  async ({ doc, req }) => {
    const orgId = relId(doc.organization)
    if (orgId !== null) {
      await afterCommit(req, () => {
        try {
          emitOnCall(orgId, kind, doc.id)
        } catch (err) {
          log.warn({ err, kind, id: doc.id }, 'failed to publish the on-call change')
        }
      })
    }
    return doc
  }

export const onCallAfterDelete =
  (kind: 'schedule' | 'policy'): CollectionAfterDeleteHook =>
  async ({ doc, req }) => {
    const orgId = relId(doc.organization)
    if (orgId !== null) await afterCommit(req, () => emitOnCall(orgId, kind, doc.id))
    return doc
  }
