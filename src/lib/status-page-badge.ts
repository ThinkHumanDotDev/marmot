/**
 * Embed snippets for the overall status-page badge (`GET /status/:slug/badge.svg`, issue #110).
 * Client-safe: the editor's Share tab builds the URLs and Markdown / HTML snippets with these.
 */

export const BADGE_EMBED_STYLES = [
  'pill',
  'flat',
  'flat-square',
  'plastic',
  'for-the-badge',
  'social',
] as const
export type BadgeEmbedStyle = (typeof BADGE_EMBED_STYLES)[number]

export interface BadgeEmbedOptions {
  /** `pill` is the default renderer (no `style` parameter); the rest are shields styles. */
  style: BadgeEmbedStyle
  theme: 'light' | 'dark'
  size: 'sm' | 'md' | 'lg' | 'xl'
  variant: 'default' | 'outline'
  label: string
}

export const DEFAULT_BADGE_EMBED_OPTIONS: BadgeEmbedOptions = {
  style: 'pill',
  theme: 'light',
  size: 'md',
  variant: 'default',
  label: '',
}

/**
 * Base URL of a page: `https://marmot.example.com/status/<slug>` on Marmot's own host, or the root of
 * a custom domain (`https://status.example.com`), where the proxy serves `/badge.svg` too.
 */
export function statusPageBaseUrl(origin: string, slug: string, customHost?: string | null) {
  if (customHost) return `https://${customHost}`
  return `${origin.replace(/\/$/, '')}/status/${encodeURIComponent(slug)}`
}

/** Badge URL with only the parameters that differ from the defaults. */
export function statusPageBadgeUrl(pageUrl: string, options: BadgeEmbedOptions): string {
  const params = new URLSearchParams()
  if (options.style === 'pill') {
    if (options.theme !== 'light') params.set('theme', options.theme)
    if (options.size !== 'md') params.set('size', options.size)
    if (options.variant !== 'default') params.set('variant', options.variant)
  } else {
    params.set('style', options.style)
  }
  const label = options.label.trim()
  if (label) params.set('label', label)
  const query = params.toString()
  return `${pageUrl}/badge.svg${query ? `?${query}` : ''}`
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const escapeMarkdownText = (value: string) => value.replace(/([\\[\]])/g, '\\$1')

/** Markdown and HTML snippets: the badge image linking to the page. */
export function statusPageBadgeSnippets({
  pageUrl,
  badgeUrl,
  alt,
}: {
  pageUrl: string
  badgeUrl: string
  alt: string
}): { markdown: string; html: string } {
  return {
    markdown: `[![${escapeMarkdownText(alt)}](${badgeUrl})](${pageUrl})`,
    html: `<a href="${escapeHtml(pageUrl)}"><img src="${escapeHtml(badgeUrl)}" alt="${escapeHtml(alt)}"></a>`,
  }
}
