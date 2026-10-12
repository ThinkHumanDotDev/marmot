'use client'

import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { eventPath } from '@/lib/status-page-events'
import type { DayState } from '@/lib/uptime-history'
import { cn } from '@/lib/utils'
import type { PublicUptimeDay } from '@/server/status-pages/public'

const colour: Record<DayState, string> = {
  nodata: 'bg-muted-foreground/15',
  up: 'bg-status-up',
  maintenance: 'bg-status-maintenance',
  degraded: 'bg-status-degraded',
  partial: 'bg-status-pending',
  down: 'bg-status-down',
}

const CLOSE_DELAY_MS = 150

type Formatter = ReturnType<typeof useFormatter>

/** `99.98%`, or `100%` once the value rounds to it. */
const percent = (format: Formatter, value: number): string =>
  value >= 0.99995 ? format.number(1, 'wholePercent') : format.number(value, 'percent')

const utcDate = (format: Formatter, date: string): string =>
  format.dateTime(new Date(`${date}T00:00:00Z`), 'utcDate')

/**
 * Daily uptime bars of a status page component (#112): one bar per UTC day, oldest left, coloured by
 * the day's worst state. Hovering, focusing or tapping a bar opens its details (uptime, downtime,
 * the day's incidents and maintenance with links to their pages). The bars are one tab stop; the
 * arrow keys move between days.
 */
export function UptimeBars({
  days,
  uptime,
  basePath,
  className,
}: {
  days: PublicUptimeDay[]
  /** Uptime over the window; omitted when the page hides the percentage. */
  uptime?: number | null
  /** Path of the public page (`/status/<slug>`, or `''` on a custom domain) for the links. */
  basePath: string
  className?: string
}) {
  const t = useTranslations('statusPages.uptime')
  const tPublic = useTranslations('statusPages.public')
  const format = useFormatter()
  const [active, setActive] = React.useState<number | null>(null)
  const [focusIndex, setFocusIndex] = React.useState(days.length - 1)
  const bars = React.useRef<(HTMLButtonElement | null)[]>([])
  const anchor = React.useRef<HTMLButtonElement | null>(null)
  const closeTimer = React.useRef<number | undefined>(undefined)

  const cancelClose = () => window.clearTimeout(closeTimer.current)
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setActive(null), CLOSE_DELAY_MS)
  }
  const show = (index: number) => {
    cancelClose()
    anchor.current = bars.current[index] ?? null
    setActive(index)
  }
  React.useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const stateLabel = (day: PublicUptimeDay) => t(`state.${day.state}`)
  const barLabel = (day: PublicUptimeDay) =>
    typeof day.uptime === 'number'
      ? t('barLabelWithUptime', {
          date: utcDate(format, day.date),
          state: stateLabel(day),
          uptime: percent(format, day.uptime),
        })
      : t('barLabel', { date: utcDate(format, day.date), state: stateLabel(day) })

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const next =
      event.key === 'ArrowLeft'
        ? index - 1
        : event.key === 'ArrowRight'
          ? index + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? days.length - 1
              : null
    if (next === null || next < 0 || next >= days.length) return
    event.preventDefault()
    setFocusIndex(next)
    bars.current[next]?.focus()
  }

  const duration = (seconds: number): string => {
    if (seconds < 60) return t('duration.lessThanMinute')
    const minutes = Math.round(seconds / 60)
    const hours = Math.floor(minutes / 60)
    return hours > 0
      ? t('duration.hours', { hours, minutes: minutes % 60 })
      : t('duration.minutes', { minutes })
  }

  const day = active !== null ? days[active] : undefined

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)} data-uptime-bars={days.length}>
      <Popover
        open={day !== undefined}
        onOpenChange={(open) => {
          if (!open) setActive(null)
        }}
      >
        <PopoverAnchor virtualRef={anchor as React.RefObject<HTMLButtonElement>} />
        <div
          role="group"
          aria-label={t('groupLabel', { days: days.length })}
          className="flex h-8 items-stretch gap-px"
          onPointerLeave={scheduleClose}
        >
          {days.map((entry, index) => (
            <button
              key={entry.date}
              ref={(el) => {
                bars.current[index] = el
              }}
              type="button"
              tabIndex={index === focusIndex ? 0 : -1}
              aria-label={barLabel(entry)}
              aria-expanded={active === index}
              data-day={entry.date}
              data-state={entry.state}
              className={cn(
                'min-w-0 flex-1 rounded-[2px] transition-opacity hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none',
                colour[entry.state],
              )}
              onPointerEnter={() => show(index)}
              onFocus={() => {
                setFocusIndex(index)
                show(index)
              }}
              onBlur={scheduleClose}
              onClick={() => show(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            />
          ))}
        </div>
        {day && (
          <PopoverContent
            side="top"
            className="w-64 p-3 text-xs"
            data-uptime-day={day.date}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
            onFocus={cancelClose}
            onBlur={scheduleClose}
          >
            <p className="font-medium">{utcDate(format, day.date)}</p>
            <p className="mt-1 text-muted-foreground">
              {stateLabel(day)}
              {typeof day.uptime === 'number' &&
                ` · ${t('percent', { value: percent(format, day.uptime) })}`}
            </p>
            {typeof day.downtimeSeconds === 'number' && day.state !== 'nodata' && (
              <p className="mt-1 text-muted-foreground" data-downtime={day.downtimeSeconds}>
                {day.downtimeSeconds > 0
                  ? t('downFor', { duration: duration(day.downtimeSeconds) })
                  : t('noDowntime')}
              </p>
            )}
            {day.incidents.length > 0 && (
              <div className="mt-2">
                <p className="font-medium">{t('incidents')}</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {day.incidents.map((incident) => (
                    <li key={incident.id}>
                      <a
                        href={`${basePath}${eventPath('incident', incident.id)}`}
                        className="underline-offset-4 hover:underline"
                        data-incident-link={incident.id}
                      >
                        {incident.title}
                      </a>
                      {incident.impact && incident.impact !== 'operational' && (
                        <span className="text-muted-foreground">
                          {' '}
                          · {tPublic(`impact.${incident.impact}`)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {day.maintenance.length > 0 && (
              <div className="mt-2">
                <p className="font-medium">{t('maintenance')}</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {day.maintenance.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`${basePath}${eventPath('maintenance', item.id)}`}
                        className="underline-offset-4 hover:underline"
                        data-maintenance-link={item.id}
                      >
                        {item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </PopoverContent>
        )}
      </Popover>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{t('daysAgo', { days: days.length })}</span>
        {uptime !== undefined && (
          <span className="tabular-nums" data-window-uptime>
            {uptime === null ? t('noData') : t('percent', { value: percent(format, uptime) })}
          </span>
        )}
        <span>{t('today')}</span>
      </div>
    </div>
  )
}
