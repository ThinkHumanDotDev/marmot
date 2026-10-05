import { setActiveHandler } from '@/server/monitors/active'

export const dynamic = 'force-dynamic'

/** POST /api/orgs/:orgId/monitors/:id/resume — start checking the monitor again (`active: true`). */
export const POST = setActiveHandler(true)
