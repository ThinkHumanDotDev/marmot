import { serverTranslator } from '@/server/i18n'
import { requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

/** Scalar API reference, loaded from jsDelivr (pinned to the 1.x line). */
const SCALAR_SRC = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * GET /api/docs — interactive reference of the management API, rendered by Scalar from
 * `/api/openapi.json`. Without JavaScript (or offline) the page links to the JSON document.
 */
export function GET(request: Request) {
  const t = serverTranslator(requestLocale(request))
  const title = escapeHtml(t('apiDocs.title'))
  const fallback = escapeHtml(t('apiDocs.fallback'))
  const html = `<!doctype html>
<html lang="${requestLocale(request)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
  </head>
  <body>
    <noscript><p><a href="/api/openapi.json">${fallback}</a></p></noscript>
    <div id="app"></div>
    <script src="${SCALAR_SRC}"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/api/openapi.json', hideClientButton: false })
    </script>
  </body>
</html>
`
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  })
}
