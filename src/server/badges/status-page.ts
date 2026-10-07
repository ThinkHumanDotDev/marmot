/**
 * Overall status-page badge (issue #110): one badge for a whole page, for README and website footers.
 * Pure functions (no database) so every state and option is unit-testable.
 *
 * Two renderers:
 * - the default **pill** (coloured dot + message) with `theme`, `size` and `variant`;
 * - the shields.io renderer of the monitor badges (`badge.ts`) when `style=` is given, with the same
 *   left-hand `label` (`Status`) and colours as the monitor `status` badge.
 */
import {
  BADGE_STYLES,
  badgeConstants,
  renderBadge,
  type BadgeFormat,
  type BadgeStyle,
} from './badge'

/** Headline state of a page, least to most severe after `unknown`. */
export const STATUS_PAGE_BADGE_STATES = [
  'unknown',
  'operational',
  'maintenance',
  'degraded',
  'partial',
  'major',
] as const
export type StatusPageBadgeState = (typeof STATUS_PAGE_BADGE_STATES)[number]

/**
 * Badge text per state. Badges are images embedded outside Marmot, so like the monitor badges
 * (`Up`, `Down`, …) they are rendered in English and not localised.
 */
export const STATUS_PAGE_BADGE_MESSAGES: Record<StatusPageBadgeState, string> = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  partial: 'Partial outage',
  major: 'Major outage',
  maintenance: 'Under maintenance',
  unknown: 'Unknown',
}

/** Same palette as the monitor `status` badge (`badgeConstants`). */
export const STATUS_PAGE_BADGE_COLORS: Record<StatusPageBadgeState, string> = {
  operational: badgeConstants.defaultUpColor,
  degraded: badgeConstants.defaultWarnColor,
  partial: badgeConstants.defaultPendingColor,
  major: badgeConstants.defaultDownColor,
  maintenance: badgeConstants.defaultMaintenanceColor,
  unknown: badgeConstants.naColor,
}

/** Left-hand label of the shields renderer; the monitor `status` badge uses the same default. */
export const STATUS_PAGE_BADGE_DEFAULT_LABEL = 'Status'

export const STATUS_PAGE_BADGE_THEMES = ['light', 'dark'] as const
export const STATUS_PAGE_BADGE_SIZES = ['sm', 'md', 'lg', 'xl'] as const
export const STATUS_PAGE_BADGE_VARIANTS = ['default', 'outline'] as const
export type StatusPageBadgeTheme = (typeof STATUS_PAGE_BADGE_THEMES)[number]
export type StatusPageBadgeSize = (typeof STATUS_PAGE_BADGE_SIZES)[number]
export type StatusPageBadgeVariant = (typeof STATUS_PAGE_BADGE_VARIANTS)[number]

export interface StatusPageBadgeOptions {
  theme: StatusPageBadgeTheme
  size: StatusPageBadgeSize
  variant: StatusPageBadgeVariant
  /** Shields style; `null` renders the pill. */
  style: BadgeStyle | null
  /** Label override (pill: a prefix before the message; shields: the left-hand text). */
  label: string | null
}

const MAX_LABEL_LENGTH = 64

const oneOf = <T extends string>(values: readonly T[], raw: string | null, fallback: T): T =>
  raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : fallback

/**
 * Query parameters → options. Unknown values fall back to the defaults (like the monitor badges, a
 * badge never fails because of a typo in its URL); an unknown `style` uses the shields default.
 */
export function statusPageBadgeOptions(search: URLSearchParams): StatusPageBadgeOptions {
  const style = search.get('style')
  const label = search.get('label')
  return {
    theme: oneOf(STATUS_PAGE_BADGE_THEMES, search.get('theme'), 'light'),
    size: oneOf(STATUS_PAGE_BADGE_SIZES, search.get('size'), 'md'),
    variant: oneOf(STATUS_PAGE_BADGE_VARIANTS, search.get('variant'), 'default'),
    style:
      style === null || style === ''
        ? null
        : oneOf(BADGE_STYLES, style, badgeConstants.defaultStyle),
    label: label === null ? null : label.slice(0, MAX_LABEL_LENGTH),
  }
}

/** Shields format for the state (`style=` given). */
export function statusPageBadgeFormat(
  state: StatusPageBadgeState,
  options: Pick<StatusPageBadgeOptions, 'style' | 'label'>,
): BadgeFormat {
  return {
    style: options.style ?? badgeConstants.defaultStyle,
    label: options.label ?? STATUS_PAGE_BADGE_DEFAULT_LABEL,
    message: STATUS_PAGE_BADGE_MESSAGES[state],
    color: STATUS_PAGE_BADGE_COLORS[state],
  }
}

// ---------------------------------------------------------------------------------------------
// Pill renderer

interface SizeSpec {
  height: number
  fontSize: number
  paddingX: number
  dot: number
  gap: number
}

const SIZES: Record<StatusPageBadgeSize, SizeSpec> = {
  sm: { height: 20, fontSize: 11, paddingX: 8, dot: 6, gap: 5 },
  md: { height: 24, fontSize: 12, paddingX: 10, dot: 8, gap: 6 },
  lg: { height: 32, fontSize: 14, paddingX: 12, dot: 9, gap: 8 },
  xl: { height: 40, fontSize: 18, paddingX: 16, dot: 11, gap: 10 },
}

const THEMES: Record<
  StatusPageBadgeTheme,
  { background: string; border: string; text: string; muted: string }
> = {
  light: { background: '#ffffff', border: '#d4d4d8', text: '#18181b', muted: '#52525b' },
  dark: { background: '#18181b', border: '#3f3f46', text: '#fafafa', muted: '#a1a1aa' },
}

const FONT_FAMILY =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,'Noto Sans',sans-serif"

const NARROW = new Set([..."iljtfrI.,:;'|!() "])
const WIDE = new Set([...'mwMW@%'])

/**
 * Approximate advance width of `text` in a Helvetica-like font, in em. The SVG pins the text to this
 * width with `textLength`, so the box always fits whatever font the viewer has.
 */
export function approximateTextWidth(text: string, fontSize: number): number {
  let em = 0
  for (const char of text) {
    if (NARROW.has(char)) em += 0.3
    else if (WIDE.has(char)) em += 0.85
    else if (/[A-Z]/.test(char)) em += 0.68
    else if (/[0-9]/.test(char)) em += 0.56
    else em += 0.54
  }
  return Math.ceil(em * fontSize)
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/** The pill SVG: rounded box, coloured dot, optional muted label, message. */
export function renderStatusPagePill(
  state: StatusPageBadgeState,
  options: Pick<StatusPageBadgeOptions, 'theme' | 'size' | 'variant' | 'label'>,
): string {
  const size = SIZES[options.size]
  const theme = THEMES[options.theme]
  const color = STATUS_PAGE_BADGE_COLORS[state]
  const message = STATUS_PAGE_BADGE_MESSAGES[state]
  const label = options.label?.trim() || null

  const labelWidth = label ? approximateTextWidth(label, size.fontSize) : 0
  const labelGap = label ? Math.round(size.fontSize * 0.4) : 0
  const messageWidth = approximateTextWidth(message, size.fontSize)
  const width =
    size.paddingX * 2 + size.dot + size.gap + labelWidth + labelGap + Math.max(1, messageWidth)
  const { height } = size
  const radius = height / 2
  const baseline = Math.round(height / 2 + size.fontSize * 0.35)
  const dotX = size.paddingX + size.dot / 2
  const textX = size.paddingX + size.dot + size.gap
  const outline = options.variant === 'outline'

  const title = escapeXml(label ? `${label}: ${message}` : message)
  const box = outline
    ? `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius - 0.5}" fill="none" stroke="${color}"/>`
    : `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius - 0.5}" fill="${theme.background}" stroke="${theme.border}"/>`
  const labelText = label
    ? `<text x="${textX}" y="${baseline}" fill="${theme.muted}" textLength="${labelWidth}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>`
    : ''
  const messageText = `<text x="${textX + labelWidth + labelGap}" y="${baseline}" fill="${theme.text}" font-weight="600" textLength="${messageWidth}" lengthAdjust="spacingAndGlyphs">${escapeXml(message)}</text>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}" data-state="${state}">` +
    `<title>${title}</title>` +
    box +
    `<circle cx="${dotX}" cy="${height / 2}" r="${size.dot / 2}" fill="${color}"/>` +
    `<g font-family="${FONT_FAMILY}" font-size="${size.fontSize}">${labelText}${messageText}</g>` +
    `</svg>`
  )
}

/** SVG for `state` with the parsed options: shields when `style` is set, the pill otherwise. */
export function renderStatusPageBadge(
  state: StatusPageBadgeState,
  options: StatusPageBadgeOptions,
): string {
  if (options.style) return renderBadge(statusPageBadgeFormat(state, options))
  return renderStatusPagePill(state, options)
}
