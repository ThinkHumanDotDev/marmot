/**
 * Reads of `on-call-schedules` and `escalation-policies` (#145) and their serialization. Member
 * reads pass the request user with `overrideAccess: false`; names of people, channels and
 * monitors are looked up in batches once the documents themselves were authorised.
 */
import type { Payload } from 'payload'

import {
  onCallAt,
  shiftsBetween,
  type EscalationPolicySummary,
  type EscalationTargetType,
  type LayerRestriction,
  type OnCallScheduleSummary,
  type OnCallShiftSummary,
  type RotationLayer,
  type RotationType,
  type RotationUnit,
  type ScheduleDefinition,
  type Weekday,
} from '@/lib/on-call'
import type { EscalationPolicy, OnCallSchedule, User } from '@/payload-types'
import type { RequestUser } from '@/server/monitors/http'

import { relId, type Id } from './ids'

/** How far ahead the dashboard and the API look for shifts. */
export const SHIFT_HORIZON_DAYS = 28
export const MAX_SHIFT_RANGE_DAYS = 92

const DAY_MS = 86_400_000

const personName = (user: Pick<User, 'name' | 'email'>): string =>
  user.name?.trim() || user.email || ''

/** A stored schedule as the input of the rotation maths. */
export function toScheduleDefinition(doc: OnCallSchedule): ScheduleDefinition {
  return {
    timezone: doc.timezone,
    layers: (doc.layers ?? []).map(
      (layer): RotationLayer => ({
        name: layer.name ?? null,
        timezone: layer.timezone ?? null,
        rotation: layer.rotation as RotationType,
        customLength: layer.customLength ?? null,
        customUnit: (layer.customUnit ?? 'days') as RotationUnit,
        handoffTime: layer.handoffTime,
        startDate: layer.startDate,
        members: (layer.members ?? []).map(relId).filter((id): id is Id => id !== null),
        restrictions: (layer.restrictions ?? []).map(
          (window): LayerRestriction => ({
            days: (window.days ?? []) as Weekday[],
            start: window.start,
            end: window.end,
          }),
        ),
      }),
    ),
    overrides: (doc.overrides ?? []).flatMap((override) => {
      const user = relId(override.user)
      return user === null ? [] : [{ user, start: override.start, end: override.end }]
    }),
  }
}

/** Who a schedule has on call at `at` (user id), or `null`. */
export const scheduleOnCallAt = (doc: OnCallSchedule, at: Date): string | null =>
  onCallAt(toScheduleDefinition(doc), at)?.userId ?? null

async function lookup<T extends { id: Id }>(
  payload: Payload,
  collection: 'users' | 'notifications' | 'on-call-schedules' | 'monitors',
  ids: Set<string>,
  select: Record<string, true>,
): Promise<Map<string, T>> {
  if (ids.size === 0) return new Map()
  const raw = [...ids].map((id) =>
    payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id,
  )
  const { docs } = await payload.find({
    collection,
    where: { id: { in: raw } },
    limit: ids.size,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select,
  })
  return new Map((docs as unknown as T[]).map((doc) => [String(doc.id), doc]))
}

/** Display names of users, by id. */
export async function userNames(
  payload: Payload,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const users = await lookup<Pick<User, 'id' | 'name' | 'email'>>(payload, 'users', new Set(ids), {
    name: true,
    email: true,
  })
  return new Map([...users].map(([id, user]) => [id, personName(user)]))
}

export async function serializeSchedules(
  payload: Payload,
  docs: OnCallSchedule[],
  at: Date = new Date(),
): Promise<OnCallScheduleSummary[]> {
  const definitions = docs.map(toScheduleDefinition)
  const current = definitions.map((definition) => {
    const shifts = shiftsBetween(
      definition,
      at,
      new Date(at.getTime() + MAX_SHIFT_RANGE_DAYS * DAY_MS),
    )
    const first = shifts[0]
    return first && first.start.getTime() === at.getTime() ? first : null
  })
  const ids = new Set<string>()
  for (const definition of definitions) {
    for (const layer of definition.layers) for (const id of layer.members) ids.add(String(id))
    for (const override of definition.overrides ?? []) ids.add(String(override.user))
  }
  const names = await userNames(payload, ids)
  const person = (id: Id) => ({ id: String(id), name: names.get(String(id)) ?? '' })

  return docs.map((doc, index) => {
    const definition = definitions[index]
    const shift = current[index]
    return {
      id: String(doc.id),
      name: doc.name,
      description: doc.description ?? null,
      timezone: doc.timezone,
      layers: definition.layers.map((layer) => ({
        name: layer.name ?? '',
        timezone: layer.timezone ?? null,
        rotation: layer.rotation,
        customLength: layer.customLength ?? null,
        customUnit: layer.customUnit ?? 'days',
        handoffTime: layer.handoffTime,
        startDate: layer.startDate,
        members: layer.members.map(person),
        restrictions: [...(layer.restrictions ?? [])],
      })),
      overrides: (doc.overrides ?? []).flatMap((override, i) => {
        const user = relId(override.user)
        if (user === null) return []
        return [
          {
            id: override.id ?? String(i),
            user: person(user),
            start: override.start,
            end: override.end,
            note: override.note ?? null,
          },
        ]
      }),
      onCall: shift
        ? {
            user: person(shift.userId),
            source: shift.source,
            // A shift reaching the horizon has no known end.
            until:
              shift.end.getTime() >= at.getTime() + MAX_SHIFT_RANGE_DAYS * DAY_MS
                ? null
                : shift.end.toISOString(),
          }
        : null,
    }
  })
}

/** Schedules of an organization as the user, by name. */
export async function listSchedules(
  payload: Payload,
  orgId: Id,
  user: RequestUser,
): Promise<OnCallSchedule[]> {
  const { docs } = await payload.find({
    collection: 'on-call-schedules',
    where: { organization: { equals: orgId } },
    sort: 'name',
    limit: 200,
    depth: 0,
    user,
    overrideAccess: false,
  })
  return docs as OnCallSchedule[]
}

/** A schedule as the user, only when it belongs to `orgId` (`null` otherwise, for a 404). */
export async function loadOrgSchedule(
  payload: Payload,
  user: RequestUser,
  orgId: Id,
  id: Id,
): Promise<OnCallSchedule | null> {
  try {
    const doc = (await payload.findByID({
      collection: 'on-call-schedules',
      id,
      depth: 0,
      user,
      overrideAccess: false,
    })) as OnCallSchedule
    return String(relId(doc.organization)) === String(orgId) ? doc : null
  } catch {
    return null
  }
}

/**
 * Final on-call shifts of the schedules between `from` and `to` (at most `MAX_SHIFT_RANGE_DAYS`),
 * optionally only those of one member, sorted by start.
 */
export async function shiftsOf(
  payload: Payload,
  schedules: OnCallSchedule[],
  from: Date,
  to: Date,
  options: { userId?: Id } = {},
): Promise<OnCallShiftSummary[]> {
  const end = new Date(Math.min(to.getTime(), from.getTime() + MAX_SHIFT_RANGE_DAYS * DAY_MS))
  const rows = schedules.flatMap((doc) =>
    shiftsBetween(toScheduleDefinition(doc), from, end, options).map((shift) => ({ doc, shift })),
  )
  const names = await userNames(payload, new Set(rows.map((row) => row.shift.userId)))
  return rows
    .sort((a, b) => a.shift.start.getTime() - b.shift.start.getTime())
    .map(({ doc, shift }) => ({
      scheduleId: String(doc.id),
      scheduleName: doc.name,
      user: { id: shift.userId, name: names.get(shift.userId) ?? '' },
      source: shift.source,
      start: shift.start.toISOString(),
      end: shift.end.toISOString(),
    }))
}

type PolicyTarget = NonNullable<NonNullable<EscalationPolicy['steps']>[number]['targets']>[number]

const targetId = (target: PolicyTarget) =>
  relId(
    target.type === 'schedule'
      ? target.schedule
      : target.type === 'user'
        ? target.user
        : target.channel,
  )

export async function serializePolicies(
  payload: Payload,
  docs: EscalationPolicy[],
): Promise<EscalationPolicySummary[]> {
  const ids = { schedule: new Set<string>(), user: new Set<string>(), channel: new Set<string>() }
  for (const doc of docs) {
    for (const step of doc.steps ?? []) {
      for (const target of step.targets ?? []) {
        const id = targetId(target)
        if (id !== null) ids[target.type as EscalationTargetType].add(String(id))
      }
    }
  }
  const policyIds = docs.map((doc) => doc.id)
  const [schedules, users, channels, monitors] = await Promise.all([
    lookup<{ id: Id; name: string }>(payload, 'on-call-schedules', ids.schedule, { name: true }),
    userNames(payload, ids.user),
    lookup<{ id: Id; name: string }>(payload, 'notifications', ids.channel, { name: true }),
    policyIds.length === 0
      ? Promise.resolve({ docs: [] as { id: Id; name: string; escalationPolicy?: unknown }[] })
      : payload.find({
          collection: 'monitors',
          where: { escalationPolicy: { in: policyIds } },
          limit: 1000,
          pagination: false,
          depth: 0,
          overrideAccess: true,
          select: { name: true, escalationPolicy: true },
        }),
  ])
  const name = (type: EscalationTargetType, id: string): string =>
    type === 'user'
      ? (users.get(id) ?? '')
      : ((type === 'schedule' ? schedules : channels).get(id)?.name ?? '')

  return docs.map((doc) => ({
    id: String(doc.id),
    name: doc.name,
    description: doc.description ?? null,
    repeat: doc.repeat ?? 0,
    steps: (doc.steps ?? []).map((step) => ({
      escalateAfterMinutes: step.escalateAfterMinutes,
      targets: (step.targets ?? []).flatMap((target) => {
        const id = targetId(target)
        if (id === null) return []
        const type = target.type as EscalationTargetType
        return [{ type, id: String(id), name: name(type, String(id)) }]
      }),
    })),
    monitors: (monitors.docs as { id: Id; name: string; escalationPolicy?: unknown }[])
      .filter((monitor) => String(relId(monitor.escalationPolicy)) === String(doc.id))
      .map((monitor) => ({ id: String(monitor.id), name: monitor.name })),
  }))
}

/** Policies of an organization as the user, by name. */
export async function listPolicies(
  payload: Payload,
  orgId: Id,
  user: RequestUser,
): Promise<EscalationPolicy[]> {
  const { docs } = await payload.find({
    collection: 'escalation-policies',
    where: { organization: { equals: orgId } },
    sort: 'name',
    limit: 200,
    depth: 0,
    user,
    overrideAccess: false,
  })
  return docs as EscalationPolicy[]
}

export async function loadOrgPolicy(
  payload: Payload,
  user: RequestUser,
  orgId: Id,
  id: Id,
): Promise<EscalationPolicy | null> {
  try {
    const doc = (await payload.findByID({
      collection: 'escalation-policies',
      id,
      depth: 0,
      user,
      overrideAccess: false,
    })) as EscalationPolicy
    return String(relId(doc.organization)) === String(orgId) ? doc : null
  } catch {
    return null
  }
}
