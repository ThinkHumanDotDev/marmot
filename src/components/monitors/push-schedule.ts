/**
 * Plain-language push schedules ("Every day at 02:00 · Europe/Berlin"). A hook built on next-intl's
 * `useTranslations` / `useFormatter`, so it works in server components (non-async) and client
 * components alike.
 */
import { useFormatter, useTranslations } from 'next-intl'

import { describeCron, type PushScheduleType } from '@/lib/push-schedule'
import { humanDuration } from '@/lib/validation/monitor'
import { SAME_AS_SERVER } from '@/lib/validation/maintenance'

export interface PushScheduleLike {
  interval?: number | null
  pushSchedule?: PushScheduleType | null
  pushCron?: string | null
  pushTimezone?: string | null
}

/** The zone a cron schedule runs in: its own, or the organization's (`SAME_AS_SERVER`). */
export const pushScheduleZone = (
  schedule: Pick<PushScheduleLike, 'pushTimezone'>,
  orgTimeZone: string,
): string =>
  schedule.pushTimezone && schedule.pushTimezone !== SAME_AS_SERVER
    ? schedule.pushTimezone
    : orgTimeZone

/** Sunday, January 4th 2026 (UTC): weekday `d` is this date plus `d` days. */
const SUNDAY = Date.UTC(2026, 0, 4)

export function usePushScheduleText() {
  const t = useTranslations('monitors.push.schedule')
  const tDuration = useTranslations('common.duration')
  const format = useFormatter()

  const duration = (seconds: number) =>
    humanDuration(seconds, (unit, count) => tDuration(unit, { count }))

  /** "Every 1 hour", "Every day at 02:00 · Europe/Berlin", or the raw cron expression. */
  return (schedule: PushScheduleLike, orgTimeZone: string): string => {
    if (schedule.pushSchedule !== 'cron') {
      return t('interval', { duration: duration(schedule.interval ?? 60) })
    }
    const zone = pushScheduleZone(schedule, orgTimeZone)
    const pattern = schedule.pushCron?.trim() ?? ''
    const described = describeCron(pattern)
    let text: string
    switch (described?.kind) {
      case 'everyMinute':
        text = t('everyMinute')
        break
      case 'everyMinutes':
        text = t('everyMinutes', { minutes: described.minutes })
        break
      case 'hourly':
        text = t('hourly', { minute: described.minute })
        break
      case 'everyHours':
        text = t('everyHours', { hours: described.hours, minute: described.minute })
        break
      case 'daily':
        text = t('daily', { time: described.time })
        break
      case 'weekly':
        text = t('weekly', {
          weekdays: format.list(
            described.weekdays.map((day) =>
              format.dateTime(new Date(SUNDAY + day * 86_400_000), 'weekday', {
                timeZone: 'UTC',
              }),
            ),
          ),
          time: described.time,
        })
        break
      case 'monthly':
        text = t('monthly', { day: described.day, time: described.time })
        break
      default:
        text = t('cronRaw', { pattern })
    }
    return t('cron', { schedule: text, timeZone: zone })
  }
}
