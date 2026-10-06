import { setMaintenanceActiveHandler } from '@/server/maintenance/active'

export const dynamic = 'force-dynamic'

/** POST /api/orgs/:orgId/maintenance/:id/resume — `active: true`. */
export const POST = setMaintenanceActiveHandler(true)
