import { getPayload } from 'payload'

import config from '@payload-config'
import { getCheckerSummary } from '@/server/engine/connectivity-state'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/health` — liveness of the web process and its database. `checker` reports the workers'
 * self connectivity check (`disabled` unless `CONNECTIVITY_CHECK_ENABLED`); an offline checker
 * does not make the web process unhealthy.
 */
export async function GET() {
  try {
    const payload = await getPayload({ config })
    await payload.count({ collection: 'users' })
    const checker = await getCheckerSummary()
    return Response.json({
      ok: true,
      service: 'marmot',
      version: process.env.npm_package_version ?? '0.0.0',
      checker,
    })
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 503 })
  }
}
