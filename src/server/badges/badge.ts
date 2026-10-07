/**
 * Badge rendering: pure functions that turn monitor data + query parameters into a `badge-maker`
 * format object (and the SVG). Nothing here touches the database, so the whole parameter matrix is
 * unit-testable.
 *
 * Port of the `/api/badge/:id/*` handlers in Uptime Kuma 2.5.5 `server/routers/api-router.js`,
 * `badgeConstants` from `src/util.ts` and `percentageToColor` / `filterAndJoin` from
 * `server/util-server.js` (MIT, Louis Lam). See THIRD_PARTY_NOTICES.md.
 */
import { makeBadge } from 'badge-maker'

import type { StatsRange } from '@/server/stats/uptime-calculator'

export const BADGE_TYPES = [
  'status',
  'uptime',
  'ping',
  'avg-response',
  'cert-exp',
  'response',
] as const
export type BadgeType = (typeof BADGE_TYPES)[number]

export const isBadgeType = (value: unknown): value is BadgeType =>
  typeof value === 'string' && (BADGE_TYPES as readonly string[]).includes(value)

export const BADGE_STYLES = ['plastic', 'flat', 'flat-square', 'for-the-badge', 'social'] as const
export type BadgeStyle = (typeof BADGE_STYLES)[number]

/** Uptime Kuma `badgeConstants`. */
export const badgeConstants = {
  naColor: '#999',
  defaultUpColor: '#66c20a',
  defaultWarnColor: '#eed202',
  defaultDownColor: '#c2290a',
  defaultPendingColor: '#f8a306',
  defaultMaintenanceColor: '#1747f5',
  defaultPingColor: 'blue', // as defined by badge-maker / shields.io
  defaultStyle: 'flat' as BadgeStyle,
  defaultPingValueSuffix: 'ms',
  defaultPingLabelSuffix: 'h',
  defaultUptimeValueSuffix: '%',
  defaultUptimeLabelSuffix: 'h',
  defaultCertExpValueSuffix: ' days',
  defaultCertExpLabelSuffix: 'h',
  // Values come from the default notification times
  defaultCertExpireWarnDays: 14,
  defaultCertExpireDownDays: 7,
} as const

/** Query parameters every badge understands (a superset; each type reads what it needs). */
export interface BadgeParams {
  label?: string
  labelPrefix?: string
  labelSuffix?: string
  prefix?: string
  suffix?: string
  color?: string
  labelColor?: string
  style?: string
  upLabel?: string
  downLabel?: string
  pendingLabel?: string
  maintenanceLabel?: string
  degradedLabel?: string
  upColor?: string
  downColor?: string
  pendingColor?: string
  maintenanceColor?: string
  degradedColor?: string
  warnColor?: string
  warnDays?: string
  downDays?: string
  /** cert-exp: show the expiry date instead of the remaining days. */
  date?: string
}

/** What `badge-maker` consumes. */
export interface BadgeFormat {
  label?: string
  message: string
  color?: string
  labelColor?: string
  style?: BadgeStyle
}

export type BadgeStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded'

/** Data the route resolves before rendering; every field is optional so "N/A" paths are easy. */
export interface BadgeData {
  status?: BadgeStatus | null
  /** Ratio 0..1 (uptime badge). */
  uptime?: number | null
  /** Milliseconds (ping / avg-response badges). */
  avgPing?: number | null
  /** Milliseconds of the latest heartbeat (response badge). */
  lastPing?: number | null
  /** Resolved window (uptime / ping / avg-response). */
  range?: StatsRange
  /** Certificate information (cert-exp badge). */
  cert?: BadgeCertInfo | null
}

export interface BadgeCertInfo {
  valid: boolean
  daysRemaining?: number | null
  validTo?: string | null
}

/** Pull the known parameters out of a query string; unknown keys are ignored. */
export function badgeParamsFromSearch(search: URLSearchParams): BadgeParams {
  const params: BadgeParams = {}
  const keys: (keyof BadgeParams)[] = [
    'label',
    'labelPrefix',
    'labelSuffix',
    'prefix',
    'suffix',
    'color',
    'labelColor',
    'style',
    'upLabel',
    'downLabel',
    'pendingLabel',
    'maintenanceLabel',
    'degradedLabel',
    'upColor',
    'downColor',
    'pendingColor',
    'maintenanceColor',
    'degradedColor',
    'warnColor',
    'warnDays',
    'downDays',
    'date',
  ]
  for (const key of keys) {
    const value = search.get(key)
    if (value !== null) params[key] = value
  }
  return params
}

/**
 * Kuma accepts `24h` / `30d` / `1y` and bare hour counts (`24`, `720`, `8760`). Marmot's stats
 * only keep those three windows, so everything else is rejected.
 */
export function parseBadgeDuration(raw: string | undefined | null): StatsRange | null {
  const value = (raw ?? '24h').trim().toLowerCase()
  const hours = /^\d+$/.test(value) ? `${value}h` : value
  switch (hours) {
    case '24h':
    case '1d':
      return '24h'
    case '720h':
    case '30d':
      return '30d'
    case '8760h':
    case '365d':
    case '1y':
      return '1y'
    default:
      return null
  }
}

/** Label text Kuma prints for a window: `24h` → `24` + `h`, `30d` → `30` + `d`. */
export function durationLabel(range: StatsRange): { value: string; unit: string } {
  switch (range) {
    case '24h':
      return { value: '24', unit: 'h' }
    case '30d':
      return { value: '30', unit: 'd' }
    case '1y':
      return { value: '1', unit: 'y' }
  }
}

/** Kuma's `filterAndJoin`: drop empty parts and concatenate. */
export const filterAndJoin = (parts: (string | number | undefined | null)[], connector = '') =>
  parts.filter((part) => part !== undefined && part !== null && part !== '').join(connector)

const hslToHex = (h: number, s: number, l: number): string => {
  const sat = s / 100
  const light = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`
}

/** Kuma's `percentageToColor`: 0 → red (hue 10), 1 → green (hue 90), 90% saturation, 40% light. */
export function percentageToColor(percentage: number, maxHue = 90, minHue = 10): string {
  if (!Number.isFinite(percentage)) return badgeConstants.naColor
  const clamped = Math.min(1, Math.max(0, percentage))
  const hue = clamped * (maxHue - minHue) + minHue
  return hslToHex(hue, 90, 40)
}

const parseStyle = (style: string | undefined): BadgeStyle =>
  (BADGE_STYLES as readonly string[]).includes(style ?? '')
    ? (style as BadgeStyle)
    : badgeConstants.defaultStyle

const naBadge = (style: BadgeStyle, message = 'N/A'): BadgeFormat => ({
  style,
  message,
  color: badgeConstants.naColor,
})

const toInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Build the badge format for `type` from resolved data and query parameters. */
export function buildBadge(type: BadgeType, data: BadgeData, params: BadgeParams): BadgeFormat {
  const style = parseStyle(params.style)

  switch (type) {
    case 'status': {
      const {
        label = 'Status',
        upLabel = 'Up',
        downLabel = 'Down',
        pendingLabel = 'Pending',
        maintenanceLabel = 'Maintenance',
        degradedLabel = 'Degraded',
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        pendingColor = badgeConstants.defaultPendingColor,
        maintenanceColor = badgeConstants.defaultMaintenanceColor,
        // Marmot addition (#93): same yellow as the status page badge's "Degraded performance".
        degradedColor = badgeConstants.defaultWarnColor,
      } = params
      const byStatus: Record<BadgeStatus, { message: string; color: string }> = {
        up: { message: upLabel, color: upColor },
        down: { message: downLabel, color: downColor },
        pending: { message: pendingLabel, color: pendingColor },
        maintenance: { message: maintenanceLabel, color: maintenanceColor },
        degraded: { message: degradedLabel, color: degradedColor },
      }
      const match = data.status ? byStatus[data.status] : undefined
      if (!match) return { ...naBadge(style), label }
      return { style, label, message: match.message, color: match.color }
    }

    case 'uptime': {
      const range = data.range ?? '24h'
      const { value, unit } = durationLabel(range)
      const {
        label,
        labelPrefix,
        labelSuffix = unit === 'h' ? badgeConstants.defaultUptimeLabelSuffix : unit,
        prefix,
        suffix = badgeConstants.defaultUptimeValueSuffix,
        color,
        labelColor,
      } = params
      if (typeof data.uptime !== 'number' || !Number.isFinite(data.uptime)) return naBadge(style)
      // limit the displayed uptime percentage to four (two, when displayed as percent) decimal digits
      const cleanUptime = (data.uptime * 100).toPrecision(4)
      return {
        style,
        color: color ?? percentageToColor(data.uptime),
        labelColor: labelColor ?? '',
        label: filterAndJoin([labelPrefix, label ?? `Uptime (${value}${labelSuffix})`]),
        message: filterAndJoin([prefix, cleanUptime, suffix]),
      }
    }

    case 'ping':
    case 'avg-response': {
      const range = data.range ?? '24h'
      const { value, unit } = durationLabel(range)
      const defaultLabelSuffix =
        type === 'ping' ? (unit === 'h' ? badgeConstants.defaultPingLabelSuffix : unit) : undefined
      const {
        label,
        labelPrefix,
        labelSuffix = defaultLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
      } = params
      if (typeof data.avgPing !== 'number' || !Number.isFinite(data.avgPing)) {
        return naBadge(style)
      }
      const avgPing = Math.trunc(data.avgPing)
      const defaultLabel =
        type === 'ping'
          ? `Avg. Ping (${value}${labelSuffix ?? ''})`
          : `Avg. Response (${value}${unit})`
      return {
        style,
        color,
        labelColor: labelColor ?? '',
        label:
          type === 'ping'
            ? filterAndJoin([labelPrefix, label ?? defaultLabel])
            : filterAndJoin([labelPrefix, label ?? defaultLabel, labelSuffix]),
        message: filterAndJoin([prefix, avgPing, suffix]),
      }
    }

    case 'cert-exp': {
      const showDate = params.date !== undefined && params.date !== ''
      const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = showDate ? '' : badgeConstants.defaultCertExpValueSuffix,
        upColor = badgeConstants.defaultUpColor,
        warnColor = badgeConstants.defaultWarnColor,
        downColor = badgeConstants.defaultDownColor,
        labelColor,
      } = params
      const warnDays = toInt(params.warnDays, badgeConstants.defaultCertExpireWarnDays)
      const downDays = toInt(params.downDays, badgeConstants.defaultCertExpireDownDays)

      if (!data.cert) return naBadge(style, 'No/Bad Cert')
      if (!data.cert.valid) return { style, message: 'Bad Cert', color: downColor }
      const daysRemaining = Math.trunc(data.cert.daysRemaining ?? Number.NaN)
      if (!Number.isFinite(daysRemaining)) return naBadge(style, 'No/Bad Cert')

      const color =
        daysRemaining > warnDays ? upColor : daysRemaining > downDays ? warnColor : downColor
      return {
        style,
        color,
        labelColor: labelColor ?? '',
        label: filterAndJoin([labelPrefix, label ?? 'Cert Exp.', labelSuffix]),
        message: filterAndJoin([prefix, showDate ? data.cert.validTo : daysRemaining, suffix]),
      }
    }

    case 'response': {
      const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
      } = params
      if (typeof data.lastPing !== 'number' || !Number.isFinite(data.lastPing) || !data.lastPing) {
        return naBadge(style)
      }
      return {
        style,
        color,
        labelColor: labelColor ?? '',
        label: filterAndJoin([labelPrefix, label ?? 'Response', labelSuffix]),
        message: filterAndJoin([prefix, Math.trunc(data.lastPing), suffix]),
      }
    }
  }
}

/** Render a format to SVG. Invalid colours fall back to the badge-maker default (grey). */
export function renderBadge(format: BadgeFormat): string {
  const safe: BadgeFormat = { ...format }
  try {
    return makeBadge(safe)
  } catch {
    // badge-maker throws on unknown style values or non-string fields; retry with sane defaults.
    return makeBadge({
      style: badgeConstants.defaultStyle,
      label: safe.label ?? '',
      message: String(safe.message ?? 'N/A'),
      color: badgeConstants.naColor,
    })
  }
}
