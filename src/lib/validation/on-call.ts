/**
 * Request bodies of `/api/orgs/:orgId/on-call/**` (#145), shared by the route handlers and the
 * dashboard forms. The collection hooks (`src/server/on-call/hooks.ts`) check membership and
 * organization of every referenced document on every write; these schemas shape the input.
 */
import { z } from 'zod'

import {
  ESCALATION_TARGET_TYPES,
  isHandoffTime,
  isRestrictionEnd,
  isValidDateOnly,
  isValidTimeZone,
  MAX_ESCALATION_REPEATS,
  ROTATION_TYPES,
  ROTATION_UNITS,
  WEEKDAYS,
} from '@/lib/on-call'

/** A relationship id from JSON: Postgres ids arrive as numbers or numeric strings, Mongo as strings. */
const id = z.union([z.string().min(1).max(64), z.number().int().positive()])

const timeZone = z.string().trim().min(1).max(64).refine(isValidTimeZone, 'Unknown time zone')
const time = z.string().refine(isHandoffTime, 'Use HH:mm')

export const restrictionSchema = z.object({
  days: z.array(z.enum(WEEKDAYS)).min(1).max(7),
  start: time,
  end: z.string().refine(isRestrictionEnd, 'Use HH:mm'),
})

export const layerSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    timezone: timeZone.nullish(),
    rotation: z.enum(ROTATION_TYPES).default('weekly'),
    customLength: z.number().int().min(1).max(8760).nullish(),
    customUnit: z.enum(ROTATION_UNITS).default('days'),
    handoffTime: time.default('09:00'),
    startDate: z.string().refine(isValidDateOnly, 'Use YYYY-MM-DD'),
    members: z.array(id).min(1).max(100),
    restrictions: z.array(restrictionSchema).max(14).default([]),
  })
  .refine((layer) => layer.rotation !== 'custom' || Boolean(layer.customLength), {
    path: ['customLength'],
    message: 'Required for a custom rotation',
  })

export const overrideSchema = z
  .object({
    user: id,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    note: z.string().trim().max(200).nullish(),
  })
  .refine((value) => Date.parse(value.end) > Date.parse(value.start), {
    path: ['end'],
    message: 'Must be after the start',
  })

export const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).nullish(),
  timezone: timeZone.default('UTC'),
  layers: z.array(layerSchema).max(10).default([]),
  overrides: z.array(overrideSchema).max(200).default([]),
})
export type ScheduleInput = z.input<typeof scheduleSchema>

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).nullable(),
    timezone: timeZone,
    layers: z.array(layerSchema).max(10),
    overrides: z.array(overrideSchema).max(200),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0)
export type UpdateScheduleInput = z.input<typeof updateScheduleSchema>

export const escalationTargetSchema = z.object({ type: z.enum(ESCALATION_TARGET_TYPES), id })

export const escalationStepSchema = z.object({
  escalateAfterMinutes: z.number().int().min(1).max(1440).default(10),
  targets: z.array(escalationTargetSchema).min(1).max(20),
})

export const policySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).nullish(),
  repeat: z.number().int().min(0).max(MAX_ESCALATION_REPEATS).default(0),
  steps: z.array(escalationStepSchema).min(1).max(20),
  /** Monitors that escalate with this policy (replaces the current set when given). */
  monitors: z.array(id).max(1000).optional(),
})
export type PolicyInput = z.input<typeof policySchema>

export const updatePolicySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).nullable(),
    repeat: z.number().int().min(0).max(MAX_ESCALATION_REPEATS),
    steps: z.array(escalationStepSchema).min(1).max(20),
    monitors: z.array(id).max(1000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0)
export type UpdatePolicyInput = z.input<typeof updatePolicySchema>
