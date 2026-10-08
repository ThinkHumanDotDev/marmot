import { demoRefusal } from '@/server/demo/config'
import { DOCKER_CONNECTION_TYPES, type DockerConnectionType } from '@/lib/monitor-resources'
import type { DockerHost } from '@/payload-types'
import { testDockerHost, type DockerHostConfig } from '@/server/docker/client'
import { jsonError, parseDocId, readJson, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

type TestBody = {
  dockerHostId?: string | number
  connectionType?: string
  socketPath?: string
  url?: string
}

/**
 * POST /api/orgs/:orgId/docker-hosts/test — check that a Docker daemon answers
 * (`docker-host:update`, the same users who may save a host).
 *
 * Body: `{ dockerHostId }` for a saved host, or `{ connectionType, socketPath | url }` for an unsaved
 * one. Responds `{ ok: true, containers }` or 400 `{ ok: false, error }`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  // Demo mode (#159): the server would connect to a user-supplied Docker daemon.
  const refused = demoRefusal(request, 'dockerHosts')
  if (refused) return refused
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'docker-host:update')
  if (ctx instanceof Response) return ctx

  const body = await readJson<TestBody>(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'), { ok: false })

  let host: DockerHostConfig
  if (body.dockerHostId !== undefined && body.dockerHostId !== null) {
    try {
      const doc = (await ctx.payload.findByID({
        collection: 'docker-hosts',
        id: parseDocId(ctx.payload, String(body.dockerHostId)),
        depth: 0,
        user: ctx.user,
        overrideAccess: false,
      })) as DockerHost
      const org = typeof doc.organization === 'object' ? doc.organization.id : doc.organization
      if (String(org) !== String(ctx.orgId)) throw new Error('wrong organization')
      host = doc
    } catch {
      return jsonError(404, errorText(request, 'dockerHostNotFound'), { ok: false })
    }
  } else if (
    typeof body.connectionType === 'string' &&
    (DOCKER_CONNECTION_TYPES as readonly string[]).includes(body.connectionType)
  ) {
    host = {
      connectionType: body.connectionType as DockerConnectionType,
      socketPath: typeof body.socketPath === 'string' ? body.socketPath.trim() : null,
      url: typeof body.url === 'string' ? body.url.trim() : null,
    }
    if (host.connectionType === 'socket' && !host.socketPath?.startsWith('/')) {
      return jsonError(400, errorText(request, 'socketPathAbsolute'), { ok: false })
    }
  } else {
    return jsonError(400, errorText(request, 'dockerTestTargetRequired'), { ok: false })
  }

  try {
    const containers = await testDockerHost(host)
    return Response.json({ ok: true, containers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json({ ok: false, error: message }, { status: 400 })
  }
}
