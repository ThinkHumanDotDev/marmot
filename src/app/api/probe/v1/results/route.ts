import { getPayload } from 'payload'

import config from '@payload-config'
import { authenticateProbe } from '@/server/probes'
import { ingestProbeResults } from '@/server/probes/ingest'
import { probeResultsBodySchema } from '@/server/probes/wire'

export const dynamic = 'force-dynamic'

/** Request bodies above this size are refused before parsing (100 results fit comfortably). */
const MAX_BODY_BYTES = 2_000_000

/**
 * POST /api/probe/v1/results `{ results: ProbeResult[] }` — check results from the calling probe's
 * location (#91), recorded in order through the heartbeat state machine with the location on the
 * heartbeat. Answers `{ accepted, results[] }` with each result's outcome and next check interval.
 */
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const auth = await authenticateProbe(payload, request)
  if ('response' in auth) return auth.response

  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) {
    return Response.json({ error: 'request body too large' }, { status: 413 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const parsed = probeResultsBodySchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return Response.json(
      { error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid results' },
      { status: 400 },
    )
  }
  return Response.json(await ingestProbeResults(payload, auth.location, parsed.data.results))
}
