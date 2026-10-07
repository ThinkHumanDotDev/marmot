/**
 * Presentation helpers shared by the monitor pages. `statusKey` and `monitorTarget` are pure;
 * the text and number helpers come from `useMonitorFormat()`, which reads the request's locale
 * and works in server components (non-async) and client components alike.
 */
import { useFormatter, useTranslations } from 'next-intl'

import {
  isHostMonitorType,
  isPortMonitorType,
  isUrlMonitorType,
  MONITOR_TYPE_NAMES,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
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

/** What the monitor watches: URL for HTTP types, host[:port] for network types, nothing otherwise. */
export function monitorTarget(
  monitor: Pick<Monitor, 'type' | 'url' | 'hostname' | 'port' | 'dnsResolveType'> &
    Partial<Pick<Monitor, 'dockerContainer'>>,
): string | null {
  if (monitor.type === 'docker') return monitor.dockerContainer ?? null
  if (monitor.type === 'dns') {
    return monitor.hostname
      ? `${monitor.hostname}${monitor.dnsResolveType ? ` (${monitor.dnsResolveType})` : ''}`
      : null
  }
  if (isUrlMonitorType(monitor.type)) return monitor.url ?? null
  if (isPortMonitorType(monitor.type)) {
    return monitor.hostname ? `${monitor.hostname}:${monitor.port ?? ''}` : null
  }
  if (isHostMonitorType(monitor.type)) return monitor.hostname ?? null
  return null
}

const isKnownType = (type: string): type is MonitorTypeName =>
  (MONITOR_TYPE_NAMES as readonly string[]).includes(type)

const toDate = (value: string | number | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Locale-aware formatters for the monitor pages. Pass `timeZone` from server components (the
 * organization's zone); client components inherit it from `OrgTimeZoneProvider`.
 */
export function useMonitorFormat(timeZone?: string) {
  const t = useTranslations('monitors')
  const tStatus = useTranslations('common.status')
  const tRelative = useTranslations('common.relativeTime')
  const format = useFormatter()

  return {
    /** Badge label, including paused. */
    statusText(
      status: MonitorStatus | null | undefined,
      active: boolean | null | undefined = true,
    ): string {
      if (active === false) return t('status.paused')
      return status ? tStatus(status) : t('status.noData')
    },

    ping(ms: number | null | undefined): string {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
      return t('format.ping', { ms: Math.round(ms) })
    },

    /** 0..1 → "99.95%" (two decimals, whole numbers when exact). */
    uptime(fraction: number | null | undefined): string {
      if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '–'
      const basisPoints = Math.round(fraction * 10_000)
      return format.number(
        basisPoints / 10_000,
        basisPoints % 100 === 0 ? 'wholePercent' : 'percent',
      )
    },

    /** Date and time to the second, in the organization's zone. */
    dateTime(value: string | number | Date | null | undefined): string {
      const date = toDate(value)
      if (!date) return '–'
      return format.dateTime(date, 'precise', timeZone ? { timeZone } : undefined)
    },

    /** "3 min ago" style relative time for the header. */
    relative(value: string | Date | null | undefined, now = Date.now()): string {
      const date = toDate(value)
      if (!date) return tRelative('never')
      const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))
      if (seconds < 45) return tRelative('justNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return tRelative('minutes', { count: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 48) return tRelative('hours', { count: hours })
      return tRelative('days', { count: Math.round(hours / 24) })
    },

    /** Display label of a monitor type (falls back to the raw slug for types added later). */
    typeLabel(type: string): string {
      return isKnownType(type) ? t(`types.${type}.label`) : type
    },
  }
}
