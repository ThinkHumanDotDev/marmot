import { getPayload } from 'payload'

import config from '@payload-config'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const payload = await getPayload({ config })
    await payload.count({ collection: 'users' })
    return Response.json({
      ok: true,
      service: 'marmot',
      version: process.env.npm_package_version ?? '0.0.0',
    })
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 503 })
  }
}
