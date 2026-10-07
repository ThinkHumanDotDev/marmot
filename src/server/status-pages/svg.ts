/**
 * Allowlist SVG sanitiser for status page logos and favicons. Uploaded SVGs are served from
 * Marmot's own origin, so they must not carry scripts, event handlers, external references or
 * entity tricks. Rather than trusting a deny list, the document is tokenised and rebuilt from
 * scratch: only allowlisted elements and attributes survive, everything is re-quoted and
 * re-escaped, and anything the tokenizer cannot account for rejects the whole file.
 *
 * Payload additionally runs its own SVG inspection when the media row is created.
 */

export class SvgRejectedError extends Error {
  /** Parser diagnostic (English, technical); the user-facing prefix is `errors.svgRejected`. */
  readonly reason: string
  constructor(reason: string) {
    super(`SVG rejected: ${reason}`)
    this.reason = reason
    this.name = 'SvgRejectedError'
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

/** Shapes, structure, gradients, clipping and simple filters. No script, style, image, a, animate. */
const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComposite',
  'feDropShadow',
  'feFlood',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feOffset',
])

/** Elements whose text content is kept. */
const TEXT_ELEMENTS = new Set(['title', 'desc', 'text', 'tspan'])

const ATTRIBUTES = new Set([
  'id',
  'class',
  'version',
  'viewBox',
  'preserveAspectRatio',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'dx',
  'dy',
  'd',
  'points',
  'pathLength',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'display',
  'visibility',
  'vector-effect',
  'shape-rendering',
  'paint-order',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
  'mask',
  'maskUnits',
  'maskContentUnits',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  'filter',
  'filterUnits',
  'primitiveUnits',
  'in',
  'in2',
  'result',
  'mode',
  'type',
  'values',
  'operator',
  'k1',
  'k2',
  'k3',
  'k4',
  'stdDeviation',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'style',
  'href',
  'xlink:href',
  'xmlns',
  'xmlns:xlink',
  'xml:space',
])

/** CSS properties allowed in `style="…"`. */
const STYLE_PROPERTIES = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'display',
  'visibility',
  'stop-color',
  'stop-opacity',
  'clip-rule',
  'clip-path',
  'mask',
  'filter',
  'mix-blend-mode',
  'isolation',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'letter-spacing',
  'paint-order',
  'vector-effect',
  'shape-rendering',
  'flood-color',
  'flood-opacity',
])

const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});)/gi
const NAME = String.raw`[A-Za-z_][\w.:-]*`
const TAG = new RegExp(
  String.raw`<(\/?)(${NAME})((?:\s+${NAME}\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>`,
  'y',
)
const ATTRIBUTE = new RegExp(String.raw`(${NAME})\s*=\s*(?:"([^"<]*)"|'([^'<]*)')`, 'g')
/** Only same-document references: `url(#id)`. */
const LOCAL_URL = /url\(\s*(['"]?)#[\w.:-]+\1\s*\)/gi

const escapeText = (value: string) => value.replace(ENTITY, '&amp;').replace(/>/g, '&gt;')
const escapeAttribute = (value: string) =>
  value.replace(ENTITY, '&amp;').replace(/"/g, '&quot;').replace(/>/g, '&gt;')

/** Decodes numeric character references so `&#106;avascript:` cannot hide from the checks below. */
const decodeReferences = (value: string) =>
  value
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => safeChar(Number.parseInt(dec, 10)))
    .replace(
      /&(?:quot|apos|lt|gt|amp);/g,
      (m) => ({ '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' })[m]!,
    )

const safeChar = (code: number) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '')

/** True when every `url(…)` is a local fragment and nothing else looks like a resource or script. */
function isSafeValue(raw: string): boolean {
  const value = decodeReferences(raw)
  // Control characters and whitespace are ignored by URL parsers (`java\tscript:`).
  const compact = value.replace(/[\u0000- \u007f]/g, '').toLowerCase()
  if (/javascript:|vbscript:|data:|expression\(|@import|\\|<|\/\*/.test(compact)) return false
  return !/url\(/i.test(value.replace(LOCAL_URL, ''))
}

function sanitizeStyle(raw: string): string | null {
  if (!isSafeValue(raw)) return null
  const declarations: string[] = []
  for (const part of decodeReferences(raw).split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const property = part.slice(0, colon).trim().toLowerCase()
    const value = part.slice(colon + 1).trim()
    if (!STYLE_PROPERTIES.has(property) || value.length === 0) continue
    if (!/^[\w\s#%.,()'"+-]*$/.test(value)) continue
    declarations.push(`${property}:${value}`)
  }
  return declarations.length > 0 ? declarations.join(';') : null
}

function sanitizeAttributes(element: string, source: string, isRoot: boolean): string {
  const out: [string, string][] = []
  const seen = new Set<string>()
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]
    const value = match[2] ?? match[3] ?? ''
    if (!ATTRIBUTES.has(name) || seen.has(name)) continue
    if (name === 'xmlns') continue // re-added below for the root
    if (name === 'xmlns:xlink' && value !== XLINK_NS) continue
    if (name === 'href' || name === 'xlink:href') {
      if (element !== 'use' && !element.endsWith('Gradient') && element !== 'pattern') continue
      if (!/^#[\w.:-]+$/.test(value)) continue
    }
    let cleaned: string | null = value
    if (name === 'style') cleaned = sanitizeStyle(value)
    else if (!isSafeValue(value)) cleaned = null
    if (cleaned === null) continue
    seen.add(name)
    out.push([name, cleaned])
  }
  if (isRoot) out.unshift(['xmlns', SVG_NS])
  return out.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')
}

/**
 * Returns a sanitised copy of `input` or throws `SvgRejectedError` when the document is not a
 * plain, well-formed SVG (DOCTYPEs, entities, CDATA, processing instructions, unbalanced tags).
 */
export function sanitizeSvg(input: string): string {
  let source = input.replace(/^﻿/, '')
  source = source.replace(/^\s*<\?xml\s[^<>]*\?>/, '')
  source = source.replace(/<!--[\s\S]*?-->/g, '')
  if (source.includes('<!') || source.includes('<?')) {
    throw new SvgRejectedError(
      'DOCTYPE, entities, CDATA and processing instructions are not allowed',
    )
  }

  const stack: { name: string; keep: boolean }[] = []
  const parts: string[] = []
  let sawRoot = false
  let rootClosed = false
  let pos = 0

  const keeping = () => stack.every((entry) => entry.keep)

  while (pos < source.length) {
    const next = source.indexOf('<', pos)
    const text = source.slice(pos, next === -1 ? source.length : next)
    if (text.length > 0) {
      if (/[^\s]/.test(text)) {
        if (stack.length === 0) throw new SvgRejectedError('text outside the root element')
        const top = stack[stack.length - 1]
        if (keeping() && TEXT_ELEMENTS.has(top.name)) parts.push(escapeText(text))
      } else if (keeping() && stack.length > 0) {
        parts.push(text)
      }
    }
    if (next === -1) break

    TAG.lastIndex = next
    const tag = TAG.exec(source)
    if (!tag) throw new SvgRejectedError('malformed markup')
    pos = TAG.lastIndex
    const [, closing, name, attributes, selfClosing] = tag

    if (closing) {
      if (attributes.trim() || selfClosing) throw new SvgRejectedError('malformed closing tag')
      const open = stack.pop()
      if (!open || open.name !== name) throw new SvgRejectedError(`unbalanced </${name}>`)
      if (open.keep && keeping()) parts.push(`</${name}>`)
      if (stack.length === 0) rootClosed = true
      continue
    }

    if (rootClosed || (stack.length === 0 && sawRoot)) {
      throw new SvgRejectedError('more than one root element')
    }
    const isRoot = stack.length === 0
    if (isRoot) {
      if (name !== 'svg') throw new SvgRejectedError('the root element must be <svg>')
      sawRoot = true
    }

    const keep = ELEMENTS.has(name)
    if (keep && keeping()) {
      parts.push(
        `<${name}${sanitizeAttributes(name, attributes, isRoot)}${selfClosing ? '/>' : '>'}`,
      )
    }
    if (!selfClosing) stack.push({ name, keep })
    else if (isRoot) rootClosed = true
  }

  if (!sawRoot) throw new SvgRejectedError('no <svg> element')
  if (stack.length > 0) throw new SvgRejectedError(`unclosed <${stack[stack.length - 1].name}>`)
  return parts.join('')
}
