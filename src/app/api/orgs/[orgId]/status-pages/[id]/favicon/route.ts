import { removeAssetHandler, uploadAssetHandler } from '@/server/status-pages/assets'

export const dynamic = 'force-dynamic'

/**
 * POST/DELETE /api/orgs/:orgId/status-pages/:id/favicon — PNG, ICO or sanitised SVG, ≤ 100 KB.
 * Without a favicon the public page falls back to the logo.
 */
export const POST = uploadAssetHandler('favicon')
export const DELETE = removeAssetHandler('favicon')
