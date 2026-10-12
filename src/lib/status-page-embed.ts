/**
 * Embedding a status page in other sites (#109): the iframe embed mode (`?embed=…&theme=…`), the
 * per-page framing policy and the snippets the editor's Share tab offers.
 *
 * Framing is opt-in per page (`allowEmbedding`): `off` (default) sends `frame-ancestors 'none'` and
 * `X-Frame-Options: DENY`, `any` allows every origin, `origins` only the listed ones. Only published
 * pages in `public` access mode can ever be framed, so no access cookie is used in a frame.
 *
 * Client-safe: shared by the collection, `src/proxy.ts`, the public page and the editor.
 */

export const EMBED_MODES = ['off', 'any', 'origins'] as const
export type EmbedMode = (typeof EMBED_MODES)[number]

/** Upper bound on `embedOrigins` (validated by the collection). */
export const STATUS_PAGE_MAX_EMBED_ORIGINS = 50

/** Sections of the page the embed mode can show, in page order. */
export const EMBED_SECTIONS = [
  'banner',
  'maintenance',
  'incidents',
  'components',
  'history',
] as const
export type EmbedSection = (typeof EMBED_SECTIONS)[number]

export const EMBED_THEMES = ['light', 'dark'] as const
export type EmbedTheme = (typeof EMBED_THEMES)[number]

/** Query parameters of the embed mode. */
export const EMBED_PARAM = 'embed'
export const EMBED_THEME_PARAM = 'theme'

/**
 * Request header the proxy sets (and strips from visitors' requests) to pass `?theme=` of an embed
 * to the status layout, which cannot read the query string.
 */
export const EMBED_THEME_HEADER = 'x-marmot-embed-theme'

/** `'none'`: the page must not be framed by anyone. */
export const FRAME_ANCESTORS_NONE = "'none'"

/**
 * The sections an `?embed=` value asks for: `null` when the parameter is absent (the normal page),
 * every section for `all`, an empty value or a list without a known section.
 */
export function parseEmbedSections(
  value: string | string[] | null | undefined,
): EmbedSection[] | null {
  if (value === null || value === undefined) return null
  const raw = (Array.isArray(value) ? value.join(',') : value).toLowerCase()
  const wanted = new Set(raw.split(',').map((part) => part.trim()))
  if (wanted.has('all')) return [...EMBED_SECTIONS]
  const sections = EMBED_SECTIONS.filter((section) => wanted.has(section))
  return sections.length > 0 ? sections : [...EMBED_SECTIONS]
}

/** `light` or `dark` from `?theme=`, else `null` (the page's own theme). */
export function parseEmbedTheme(value: string | string[] | null | undefined): EmbedTheme | null {
  const raw = Array.isArray(value) ? value[0] : value
  return (EMBED_THEMES as readonly string[]).includes(raw ?? '') ? (raw as EmbedTheme) : null
}

/**
 * `https://docs.acme.com`, `http://localhost:8080` or a wildcard subdomain `https://*.acme.com`:
 * scheme, host and optional port, nothing else (the value goes into a CSP header).
 */
const ORIGIN_PATTERN =
  /^https?:\/\/(?:\*\.)?(?:(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/

/** ` HTTPS://Docs.Acme.com/ ` → `https://docs.acme.com`. Does not validate; see `isValidEmbedOrigin`. */
export const normalizeEmbedOrigin = (value: string): string =>
  value.trim().toLowerCase().replace(/\/+$/, '')

export function isValidEmbedOrigin(value: string): boolean {
  if (!ORIGIN_PATTERN.test(value)) return false
  const port = /:(\d+)$/.exec(value.replace(/^https?:\/\//, ''))
  return !port || Number(port[1]) <= 65535
}

export interface EmbeddablePage {
  published?: boolean | null
  access?: string | null
  allowEmbedding?: string | null
  embedOrigins?: { origin?: string | null }[] | null
}

/** True when the page can be framed at all: published, `public` and embedding switched on. */
export function isEmbeddable(page: EmbeddablePage): boolean {
  if (!page.published || (page.access ?? 'public') !== 'public') return false
  return page.allowEmbedding === 'any' || page.allowEmbedding === 'origins'
}

/**
 * The `frame-ancestors` source list of a page's HTML: `'none'` unless the page is embeddable, `*`
 * for `any`, the valid listed origins for `origins` (`'none'` when the list is empty).
 */
export function frameAncestorsFor(page: EmbeddablePage): string {
  if (!isEmbeddable(page)) return FRAME_ANCESTORS_NONE
  if (page.allowEmbedding === 'any') return '*'
  const origins = [
    ...new Set(
      (page.embedOrigins ?? [])
        .map((row) => normalizeEmbedOrigin(String(row?.origin ?? '')))
        .filter(isValidEmbedOrigin),
    ),
  ]
  return origins.length > 0 ? origins.join(' ') : FRAME_ANCESTORS_NONE
}

/** A `frame-ancestors` value this module produced (guards the proxy against a bad lookup). */
export function isFrameAncestorsValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === FRAME_ANCESTORS_NONE || value === '*') return true
  const origins = value.split(' ')
  return origins.length > 0 && origins.every(isValidEmbedOrigin)
}

/**
 * Response headers for a `frame-ancestors` value: the CSP directive, plus `X-Frame-Options: DENY`
 * for older browsers when nobody may frame the page (`ALLOW-FROM` is obsolete, so an allowed page
 * relies on CSP alone).
 */
export function frameHeaders(frameAncestors: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
  }
  if (frameAncestors === FRAME_ANCESTORS_NONE) headers['X-Frame-Options'] = 'DENY'
  return headers
}

// ---------------------------------------------------------------------------------------------
// Snippets (editor Share tab)

export interface EmbedSnippetOptions {
  /** `all`, or the chosen sections. */
  sections: EmbedSection[]
  theme: EmbedTheme | 'page'
  /** iframe height in pixels. */
  height: number
}

export const DEFAULT_EMBED_SNIPPET_OPTIONS: EmbedSnippetOptions = {
  sections: [...EMBED_SECTIONS],
  theme: 'page',
  height: 600,
}

export interface WidgetSnippetOptions {
  theme: 'light' | 'dark' | 'auto'
  size: 'sm' | 'md' | 'lg'
}

export const DEFAULT_WIDGET_SNIPPET_OPTIONS: WidgetSnippetOptions = { theme: 'light', size: 'md' }

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `<page>?embed=…[&theme=…]` (the root of a custom domain gets its `/`). */
export function statusPageEmbedUrl(pageUrl: string, options: EmbedSnippetOptions): string {
  const all = EMBED_SECTIONS.every((section) => options.sections.includes(section))
  const sections = all
    ? 'all'
    : EMBED_SECTIONS.filter((s) => options.sections.includes(s)).join(',')
  const base = /^https?:\/\/[^/]+$/.test(pageUrl) ? `${pageUrl}/` : pageUrl
  const theme = options.theme === 'page' ? '' : `&${EMBED_THEME_PARAM}=${options.theme}`
  return `${base}?${EMBED_PARAM}=${sections}${theme}`
}

/** The iframe snippet of the embed mode. */
export function iframeSnippet(
  pageUrl: string,
  title: string,
  options: EmbedSnippetOptions,
): string {
  const src = statusPageEmbedUrl(pageUrl, options)
  const height = Math.max(100, Math.min(4000, Math.round(options.height) || 600))
  return (
    `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" width="100%" height="${height}" ` +
    `style="border:0" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" ` +
    `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`
  )
}

/**
 * HTML and React snippets of the status widget (`<page>/widget.js`). The widget renders right after
 * its `<script>` element, so the React version appends the script to its own `<span>`.
 */
export function widgetSnippets(
  pageUrl: string,
  options: WidgetSnippetOptions,
): { widgetHtml: string; widgetReact: string } {
  const src = `${pageUrl.replace(/\/$/, '')}/widget.js`
  const widgetHtml = `<script async src="${escapeHtml(src)}" data-theme="${options.theme}" data-size="${options.size}"></script>`
  const widgetReact = [
    "import { useEffect, useRef } from 'react'",
    '',
    'export function StatusWidget() {',
    '  const ref = useRef(null)',
    '  useEffect(() => {',
    '    const host = ref.current',
    "    const script = document.createElement('script')",
    `    script.src = ${JSON.stringify(src)}`,
    '    script.async = true',
    `    script.dataset.theme = ${JSON.stringify(options.theme)}`,
    `    script.dataset.size = ${JSON.stringify(options.size)}`,
    '    host.appendChild(script)',
    '    return () => host.replaceChildren()',
    '  }, [])',
    '  return <span ref={ref} />',
    '}',
  ].join('\n')
  return { widgetHtml, widgetReact }
}
