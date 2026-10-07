import { renderLlmsTxt } from '@/server/status-pages/markdown-output'
import { corsPreflight, publicStatusPageRoute } from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/llms.txt — describes the page and links its machine-readable endpoints. */
export const GET = publicStatusPageRoute(async (ctx) => ({
  body: await renderLlmsTxt(ctx),
  contentType: 'text/plain; charset=utf-8',
}))

export const OPTIONS = corsPreflight
