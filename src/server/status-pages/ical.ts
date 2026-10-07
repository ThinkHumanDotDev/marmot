/**
 * iCalendar (RFC 5545) feed of a status page's maintenance: one `VEVENT` per persisted occurrence
 * (`./maintenance-events`) with a stable `UID` (the occurrence id), a `SEQUENCE` that grows with every
 * change of the occurrence or its maintenance, and `STATUS:CANCELLED` for cancelled occurrences and
 * unfinished ones of a paused maintenance. A manual maintenance's occurrence has no planned end and
 * appears once it is completed.
 */
import { getTranslator } from '@/i18n/translator'
import type { Locale } from '@/i18n/locales'
import type { StatusPage } from '@/payload-types'

import { isCancelledEvent, type MaintenanceEvent } from './maintenance-events'
import { serverUrl } from './urls'

/** How often calendar clients should refresh (`X-PUBLISHED-TTL`, `REFRESH-INTERVAL`). */
export const CALENDAR_TTL = 'PT1H'

/** Escapes a TEXT value (RFC 5545 §3.3.11). */
export const escapeIcalText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1): continuation lines start with a space, and a
 * multi-byte UTF-8 character is never split.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const parts: string[] = []
  let current = ''
  let size = 0
  let limit = 75
  for (const char of line) {
    const bytes = encoder.encode(char).length
    if (size + bytes > limit) {
      parts.push(current)
      current = ''
      size = 0
      limit = 74 // the leading space of a continuation line counts
    }
    current += char
    size += bytes
  }
  parts.push(current)
  return parts.join('\r\n ')
}

/** `20261007T020000Z` */
export const icalDate = (value: string | Date): string =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

export interface CalendarInput {
  page: Pick<StatusPage, 'title'>
  pageUrl: string
  locale: Locale
  events: readonly MaintenanceEvent[]
}

export function renderMaintenanceCalendar({
  page,
  pageUrl,
  locale,
  events,
}: CalendarInput): string {
  const t = getTranslator(locale)
  let host = 'marmot.invalid'
  try {
    host = new URL(serverUrl()).hostname || host
  } catch {
    // keep the placeholder
  }

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Marmot//Status page maintenance//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcalText(t('statusPages.machine.calendarName', { title: page.title }))}`,
    `NAME:${escapeIcalText(t('statusPages.machine.calendarName', { title: page.title }))}`,
    `X-PUBLISHED-TTL:${CALENDAR_TTL}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${CALENDAR_TTL}`,
    `URL:${pageUrl}`,
  ]

  for (const event of events) {
    const end = event.end ?? event.completedAt
    if (!end) continue
    lines.push(
      'BEGIN:VEVENT',
      `UID:maintenance-occurrence-${event.id}@${host}`,
      `DTSTAMP:${icalDate(event.updatedAt)}`,
      `CREATED:${icalDate(event.createdAt)}`,
      `LAST-MODIFIED:${icalDate(event.updatedAt)}`,
      `SEQUENCE:${event.sequence}`,
      `DTSTART:${icalDate(event.start)}`,
      `DTEND:${icalDate(end)}`,
      `SUMMARY:${escapeIcalText(event.title)}`,
      ...(event.description ? [`DESCRIPTION:${escapeIcalText(event.description)}`] : []),
      `STATUS:${isCancelledEvent(event) ? 'CANCELLED' : 'CONFIRMED'}`,
      'TRANSP:TRANSPARENT',
      `URL:${pageUrl}`,
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
