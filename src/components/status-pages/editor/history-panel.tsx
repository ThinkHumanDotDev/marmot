'use client'

import { Download } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { MonthlyUptimeRow } from '@/lib/uptime-history'

import { statusPagesApi, type OrgId, type UptimeHistoryResponse } from '../api'

const MONTH_OPTIONS = [3, 6, 12, 24] as const

/**
 * Monthly uptime per component of a page (#112), for admins: the figures behind SLA reports, read
 * from the preserved history once the statistics are pruned, and exportable as CSV.
 */
export function HistoryPanel({ orgId, pageId }: { orgId: OrgId; pageId: OrgId }) {
  const t = useTranslations('statusPages.history')
  const ts = useTranslations('statusPages.settings.uptime')
  const tu = useTranslations('statusPages.uptime')
  const format = useFormatter()
  const [months, setMonths] = React.useState<number>(12)
  const [result, setResult] = React.useState<{
    months: number
    data: UptimeHistoryResponse | null
  } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    statusPagesApi
      .uptimeHistory(orgId, pageId, months)
      .then((data) => {
        if (!cancelled) setResult({ months, data })
      })
      .catch(() => {
        if (!cancelled) setResult({ months, data: null })
      })
    return () => {
      cancelled = true
    }
  }, [orgId, pageId, months])

  // A result for another month count is stale: show the loading state until the new one arrives.
  const current = result?.months === months ? result : null
  const data = current?.data ?? null
  const error = current !== null && current.data === null

  const cells = React.useMemo(() => {
    const map = new Map<string, MonthlyUptimeRow>()
    for (const row of data?.rows ?? []) map.set(`${row.componentId}:${row.month}`, row)
    return map
  }, [data])

  const percent = (value: number) =>
    value >= 0.99995 ? format.number(1, 'wholePercent') : format.number(value, 'percent')
  const duration = (seconds: number) => {
    if (seconds < 60) return tu('duration.lessThanMinute')
    const minutes = Math.round(seconds / 60)
    const hours = Math.floor(minutes / 60)
    return hours > 0
      ? tu('duration.hours', { hours, minutes: minutes % 60 })
      : tu('duration.minutes', { minutes })
  }
  const monthName = (month: string) =>
    format.dateTime(new Date(`${month}-01T00:00:00Z`), 'utcMonth')

  return (
    <section className="flex flex-col gap-4" aria-labelledby="sp-history-title">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h2 id="sp-history-title" className="text-base font-medium">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('description', { mode: data ? ts(`modes.${data.mode}`) : '…' })}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="sp-history-months">{t('months')}</Label>
            <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
              <SelectTrigger id="sp-history-months" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {t('monthsOption', { months: option })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button asChild variant="outline">
            <a href={statusPagesApi.uptimeHistoryCsvUrl(orgId, pageId, months)} download>
              <Download aria-hidden /> {t('export')}
            </a>
          </Button>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{t('failed')}</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : data.components.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border" data-uptime-history>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('component')}</TableHead>
                {data.months.map((month) => (
                  <TableHead key={month} className="text-right whitespace-nowrap">
                    {monthName(month)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.components.map((component) => (
                <TableRow key={component.id}>
                  <TableCell className="font-medium">{component.name}</TableCell>
                  {data.months.map((month) => {
                    const row = cells.get(`${component.id}:${month}`)
                    return (
                      <TableCell
                        key={month}
                        className="text-right tabular-nums"
                        data-month={month}
                        data-component={component.id}
                      >
                        {row && row.uptime !== null ? (
                          <>
                            <span>{percent(row.uptime)}</span>
                            {row.downtimeSeconds !== null && row.downtimeSeconds > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {t('downtime', { duration: duration(row.downtimeSeconds) })}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">{t('noData')}</span>
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
