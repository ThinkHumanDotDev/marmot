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

/**
 * Renders a longer Markdown document (postmortems) to safe HTML. On top of `renderMarkdown`'s inline
 * formatting it supports `#` headings (rendered from `<h3>` down, below the page's own headings),
 * `-`/`*`/`+` and numbered lists, fenced code blocks and horizontal rules. Like `renderMarkdown`
 * everything is HTML-escaped first and links keep only http(s) and mailto URLs, so the output is safe
 * to inject with `dangerouslySetInnerHTML`.
 */
export function renderMarkdownDocument(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join('\n'))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list) {
      const items = list.items.map((item) => `<li>${inline(item)}</li>`).join('')
      out.push(`<${list.tag}>${items}</${list.tag}>`)
    }
    list = null
  }
  const flush = () => {
    flushParagraph()
    flushList()
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) {
        code.push(lines[index])
        index++
      }
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    if (heading) {
      flush()
      const level = Math.min(heading[1].length + 2, 6)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push('<hr/>')
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = bullet ? null : /^\s*\d{1,9}[.)]\s+(.*)$/.exec(line)
    const item = bullet ?? numbered
    if (item) {
      const tag = bullet ? 'ul' : 'ol'
      flushParagraph()
      if (list && list.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push(item[1])
      continue
    }
    if (list) {
      // An indented line continues the previous item; anything else ends the list.
      if (/^\s+\S/.test(line)) {
        list.items[list.items.length - 1] += `\n${line.trim()}`
        continue
      }
      flushList()
    }
    paragraph.push(line)
  }
  flush()
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
