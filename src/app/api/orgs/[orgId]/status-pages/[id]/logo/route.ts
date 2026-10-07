import { removeAssetHandler, uploadAssetHandler } from '@/server/status-pages/assets'

export const dynamic = 'force-dynamic'

/**
 * POST /api/orgs/:orgId/status-pages/:id/logo — multipart `file` (PNG, JPEG, GIF, WebP, AVIF or a
 * sanitised SVG, ≤ 2 MB) becomes the page's logo (shown in light mode, and in dark mode when there
 * is no dark logo). DELETE removes it (the media row is kept).
 */
export const POST = uploadAssetHandler('logo')
export const DELETE = removeAssetHandler('logo')
