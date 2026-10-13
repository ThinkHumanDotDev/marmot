/**
 * Shared plumbing of `/api/orgs/:orgId/on-call/**` (#145): request bodies become collection data.
 * Authentication and authorisation come from `src/server/monitors/http.ts`.
 */
import type { Payload } from 'payload'

import type {
  PolicyInput,
  ScheduleInput,
  UpdatePolicyInput,
  UpdateScheduleInput,
} from '@/lib/validation/on-call'
import type { Monitor } from '@/payload-types'
import { parseId, type RequestUser } from '@/server/monitors/http'

import { relId, type Id } from './ids'

const toId = (payload: Payload, value: string | number): Id =>
  typeof value === 'number' ? value : parseId(payload, value)

type Layers = NonNullable<ScheduleInput['layers']>
type Overrides = NonNullable<ScheduleInput['overrides']>
type Steps = PolicyInput['steps']

const layersData = (payload: Payload, layers: Layers) =>
  layers.map((layer) => ({
    name: layer.name || null,
    timezone: layer.timezone || null,
    rotation: layer.rotation ?? 'weekly',
    customLength: layer.rotation === 'custom' ? (layer.customLength ?? null) : null,
    customUnit: layer.customUnit ?? 'days',
    handoffTime: layer.handoffTime ?? '09:00',
    startDate: layer.startDate,
    members: layer.members.map((member) => toId(payload, member)),
    restrictions: (layer.restrictions ?? []).map((window) => ({
      ...window,
      days: [...window.days],
    })),
  }))

const overridesData = (payload: Payload, overrides: Overrides) =>
  overrides.map((override) => ({
    user: toId(payload, override.user),
    start: new Date(override.start).toISOString(),
    end: new Date(override.end).toISOString(),
    note: override.note || null,
  }))

const stepsData = (payload: Payload, steps: Steps) =>
  steps.map((step) => ({
    escalateAfterMinutes: step.escalateAfterMinutes ?? 10,
    targets: step.targets.map((target) => ({
      type: target.type,
      [target.type]: toId(payload, target.id),
    })),
  }))

export function scheduleData(
  payload: Payload,
  input: ScheduleInput | UpdateScheduleInput,
  orgId?: Id,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (orgId !== undefined) data.organization = orgId
  if (input.name !== undefined) data.name = input.name
  if (input.description !== undefined) data.description = input.description || null
  if (input.timezone !== undefined) data.timezone = input.timezone
  if (input.layers !== undefined) data.layers = layersData(payload, input.layers)
  if (input.overrides !== undefined) data.overrides = overridesData(payload, input.overrides)
  return data
}

export function policyData(
  payload: Payload,
  input: PolicyInput | UpdatePolicyInput,
  orgId?: Id,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (orgId !== undefined) data.organization = orgId
  if (input.name !== undefined) data.name = input.name
  if (input.description !== undefined) data.description = input.description || null
  if (input.repeat !== undefined) data.repeat = input.repeat
  if (input.steps !== undefined) data.steps = stepsData(payload, input.steps)
  return data
}

/**
 * Makes exactly `monitorIds` escalate with the policy: monitors of the organization that are listed
 * get it, those that had it and are no longer listed lose it. Writes as the user, so monitor access
 * applies; unknown or foreign ids are ignored.
 */
export async function assignPolicyMonitors(
  payload: Payload,
  user: RequestUser,
  orgId: Id,
  policyId: Id,
  monitorIds: (string | number)[],
): Promise<void> {
  const wanted = new Set(monitorIds.map(String))
  const { docs } = await payload.find({
    collection: 'monitors',
    where: {
      and: [
        { organization: { equals: orgId } },
        {
          or: [
            { escalationPolicy: { equals: policyId } },
            { id: { in: monitorIds.map((value) => toId(payload, value)) } },
          ],
        },
      ],
    },
    limit: 1000,
    pagination: false,
    depth: 0,
    user,
    overrideAccess: false,
    select: { escalationPolicy: true },
  })
  for (const monitor of docs as Pick<Monitor, 'id' | 'escalationPolicy'>[]) {
    const has = String(relId(monitor.escalationPolicy)) === String(policyId)
    const should = wanted.has(String(monitor.id))
    if (has === should) continue
    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: { escalationPolicy: (should ? policyId : null) as Monitor['escalationPolicy'] },
      depth: 0,
      user,
      overrideAccess: false,
    })
  }
}
