import { getPayload } from 'payload'

import config from '@payload-config'
import { needsSetup } from '@/server/setup'

export const dynamic = 'force-dynamic'

/** `GET /api/setup/status` → `{ needsSetup }`; `true` only while no user exists. */
export async function GET() {
  const payload = await getPayload({ config })
  return Response.json(
    { needsSetup: await needsSetup(payload) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
