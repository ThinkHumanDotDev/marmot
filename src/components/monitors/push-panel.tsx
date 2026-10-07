import { useTranslations } from 'next-intl'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  crontabPattern,
  evaluatePush,
  PUSH_EVENTS_PER_MONITOR,
  pushGraceMs,
  pushStateOf,
  type PushScheduleSettings,
} from '@/lib/push-schedule'
import { humanDuration } from '@/lib/validation/monitor'
import type { Monitor, PushEvent } from '@/payload-types'

import { useMonitorFormat } from './format'
import { pushScheduleZone, usePushScheduleText } from './push-schedule'
import { PushSnippets } from './push-snippets'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

/**
 * Push monitor card on the detail page: the schedule in plain language, the next expected ping,
 * runs in progress and copy-ready snippets. Renders in server components (non-async).
 */
export function PushPanel({
  monitor,
  pushUrl,
  timeZone,
  now,
}: {
  monitor: Monitor
  pushUrl: string
  /** The organization's zone (schedules with `SAME_AS_SERVER`, timestamps). */
  timeZone: string
  now: Date
}) {
  const t = useTranslations('monitors.push.panel')
  const tDuration = useTranslations('common.duration')
  const scheduleText = usePushScheduleText()
  const format = useMonitorFormat(timeZone)

  const cron = monitor.pushSchedule === 'cron'
  const zone = pushScheduleZone(monitor, timeZone)
  const settings: PushScheduleSettings = {
    interval: monitor.interval,
    pushSchedule: monitor.pushSchedule ?? 'interval',
    pushCron: monitor.pushCron ?? null,
    timezone: zone,
    pushGrace: monitor.pushGrace ?? null,
    pushMaxDuration: monitor.pushMaxDuration ?? null,
  }
  const state = pushStateOf(monitor)
  const verdict = evaluatePush(settings, state, now)
  const next = 'nextExpectedAt' in verdict ? verdict.nextExpectedAt : null
  const graceSeconds = Math.round(pushGraceMs(settings) / 1000)
  const duration = (seconds: number) =>
    humanDuration(seconds, (unit, count) => tDuration(unit, { count }))
  const runs = state.runs ?? []

  return (
    <Card className="gap-4" data-testid="push-panel">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Row label={t('schedule')}>
            <span data-testid="push-schedule">{scheduleText(monitor, timeZone)}</span>
          </Row>
          <Row label={t('grace')}>
            {typeof monitor.pushGrace === 'number'
              ? duration(graceSeconds)
              : t('graceAutomatic', { duration: duration(graceSeconds) })}
          </Row>
          <Row label={t('maxDuration')}>
            {monitor.pushMaxDuration ? duration(monitor.pushMaxDuration) : t('noMaxDuration')}
          </Row>
          <Row label={t('lastPing')}>
            {state.lastPushAt ? format.dateTime(state.lastPushAt) : t('never')}
          </Row>
          <Row label={t('nextExpected')}>
            <span data-testid="push-next-expected">
              {next
                ? next.getTime() + pushGraceMs(settings) < now.getTime()
                  ? t('overdue', { when: format.dateTime(next) })
                  : t('nextExpectedValue', { when: format.dateTime(next) })
                : '–'}
            </span>
          </Row>
          {runs.length > 0 && (
            <Row label={t('runs')}>
              {t('running', { count: runs.length, since: format.dateTime(runs[0].startedAt) })}
            </Row>
          )}
        </dl>
        <PushSnippets
          url={pushUrl}
          cron={crontabPattern(settings)}
          cronTimeZone={cron ? zone : null}
        />
        <p className="text-xs text-muted-foreground">
          {t.rich('signals', { code: (chunks) => <code>{chunks}</code> })}
        </p>
      </CardContent>
    </Card>
  )
}

/** The newest push signals of a monitor with their captured output. */
export function PushEventsTable({ events, timeZone }: { events: PushEvent[]; timeZone: string }) {
  const t = useTranslations('monitors.push.events')
  const tDuration = useTranslations('common.duration')
  const format = useMonitorFormat(timeZone)
  const duration = (seconds: number) =>
    humanDuration(seconds, (unit, count) => tDuration(unit, { count }))
  const variant = (kind: PushEvent['kind']) =>
    kind === 'fail' ? 'destructive' : kind === 'success' ? 'default' : 'secondary'

  return (
    <Card className="gap-3" data-testid="push-events">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description', { count: PUSH_EVENTS_PER_MONITOR })}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {events.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-48 pl-6">{t('time')}</TableHead>
                <TableHead className="w-28">{t('kind')}</TableHead>
                <TableHead>{t('message')}</TableHead>
                <TableHead className="w-32 pr-6 text-right">{t('duration')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={String(event.id)} className="align-top">
                  <TableCell className="pl-6 text-xs whitespace-nowrap">
                    {format.dateTime(event.time)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={variant(event.kind)}>{t(`kinds.${event.kind}`)}</Badge>
                  </TableCell>
                  <TableCell className="max-w-0 text-xs whitespace-normal">
                    <div className="flex flex-col gap-1">
                      <span className="break-words">
                        {event.msg}
                        {typeof event.exitCode === 'number' && (
                          <span className="text-muted-foreground">
                            {' · '}
                            {t('exitCode', { code: event.exitCode })}
                          </span>
                        )}
                        {event.rid && (
                          <code className="ml-2 text-muted-foreground">{event.rid}</code>
                        )}
                      </span>
                      {event.body && (
                        <details>
                          <summary className="cursor-pointer text-muted-foreground">
                            {t('output')}
                          </summary>
                          <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                            {event.body}
                          </pre>
                          {event.bodyTruncated && (
                            <p className="mt-1 text-muted-foreground">{t('truncated')}</p>
                          )}
                        </details>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="pr-6 text-right text-xs tabular-nums">
                    {typeof event.duration === 'number'
                      ? event.duration >= 1000
                        ? duration(Math.round(event.duration / 1000))
                        : format.ping(event.duration)
                      : '–'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
