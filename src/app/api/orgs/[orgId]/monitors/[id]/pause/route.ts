import { setActiveHandler } from '@/server/monitors/active'

export const dynamic = 'force-dynamic'

/** POST /api/orgs/:orgId/monitors/:id/pause — stop checking the monitor (`active: false`). */
export const POST = setActiveHandler(false)
