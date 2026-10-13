import { getPayload } from 'payload'

import config from '@payload-config'
import { handleInboundAlert } from '@/server/integrations/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> }

/**
 * `POST /api/inbound/:token` — inbound alerts for an integration (#152): Alertmanager, Grafana or
 * generic JSON, depending on the integration's format. Authenticated by the token (constant-time),
 * rate-limited, size-capped and idempotent per alert; see `src/server/integrations/http.ts` and
 * docs/Integrations.md.
 */
export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const { token } = await params
  const payload = await getPayload({ config })
  return handleInboundAlert(payload, request, token)
}
