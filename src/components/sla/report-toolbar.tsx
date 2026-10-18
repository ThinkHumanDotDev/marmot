'use client'

import { Download } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { PrintButton } from '@/components/sla/print-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { currentPeriod, periodDates, previousSchedulePeriod, type SlaZone } from '@/lib/sla'

/**
 * Range picker and downloads of an SLA report page (#156). The range lives in the URL
 * (`?from=&to=`) so the server renders the report and links can be bookmarked.
 */
export function ReportToolbar({
  basePath,
  downloadPath,
  from,
  to,
  now,
  zone,
}: {
  /** The report page, without query. */
  basePath: string
  /** The report API route, without query. */
  downloadPath: string
  from: string
  to: string
  /** Render time (epoch ms), so presets match the server's clock. */
  now: number
  /** The organization's time zone and week start: presets are its calendar months (#274). */
  zone: SlaZone
}) {
  const t = useTranslations('sla.report')
  const router = useRouter()
  const [range, setRange] = React.useState({ from, to })

  const go = (next: { from: string; to: string }) => {
    setRange(next)
    router.push(`${basePath}?from=${next.from}&to=${next.to}`)
  }
  const at = new Date(now)
  const lastMonth = previousSchedulePeriod('monthly', at, zone)
  const thisMonth = currentPeriod('month', at, zone)
  const quarter = currentPeriod('quarter', at, zone)
  const lastQuarter = currentPeriod('quarter', new Date(quarter.from - 1), zone)
  const presets = [
    { key: 'lastMonth', period: lastMonth },
    { key: 'thisMonth', period: thisMonth },
    { key: 'lastQuarter', period: lastQuarter },
  ] as const
  const query = `from=${from}&to=${to}`

  return (
    <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          go(range)
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="sla-from">{t('from')}</Label>
          <Input
            id="sla-from"
            type="date"
            value={range.from}
            onChange={(event) => setRange((r) => ({ ...r, from: event.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sla-to">{t('to')}</Label>
          <Input
            id="sla-to"
            type="date"
            value={range.to}
            onChange={(event) => setRange((r) => ({ ...r, to: event.target.value }))}
          />
        </div>
        <Button type="submit" variant="secondary">
          {t('apply')}
        </Button>
        {presets.map(({ key, period }) =>
          period ? (
            <Button
              key={key}
              type="button"
              variant="ghost"
              onClick={() => go(periodDates(period, zone))}
            >
              {t(`presets.${key}`)}
            </Button>
          ) : null,
        )}
      </form>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={`${downloadPath}?${query}&format=csv`} download>
            <Download /> {t('downloadCsv')}
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`${downloadPath}?${query}&format=pdf`} download>
            <Download /> {t('downloadPdf')}
          </a>
        </Button>
        <PrintButton label={t('print')} />
      </div>
    </div>
  )
}
