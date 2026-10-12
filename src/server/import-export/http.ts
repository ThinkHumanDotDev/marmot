/**
 * Shared handler for the two import routes. Reads and size-checks the JSON body, parses it in the
 * requested (or detected) format, and applies the plan as a dry run (`?dryRun=1`) or for real.
 */
import type { Payload } from 'payload'

import { demoRefusal } from '@/server/demo/config'
import {
  IMPORT_PROVIDER_INFO,
  isImportProvider,
  isImportResource,
  MAX_IMPORT_BYTES,
  type ImportFormat,
} from '@/lib/import-export'
import { authenticate, authorize, jsonError, parseId, payloadError } from '@/server/monitors/http'
import { errorText, requestLocale } from '@/server/request-locale'

import { applyImportPlan } from './apply'
import { parseImportFile } from './index'
import { planProviderImport, PROVIDERS, ProviderError, type FetchLike } from './providers'
import { ImportFormatError } from './types'
import { importText, type ImportMessageKey } from './text'

const isDryRun = (url: URL): boolean => {
  const value = url.searchParams.get('dryRun')
  return value !== null && value !== '0' && value !== 'false'
}

export async function handleImportRequest(
  payload: Payload,
  request: Request,
  rawOrgId: string,
  format?: ImportFormat,
): Promise<Response> {
  // Demo mode (#159): imports would bring arbitrary data (and targets) into the shared demo.
  const refused = demoRefusal(request, 'imports')
  if (refused) return refused
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:create')
  if (forbidden) return forbidden

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_IMPORT_BYTES) return jsonError(413, errorText(request, 'importFileTooLarge'))
  const text = await request.text()
  if (text.length > MAX_IMPORT_BYTES)
    return jsonError(413, errorText(request, 'importFileTooLarge'))

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return jsonError(400, errorText(request, 'importNotJson'))
  }

  try {
    const locale = requestLocale(request)
    const plan = parseImportFile(json, format, importText(locale))
    const dryRun = isDryRun(new URL(request.url))
    const report = await applyImportPlan(payload, {
      orgId,
      user: auth.user,
      plan,
      dryRun,
      locale,
    })
    return Response.json(report, { status: dryRun ? 200 : 201 })
  } catch (error) {
    if (error instanceof ImportFormatError) return jsonError(400, error.message)
    payload.logger.error({ err: error, orgId }, 'import failed')
    return payloadError(error, request)
  }
}

/** Body limit of a provider import request (credentials and a resource list). */
const MAX_PROVIDER_BODY_BYTES = 16 * 1024
const MAX_CREDENTIAL_LENGTH = 1024

const PROVIDER_ERRORS: Record<ProviderError['code'], { status: number; key: ImportMessageKey }> = {
  credentials: { status: 400, key: 'providerCredentials' },
  auth: { status: 400, key: 'providerAuth' },
  notFound: { status: 400, key: 'providerNotFound' },
  unreachable: { status: 502, key: 'providerUnreachable' },
  invalidResponse: { status: 502, key: 'providerInvalidResponse' },
  tooMany: { status: 422, key: 'providerTooMany' },
}

/**
 * `POST /api/orgs/:orgId/import/providers/:provider[?dryRun=1]` with
 * `{ credentials: { … }, resources: [...] }` (#120): reads the account from the provider's API and
 * previews or writes it like a file import. The credentials live in this request only: they are
 * neither stored nor logged, and the client sends them again to commit after the preview.
 */
export async function handleProviderImportRequest(
  payload: Payload,
  request: Request,
  rawOrgId: string,
  rawProvider: string,
  fetchImpl?: FetchLike,
): Promise<Response> {
  // Demo mode (#159): no pulling foreign accounts into the shared demo.
  const refused = demoRefusal(request, 'imports')
  if (refused) return refused
  const locale = requestLocale(request)
  const t = importText(locale)
  if (!isImportProvider(rawProvider)) return jsonError(404, t('providerUnknown'))
  const provider = rawProvider
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:create')
  if (forbidden) return forbidden

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_PROVIDER_BODY_BYTES) {
    return jsonError(413, errorText(request, 'importFileTooLarge'))
  }
  const text = await request.text()
  if (text.length > MAX_PROVIDER_BODY_BYTES) {
    return jsonError(413, errorText(request, 'importFileTooLarge'))
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return jsonError(400, errorText(request, 'importNotJson'))
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const rawCredentials =
    record.credentials && typeof record.credentials === 'object'
      ? (record.credentials as Record<string, unknown>)
      : {}
  const credentials: Record<string, string> = {}
  for (const field of IMPORT_PROVIDER_INFO[provider].credentials) {
    const value = rawCredentials[field.name]
    if (typeof value === 'string' && value.length <= MAX_CREDENTIAL_LENGTH) {
      credentials[field.name] = value
    }
  }
  const resources = Array.isArray(record.resources)
    ? [...new Set(record.resources.filter(isImportResource))]
    : []
  if (resources.length === 0) return jsonError(400, t('providerNoResources'))

  try {
    const plan = await planProviderImport(
      { provider, credentials, resources, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
      t,
    )
    const dryRun = isDryRun(new URL(request.url))
    const report = await applyImportPlan(payload, {
      orgId,
      user: auth.user,
      plan,
      dryRun,
      locale,
    })
    return Response.json(report, { status: dryRun ? 200 : 201 })
  } catch (error) {
    if (error instanceof ProviderError) {
      // Only the code and status: the credentials never reach a log line.
      payload.logger.warn(
        { orgId, provider, code: error.code, status: error.status },
        'provider import: API request failed',
      )
      const mapped = PROVIDER_ERRORS[error.code]
      return jsonError(mapped.status, t(mapped.key, { provider: PROVIDERS[provider].label }))
    }
    payload.logger.error({ err: error, orgId, provider }, 'provider import failed')
    return payloadError(error, request)
  }
}
