/**
 * Wall-clock date pickers in a given time zone (#271). `datetime-local` inputs hold a time without
 * a zone; the browser would read it in its own zone, so admins in another zone than their status
 * page (or organization) would type one time and visitors would see another. These helpers read
 * and write the inputs in an explicit zone instead. Pure functions, shared by client forms and
 * server pages.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

/** `YYYY-MM-DDTHH:mm` (`datetime-local`), optional seconds, optional offset (an ISO instant). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/

/** `datetime-local` value showing `date` as a wall-clock time in `timeZone` (minutes precision). */
export const toZonedInput = (date: Date, timeZone: string): string =>
  formatInTimeZone(date, timeZone, "yyyy-MM-dd'T'HH:mm")

/**
 * The instant a `datetime-local` value means in `timeZone`, or null for an empty or malformed
 * value. Values with an offset (ISO instants stored by API clients) are taken as they are.
 */
export function fromZonedInput(value: string | null | undefined, timeZone: string): Date | null {
  if (!value || !DATE_TIME.test(value)) return null
  const date = HAS_OFFSET.test(value) ? new Date(value) : fromZonedTime(value, timeZone)
  return Number.isNaN(date.getTime()) ? null : date
}

/** `value` (a wall-clock time in `timeZone`) moved by `minutes`, as a wall-clock time again. */
export function addMinutesInZone(
  value: string | null | undefined,
  minutes: number,
  timeZone: string,
): string | null {
  const start = fromZonedInput(value, timeZone)
  return start ? toZonedInput(new Date(start.getTime() + minutes * 60_000), timeZone) : null
}
