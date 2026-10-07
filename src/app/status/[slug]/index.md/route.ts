import { renderPageMarkdown } from '@/server/status-pages/markdown-output'
import {
  corsPreflight,
  markdownDocument,
  publicStatusPageRoute,
} from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

/**
 * GET /status/:slug/index.md — the page as Markdown. `src/proxy.ts` also serves it as
 * `/status/:slug.md`, and as `/index.md` on custom domains.
 */
export const GET = publicStatusPageRoute(async (ctx) =>
  markdownDocument(await renderPageMarkdown(ctx)),
)

export const OPTIONS = corsPreflight
