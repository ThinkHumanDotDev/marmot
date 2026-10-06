import type { Formats } from 'next-intl'

/**
 * Named date and number formats shared by server components, client islands and the worker.
 * Use them through `useFormatter()` / `getFormatter()` (`format.dateTime(date, 'short')`) so every
 * timestamp renders with the request's locale and an explicit time zone; never call
 * `toLocaleString()` on a `Date` in UI code.
 */
export const formats = {
  dateTime: {
    /** `Oct 6, 2026, 10:00 AM` */
    short: { dateStyle: 'medium', timeStyle: 'short' },
    /** `Oct 6, 2026, 10:00 AM GMT+2`: for public pages where visitors are in other zones. */
    zoned: {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    },
    /** `Oct 6, 2026` */
    date: { dateStyle: 'medium' },
    /** `10:00 AM` */
    time: { timeStyle: 'short' },
  },
  number: {
    /** `99.98%` */
    percent: { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 },
    /** `100%` */
    wholePercent: { style: 'percent', maximumFractionDigits: 0 },
    integer: { maximumFractionDigits: 0 },
  },
} satisfies Formats

export type AppFormats = typeof formats

/**
 * The time zone used when nothing more specific is known. Rendering with an explicit zone keeps
 * the server HTML and the client hydration identical; organizations and status pages pass their
 * own zone (`organizations.settings.timezone`) where they are known.
 */
export const DEFAULT_TIME_ZONE = 'UTC'

/** `true` when `Intl` knows the IANA zone (`Europe/Berlin`), `false` for `SAME_AS_SERVER` or typos. */
export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** `zone` when valid, otherwise `DEFAULT_TIME_ZONE`. */
export const timeZoneOrDefault = (zone: string | null | undefined): string =>
  isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE
