import { removeAssetHandler, uploadAssetHandler } from '@/server/status-pages/assets'

export const dynamic = 'force-dynamic'

/** POST/DELETE /api/orgs/:orgId/status-pages/:id/logo-dark — the logo shown in dark mode. */
export const POST = uploadAssetHandler('logoDark')
export const DELETE = removeAssetHandler('logoDark')
