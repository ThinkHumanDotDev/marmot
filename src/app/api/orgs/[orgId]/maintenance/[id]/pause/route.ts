import { setMaintenanceActiveHandler } from '@/server/maintenance/active'

export const dynamic = 'force-dynamic'

/** POST /api/orgs/:orgId/maintenance/:id/pause — `active: false`; the window stops applying. */
export const POST = setMaintenanceActiveHandler(false)
