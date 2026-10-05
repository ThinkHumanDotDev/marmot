/**
 * Shared handler for the two import routes. Reads and size-checks the JSON body, parses it in the
 * requested (or detected) format, and applies the plan as a dry run (`?dryRun=1`) or for real.
 */
import type { Payload } from 'payload'

import { MAX_IMPORT_BYTES, type ImportFormat } from '@/lib/import-export'
import { authenticate, authorize, jsonError, parseId, payloadError } from '@/server/monitors/http'

import { applyImportPlan } from './apply'
import { parseImportFile } from './index'
import { ImportFormatError } from './types'

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
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:create')
  if (forbidden) return forbidden

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_IMPORT_BYTES) return jsonError(413, 'File is larger than 10 MB')
  const text = await request.text()
  if (text.length > MAX_IMPORT_BYTES) return jsonError(413, 'File is larger than 10 MB')

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return jsonError(400, 'The uploaded file is not valid JSON')
  }

  try {
    const plan = parseImportFile(json, format)
    const dryRun = isDryRun(new URL(request.url))
    const report = await applyImportPlan(payload, { orgId, user: auth.user, plan, dryRun })
    return Response.json(report, { status: dryRun ? 200 : 201 })
  } catch (error) {
    if (error instanceof ImportFormatError) return jsonError(400, error.message)
    payload.logger.error({ err: error, orgId }, 'import failed')
    return payloadError(error)
  }
}
