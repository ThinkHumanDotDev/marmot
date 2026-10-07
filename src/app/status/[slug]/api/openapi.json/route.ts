import { buildOpenApiDocument } from '@/server/status-pages/openapi'
import {
  corsPreflight,
  jsonDocument,
  publicStatusPageRoute,
} from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/api/openapi.json — OpenAPI 3.1 description of the public endpoints. */
export const GET = publicStatusPageRoute(async ({ page, links }) =>
  jsonDocument(buildOpenApiDocument(page, links)),
)

export const OPTIONS = corsPreflight
