/**
 * Strict colour parsing for status page theme tokens. Values end up inside a `<style>` tag, so only
 * a closed grammar is accepted — hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) and the functional
 * forms `rgb()`/`rgba()`, `hsl()`/`hsla()` and `oklch()` with plain numeric arguments. Anything
 * else (named colours, `var()`, `calc()`, `url()`, comments, semicolons, braces …) is rejected.
 *
 * The parser also converts to sRGB so presets and the editor can check WCAG contrast.
 */

export interface Rgba {
  /** 0..1, gamma-encoded sRGB (clamped to the gamut). */
  r: number
  g: number
  b: number
  /** 0..1 */
  a: number
}

/** Longest value we accept; real colours are far shorter. */
export const MAX_COLOR_LENGTH = 64

const NUM = String.raw`[+]?(?:\d{1,4}(?:\.\d{1,6})?|\.\d{1,6})`
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/** `name(a b c)` or `name(a b c / alpha)`. */
const MODERN = new RegExp(
  String.raw`^(rgba?|hsla?|oklch)\(\s*(${NUM}(?:%|deg)?)\s+(${NUM}%?)\s+(${NUM}(?:%|deg)?)\s*(?:\/\s*(${NUM}%?)\s*)?\)$`,
  'i',
)
/** Legacy comma syntax: `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`, `hsl(10, 50%, 40%)`. */
const LEGACY = new RegExp(
  String.raw`^(rgba?|hsla?)\(\s*(${NUM}(?:%|deg)?)\s*,\s*(${NUM}%?)\s*,\s*(${NUM}%?)\s*(?:,\s*(${NUM}%?)\s*)?\)$`,
  'i',
)

interface Arg {
  value: number
  unit: '' | '%' | 'deg'
}

const arg = (raw: string): Arg => {
  const unit = raw.endsWith('%') ? '%' : raw.toLowerCase().endsWith('deg') ? 'deg' : ''
  return { value: Number.parseFloat(raw), unit }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function alpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1
  const a = arg(raw)
  const value = a.unit === '%' ? a.value / 100 : a.value
  return value >= 0 && value <= 1 ? value : null
}

function rgbChannel(a: Arg): number | null {
  if (a.unit === 'deg') return null
  const value = a.unit === '%' ? a.value / 100 : a.value / 255
  return value >= 0 && value <= 1 ? value : null
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)]
}

const encodeSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** OKLCH → gamma-encoded sRGB (Björn Ottosson's reference matrices). */
function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  return [encodeSrgb(clamp01(r)), encodeSrgb(clamp01(g)), encodeSrgb(clamp01(bl))]
}

function parseHex(hex: string): Rgba {
  const digits =
    hex.length <= 4
      ? hex
          .split('')
          .map((d) => d + d)
          .join('')
      : hex
  const byte = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16) / 255
  return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) : 1 }
}

function parseFunction(name: string, args: string[], alphaRaw: string | undefined): Rgba | null {
  const a = alpha(alphaRaw)
  if (a === null) return null
  const [x, y, z] = args.map(arg)
  const fn = name.toLowerCase()

  if (fn === 'rgb' || fn === 'rgba') {
    const r = rgbChannel(x)
    const g = rgbChannel(y)
    const b = rgbChannel(z)
    if (r === null || g === null || b === null) return null
    return { r, g, b, a }
  }

  if (fn === 'hsl' || fn === 'hsla') {
    if (x.unit === '%' || y.unit !== '%' || z.unit !== '%') return null
    if (y.value > 100 || z.value > 100) return null
    const [r, g, b] = hslToRgb(x.value, y.value / 100, z.value / 100)
    return { r, g, b, a }
  }

  // oklch(L C H): L as 0..1 or 0..100%, C as a number (or % of 0.4), H in degrees.
  if (x.unit === 'deg' || z.unit === '%') return null
  const l = x.unit === '%' ? x.value / 100 : x.value
  const c = y.unit === '%' ? (y.value / 100) * 0.4 : y.value
  if (l > 1 || c > 0.5) return null
  const [r, g, b] = oklchToRgb(l, c, z.value)
  return { r, g, b, a }
}

/** sRGB of a colour, or null when the value is not an accepted colour. */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (value.length === 0 || value.length > MAX_COLOR_LENGTH) return null

  const hex = HEX.exec(value)
  if (hex) return parseHex(hex[1])

  const match = MODERN.exec(value) ?? LEGACY.exec(value)
  if (!match) return null
  return parseFunction(match[1], [match[2], match[3], match[4]], match[5])
}

export const isValidColor = (input: unknown): boolean => parseColor(input) !== null

/** Canonical spelling: trimmed, lower-case, single spaces. Only call on valid colours. */
export const normalizeColor = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\/\s*/g, ' / ')

/** WCAG 2 relative luminance. Alpha is ignored (tokens are treated as opaque). */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 2 contrast ratio between two colours (1..21), or null when either is invalid. */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return null
  const la = relativeLuminance(ca)
  const lb = relativeLuminance(cb)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `#rrggbb` for `<input type="color">` (alpha dropped), or null for invalid input. */
export function toHex(input: string): string | null {
  const c = parseColor(input)
  if (!c) return null
  const byte = (n: number) =>
    Math.round(clamp01(n) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`
}
