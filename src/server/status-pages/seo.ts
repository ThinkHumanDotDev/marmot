/**
 * Search engine and link preview settings of public status pages (#107). Every public HTML page of
 * a status page (the page, its history and its permalinks) and the machine files (`sitemap.xml`,
 * `robots.txt`) take the same decision from `isIndexable`: published, `searchEngineIndex` on and
 * not access-protected. Everything else is `noindex, nofollow`, has no sitemap and a `robots.txt`
 * that disallows everything.
 */
import type { Metadata } from 'next'

import { eventPath, EVENTS_PATH } from '@/lib/status-page-events'
import type { StatusPage } from '@/payload-types'

import { isProtectedPage } from './access'
import type { SitemapEvent } from './events'
import { escapeXml } from './rss'
import { statusPagePath } from './urls'

type SeoPage = Pick<StatusPage, 'published' | 'searchEngineIndex' | 'access'>

/** May search engines index the page and its history? */
export const isIndexable = (page: SeoPage): boolean =>
  Boolean(page.published && page.searchEngineIndex) && !isProtectedPage(page)

export const NOINDEX = { index: false, follow: false } as const

/** `robots` metadata of every HTML page of a status page. */
export const pageRobots = (page: SeoPage): NonNullable<Metadata['robots']> =>
  isIndexable(page) ? { index: true, follow: true } : NOINDEX

/** `X-Robots-Tag` for machine responses of the page (feeds, JSON), when it must not be indexed. */
export const robotsHeader = (page: SeoPage): Record<string, string> =>
  isIndexable(page) ? {} : { 'X-Robots-Tag': 'noindex, nofollow' }

const MAX_DESCRIPTION = 200

/** Plain text cut at a word boundary to fit a meta description. */
export function truncateDescription(text: string, max = MAX_DESCRIPTION): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export interface StatusPageMetadataOptions {
  /** Document title (already templated, e.g. `{title} · {siteName}`). */
  title: string
  description?: string
  /** Absolute canonical URL of this page. */
  url: string
  /** `website` for the page and history, `article` for permalinks. */
  type?: 'website' | 'article'
  publishedTime?: string
  modifiedTime?: string
}

/**
 * Metadata shared by the public HTML pages: robots, canonical URL, RSS alternate, manifest (public
 * pages only; protected pages link it with credentials themselves), Open Graph and Twitter cards,
 * and the favicon (then the logo). Media URLs point at Marmot's own host, so they load on custom
 * domains too.
 */
export function statusPageMetadata(page: StatusPage, options: StatusPageMetadataOptions): Metadata {
  const logo = page.logo && typeof page.logo === 'object' ? page.logo.url : null
  const favicon = page.favicon && typeof page.favicon === 'object' ? page.favicon : null
  const icon = favicon?.url
    ? { url: favicon.url, ...(favicon.mimeType ? { type: favicon.mimeType } : {}) }
    : logo
      ? { url: logo }
      : null
  const restricted = isProtectedPage(page)
  const base = statusPagePath(page.slug)
  const { title, description, url } = options
  return {
    title,
    description,
    applicationName: page.title,
    robots: pageRobots(page),
    ...(restricted ? {} : { manifest: `${base}/manifest.json` }),
    alternates: {
      canonical: url,
      // Feed discovery (RSS, Atom, JSON Feed, the maintenance calendar and Markdown, #108).
      types: {
        'application/rss+xml': `${base}/rss`,
        'application/atom+xml': `${base}/feed/atom`,
        'application/feed+json': `${base}/feed/json`,
        'text/calendar': `${base}/maintenance.ics`,
        'text/markdown': `${base}.md`,
      },
    },
    openGraph: {
      type: options.type ?? 'website',
      title,
      description,
      url,
      siteName: page.title,
      ...(options.type === 'article'
        ? {
            ...(options.publishedTime ? { publishedTime: options.publishedTime } : {}),
            ...(options.modifiedTime ? { modifiedTime: options.modifiedTime } : {}),
          }
        : {}),
      ...(logo ? { images: [{ url: logo }] } : {}),
    },
    twitter: {
      card: logo ? 'summary' : 'summary_large_image',
      title,
      description,
      ...(logo ? { images: [logo] } : {}),
    },
    ...(icon ? { icons: { icon: [icon] } } : {}),
  }
}

/** `sitemap.xml` of an indexable page: the page, its history and every permalink. */
export function renderSitemap(baseUrl: string, events: readonly SitemapEvent[]): string {
  const url = (loc: string, lastmod?: string) =>
    `  <url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ''}</url>`
  const newest = events.reduce<string | undefined>(
    (max, e) => (!max || e.lastModified > max ? e.lastModified : max),
    undefined,
  )
  const root = baseUrl || '/'
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [
      url(root),
      url(`${baseUrl}${EVENTS_PATH}`, newest),
      ...events.map((e) => url(`${baseUrl}${eventPath(e.kind, e.publicId)}`, e.lastModified)),
    ].join('\n') +
    `\n</urlset>\n`
  )
}

/**
 * `robots.txt` for the page's custom domains (and `/status/:slug/robots.txt`). Indexable pages
 * allow the page paths and point at the sitemap; all others disallow everything.
 */
export function renderRobotsTxt(page: SeoPage, baseUrl: string): string {
  if (!isIndexable(page)) return 'User-agent: *\nDisallow: /\n'
  return (
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /api/\n' +
    'Disallow: /login\n' +
    `\nSitemap: ${baseUrl}/sitemap.xml\n`
  )
}
