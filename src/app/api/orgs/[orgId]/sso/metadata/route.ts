import { parseIdpMetadata } from '@thinkhuman/payload-plugin-auth/saml'
import { z } from 'zod'

import { jsonError, readJson, resolveOrgRequest } from '@/server/notifications/api'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

const schema = z.union([
  z.object({ url: z.string().trim().url() }),
  z.object({ xml: z.string().min(1).max(1_000_000) }),
])

const MAX_BYTES = 1_000_000

/**
 * POST /api/orgs/:orgId/sso/metadata `{ url }` or `{ xml }` → the IdP settings a SAML connection
 * needs (`entityId`, `entryPoint`, `certificate`, `logoutUrl`), parsed from identity-provider
 * metadata (`sso:manage`). Nothing is stored; the UI fills the form with the result.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:manage')
  if (ctx instanceof Response) return ctx

  const parsed = schema.safeParse(await readJson(request))
  if (!parsed.success) return jsonError(400, 'Provide a metadata URL or the metadata XML')

  let xml: string
  if ('xml' in parsed.data) {
    xml = parsed.data.xml
  } else {
    if (!parsed.data.url.startsWith('https://'))
      return jsonError(400, 'Metadata URL must use https')
    try {
      const response = await fetch(parsed.data.url, {
        headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'follow',
      })
      if (!response.ok) return jsonError(400, `Metadata URL responded with ${response.status}`)
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > MAX_BYTES) return jsonError(400, 'Metadata document is too large')
      xml = (await response.text()).slice(0, MAX_BYTES)
    } catch (error) {
      return jsonError(
        400,
        `Could not fetch the metadata: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  try {
    const metadata = await parseIdpMetadata(xml)
    return Response.json({
      entityId: metadata.entityId,
      entryPoint: metadata.entryPoint,
      binding: metadata.binding,
      certificate: metadata.certificates[0] ?? null,
      certificates: metadata.certificates,
      logoutUrl: metadata.logoutUrl ?? null,
      nameIdFormats: metadata.nameIdFormats,
    })
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : 'Invalid metadata')
  }
}
