/**
 * Minimal, dependency-free Markdown → HTML for incident bodies. Supports paragraphs, line breaks,
 * `**bold**`, `_italics_`/`*italics*`, `` `code` ``, `[text](https://url)` links and `- ` bullet
 * lists. Everything is HTML-escaped first, so authored HTML never reaches the page and the output
 * is safe to inject with `dangerouslySetInnerHTML`. Links only keep http(s) and mailto URLs.
 */

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const SAFE_URL = /^(https?:\/\/|mailto:)/i

function inline(text: string): string {
  let html = escapeHtml(text)
  // `code` first so its contents are not formatted further.
  html = html.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  html = html.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
  // The URL may contain one level of balanced parentheses (Wikipedia-style links).
  html = html.replace(
    /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
    (_m, label: string, href: string) =>
      SAFE_URL.test(href)
        ? `<a href="${href}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`
        : label,
  )
  return html.replace(/\n/g, '<br/>')
}

/** Renders Markdown-ish text to a small, safe HTML fragment. Empty input yields ''. */
export function renderMarkdown(source: string): string {
  const blocks = source
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
  const out: string[] = []
  for (const block of blocks) {
    if (!block.trim()) continue
    const lines = block.split('\n')
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const items = lines.map((line) => `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      out.push(`<ul>${items.join('')}</ul>`)
    } else {
      out.push(`<p>${inline(block)}</p>`)
    }
  }
  return out.join('')
}

/** Plain-text version (for meta descriptions and feed summaries). */
export function markdownToText(source: string, maxLength = 155): string {
  const text = source
    .replace(/[`*_]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}
