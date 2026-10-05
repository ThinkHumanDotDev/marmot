import {
  authenticate,
  errorResponse,
  jsonError,
  loadOrgStatusPage,
} from '@/server/status-pages/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

const MAX_LOGO_BYTES = 2 * 1024 * 1024

/**
 * POST /api/orgs/:orgId/status-pages/:id/logo — multipart `file` field. Stores the image in
 * `media` and sets it as the page's logo. DELETE removes the logo (the media row is kept).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  try {
    const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!page) return jsonError('Status page not found', 404)

    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return jsonError('Expected a multipart "file" field', 400)
    if (!file.type.startsWith('image/')) return jsonError('Logo must be an image', 400)
    if (file.size > MAX_LOGO_BYTES) return jsonError('Logo must be 2 MB or smaller', 400)

    const media = await payload.create({
      collection: 'media',
      data: { alt: `${page.title} logo` },
      file: {
        data: Buffer.from(await file.arrayBuffer()),
        mimetype: file.type,
        name: file.name || 'logo',
        size: file.size,
      },
      user,
      overrideAccess: false,
    })

    const doc = await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { logo: media.id },
      depth: 1,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  try {
    const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!page) return jsonError('Status page not found', 404)
    const doc = await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { logo: null },
      depth: 1,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error)
  }
}
