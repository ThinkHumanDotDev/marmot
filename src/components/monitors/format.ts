/**
 * Presentation helpers shared by the monitor pages. Pure functions, safe on server and client.
 */
import type { Monitor } from '@/payload-types'
import type { MonitorStatusKey } from '@/stores/monitor-store'

export type MonitorStatus = NonNullable<NonNullable<Monitor['status']>['lastStatus']>

/** `status.lastStatus` → store/status-dot vocabulary (`unknown` before the first beat). */
export function statusKey(
  status: MonitorStatus | null | undefined,
  active: boolean | null | undefined = true,
): MonitorStatusKey {
  if (!status) return 'unknown'
  if (active === false) return 'unknown'
  return status
}

/** Human label for the status badge, including paused. */
export function statusText(
  status: MonitorStatus | null | undefined,
  active: boolean | null | undefined = true,
): string {
  if (active === false) return 'Paused'
  switch (status) {
    case 'up':
      return 'Up'
    case 'down':
      return 'Down'
    case 'pending':
      return 'Pending'
    case 'maintenance':
      return 'Maintenance'
    default:
      return 'No data'
  }
}

/** What the monitor watches: URL for HTTP types, host[:port] for network types, nothing otherwise. */
export function monitorTarget(
  monitor: Pick<Monitor, 'type' | 'url' | 'hostname' | 'port' | 'dnsResolveType'>,
): string | null {
  switch (monitor.type) {
    case 'http':
    case 'keyword':
    case 'json-query':
      return monitor.url ?? null
    case 'port':
      return monitor.hostname ? `${monitor.hostname}:${monitor.port ?? ''}` : null
    case 'ping':
      return monitor.hostname ?? null
    case 'dns':
      return monitor.hostname
        ? `${monitor.hostname}${monitor.dnsResolveType ? ` (${monitor.dnsResolveType})` : ''}`
        : null
    default:
      return null
  }
}

export function formatPing(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
  return `${Math.round(ms)} ms`
}

/** 0..1 → "99.95%" (two decimals, trimmed to whole numbers when exact). */
export function formatUptime(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '–'
  const pct = fraction * 100
  const rounded = Math.round(pct * 100) / 100
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)}%`
}

const dateTime = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return '–'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '–' : dateTime.format(date)
}

const TYPE_LABELS: Record<string, string> = {
  http: 'HTTP(s)',
  keyword: 'HTTP(s) - Keyword',
  'json-query': 'HTTP(s) - Json Query',
  port: 'TCP Port',
  ping: 'Ping',
  dns: 'DNS',
  push: 'Push',
  group: 'Group',
  manual: 'Manual',
}

/** Display label of a monitor type (falls back to the raw slug for types added later). */
export function humanTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

/** "3 minutes ago" style relative time for the header. */
export function formatRelative(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return 'never'
  const t = (value instanceof Date ? value : new Date(value)).getTime()
  if (Number.isNaN(t)) return 'never'
  const seconds = Math.max(0, Math.round((now - t) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
