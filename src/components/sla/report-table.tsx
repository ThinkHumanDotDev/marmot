import { CheckCircle2, CircleSlash, XCircle } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { SlaReportData } from '@/lib/sla'

/**
 * The SLA report as an HTML table (#156), shared by the organization's report page and the public
 * share page. Server-renderable (no client state); print styles come from the page.
 */
export function SlaReportTable({ report }: { report: SlaReportData }) {
  const t = useTranslations('sla')
  const format = useFormatter()
  const minutes = (seconds: number | null) =>
    seconds === null ? '—' : format.number(seconds / 60, 'minutes')
  const met = report.rows.filter((row) => row.met === true).length
  const day = (date: string) => format.dateTime(new Date(`${date}T00:00:00Z`), 'utcDate')

  return (
    <div className="space-y-3" data-testid="sla-report">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t('report.range', { from: day(report.from), to: day(report.to) })}
        </p>
        <p className="text-sm font-medium" data-testid="sla-report-summary">
          {t('report.summary', { met, total: report.rows.length })}
        </p>
      </div>
      {report.rows.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          {t('report.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.item')}</TableHead>
                <TableHead className="text-right">{t('columns.target')}</TableHead>
                <TableHead className="text-right">{t('columns.uptime')}</TableHead>
                <TableHead className="text-right">{t('columns.downtime')}</TableHead>
                <TableHead className="text-right">{t('columns.incidents')}</TableHead>
                <TableHead className="text-right">{t('columns.mttr')}</TableHead>
                <TableHead className="text-right">{t('columns.remaining')}</TableHead>
                <TableHead>{t('columns.met')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="tabular-nums">
              {report.rows.map((row) => (
                <TableRow key={row.targetId} data-sla-row={row.targetId}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-right">
                    {format.number(row.target / 100, 'targetPercent')}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.uptime === null ? '—' : format.number(row.uptime, 'slaPercent')}
                  </TableCell>
                  <TableCell className="text-right">{minutes(row.downtimeSeconds)}</TableCell>
                  <TableCell className="text-right">
                    {format.number(row.incidents, 'integer')}
                  </TableCell>
                  <TableCell className="text-right">{minutes(row.mttrSeconds)}</TableCell>
                  <TableCell className="text-right">
                    {minutes(row.uptime === null ? null : row.remainingSeconds)}
                  </TableCell>
                  <TableCell>
                    <MetBadge met={row.met} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('report.footnote')}</p>
    </div>
  )
}

/** Met / missed with an icon, so the state never relies on colour alone. */
function MetBadge({ met }: { met: boolean | null }) {
  const t = useTranslations('sla')
  if (met === null) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <CircleSlash className="size-4" aria-hidden />
        {t('health.nodata')}
      </span>
    )
  }
  return met ? (
    <span className="inline-flex items-center gap-1 text-status-up-text">
      <CheckCircle2 className="size-4" aria-hidden />
      {t('met.yes')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-status-down-text">
      <XCircle className="size-4" aria-hidden />
      {t('met.no')}
    </span>
  )
}
