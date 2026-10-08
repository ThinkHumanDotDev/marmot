/**
 * Collector management behind `/api/orgs/:orgId/otel-collectors/**` and Settings → OpenTelemetry
 * (#99). The routes authorise (`otel-collector:read` / `otel-collector:manage`); these functions
 * load documents as the user, so a collector of another organization is "not found", and write the
 * server-only fields (sealed headers, their names) with `overrideAccess: true` while still naming
 * the user as the audit actor.
 */
import type { Payload } from 'payload'
import { z } from 'zod'

import type { OrgId } from '@/access/permissions'
import {
  OTEL_ENDPOINT_MAX_LENGTH,
  OTEL_HEADER_VALUE_MAX_LENGTH,
  OTEL_MAX_HEADERS,
  OTEL_NAME_MAX_LENGTH,
  OTEL_SCOPE_NAME,
  OTEL_SERVICE_NAME,
  type OtelCollectorRow,
} from '@/lib/otel'
import { MARMOT_VERSION } from '@/lib/version'
import type { OtelCollector, User } from '@/payload-types'

import { encodeMetricsRequest } from './encode'
import { metricsUrl } from './endpoint'
import { postMetrics, type ExportResult } from './exporter'
import { mergeHeaders, openHeaders, sealHeaders, type OtelHeaderInput } from './headers'

type RequestUser = User & { collection: 'users' }

export interface OtelContext {
  payload: Payload
  user: RequestUser
  orgId: OrgId
}

const headerInput = z.object({
  name: z.string().trim().min(1).max(128),
  /** `null` keeps the value stored under this name. */
  value: z.string().max(OTEL_HEADER_VALUE_MAX_LENGTH).nullable(),
})

const headersInput = z
  .array(headerInput)
  .max(OTEL_MAX_HEADERS)
  .describe('Replaces every header; an entry with `value: null` keeps its stored value')

export const createCollectorSchema = z.object({
  name: z.string().trim().min(1).max(OTEL_NAME_MAX_LENGTH),
  endpoint: z.string().trim().min(1).max(OTEL_ENDPOINT_MAX_LENGTH),
  headers: headersInput.optional(),
  active: z.boolean().optional(),
  default: z.boolean().optional(),
})

export const updateCollectorSchema = createCollectorSchema.partial()

export type CreateCollectorInput = z.infer<typeof createCollectorSchema>
export type UpdateCollectorInput = z.infer<typeof updateCollectorSchema>

const same = (a: unknown, b: unknown) => String(a) === String(b)

const orgOf = (doc: { organization: unknown }) =>
  typeof doc.organization === 'object' && doc.organization !== null
    ? (doc.organization as { id: OrgId }).id
    : (doc.organization as OrgId)

export const toDocId = (payload: Payload, raw: string): string | number =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

export function toCollectorRow(doc: OtelCollector): OtelCollectorRow {
  return {
    id: String(doc.id),
    name: doc.name,
    endpoint: doc.endpoint,
    headerNames: stringList(doc.headerNames),
    active: doc.active !== false,
    default: Boolean(doc.default),
    lastExportAt: doc.lastExportAt ?? null,
    lastError: doc.lastError ?? null,
    createdAt: doc.createdAt,
  }
}

/** The collector when the user may read it and it belongs to the organization in the URL. */
export async function loadOrgCollector(
  ctx: OtelContext,
  rawId: string,
): Promise<OtelCollector | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'otel-collectors',
      id: toDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as OtelCollector
    return same(orgOf(doc), ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

export async function listCollectors(ctx: OtelContext): Promise<OtelCollectorRow[]> {
  const { docs } = await ctx.payload.find({
    collection: 'otel-collectors',
    where: { organization: { equals: ctx.orgId } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: ctx.user,
    overrideAccess: false,
  })
  return (docs as OtelCollector[]).map(toCollectorRow)
}

/** The sealed headers and their names for a write, from the request and what is stored. */
function headerFields(input: readonly OtelHeaderInput[], storedSealed: string | null | undefined) {
  const headers = mergeHeaders(input, openHeaders(storedSealed))
  return { headers: sealHeaders(headers), headerNames: Object.keys(headers) }
}

export async function createCollector(
  ctx: OtelContext,
  input: CreateCollectorInput,
): Promise<OtelCollectorRow> {
  // Plain fields go through access control as the user; sealed headers are server-only fields.
  const doc = (await ctx.payload.create({
    collection: 'otel-collectors',
    data: {
      organization: ctx.orgId as OtelCollector['organization'],
      name: input.name,
      endpoint: input.endpoint,
      active: input.active ?? true,
      default: input.default ?? false,
      ...headerFields(input.headers ?? [], null),
      createdBy: ctx.user.id as OtelCollector['createdBy'],
    },
    depth: 0,
    // The permission was checked by the route.
    user: ctx.user,
    overrideAccess: true,
  })) as OtelCollector
  return toCollectorRow(doc)
}

export async function updateCollector(
  ctx: OtelContext,
  collector: OtelCollector,
  input: UpdateCollectorInput,
): Promise<OtelCollectorRow> {
  const { headers, ...rest } = input
  let sealed: { headers: string | null; headerNames: string[] } | undefined
  if (headers !== undefined) {
    const stored = (await ctx.payload.findByID({
      collection: 'otel-collectors',
      id: collector.id,
      depth: 0,
      overrideAccess: true,
    })) as OtelCollector
    sealed = headerFields(headers, stored.headers)
  }
  const doc = (await ctx.payload.update({
    collection: 'otel-collectors',
    id: collector.id,
    data: { ...rest, ...sealed },
    depth: 0,
    user: ctx.user,
    overrideAccess: true,
  })) as OtelCollector
  return toCollectorRow(doc)
}

export async function deleteCollector(ctx: OtelContext, collector: OtelCollector): Promise<void> {
  await ctx.payload.delete({
    collection: 'otel-collectors',
    id: collector.id,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
}

export const OTEL_TEST_METRIC = 'marmot.collector.test'

/**
 * Sends one `marmot.collector.test` data point now, with the collector's headers, and records the
 * outcome on the collector (`lastExportAt` / `lastError`).
 */
export async function sendTestExport(
  ctx: OtelContext,
  collector: OtelCollector,
  timeoutMs: number,
): Promise<ExportResult> {
  const stored = (await ctx.payload.findByID({
    collection: 'otel-collectors',
    id: collector.id,
    depth: 0,
    overrideAccess: true,
  })) as OtelCollector
  const now = Date.now()
  const body = JSON.stringify(
    encodeMetricsRequest(
      [
        {
          kind: 'gauge',
          name: OTEL_TEST_METRIC,
          unit: '1',
          description: 'Test data point sent from Settings → OpenTelemetry',
          attributes: { 'marmot.collector.id': String(stored.id) },
          time: now,
          value: 1,
        },
      ],
      {
        'service.name': OTEL_SERVICE_NAME,
        'service.version': MARMOT_VERSION,
        'marmot.organization.id': String(ctx.orgId),
      },
      { name: OTEL_SCOPE_NAME, version: MARMOT_VERSION },
    ),
  )
  const result = await postMetrics(
    metricsUrl(stored.endpoint),
    openHeaders(stored.headers),
    body,
    timeoutMs,
  )
  await ctx.payload.update({
    collection: 'otel-collectors',
    id: stored.id,
    data: {
      ...(result.ok ? { lastExportAt: new Date(now).toISOString() } : {}),
      lastError: result.ok ? null : (result.error ?? 'export failed').slice(0, 500),
    },
    depth: 0,
    overrideAccess: true,
  })
  return result
}
