/**
 * SLA report outputs outside React (#156): the PDF export and the scheduled email, both in the
 * organization's (or the request's) locale. The CSV export is `slaReportCsv` in `src/lib/sla.ts`;
 * the HTML page is `src/components/sla/report-table.tsx`.
 */
import type { Locale } from '@/i18n/locales'
import { escapeHtml } from '@/lib/markdown'
import type { SlaReportData, SlaReportRow } from '@/lib/sla'
import { emailLayout } from '@/server/email/layout'
import { organizationFormatter, serverTranslator } from '@/server/i18n'

import { renderTablePdf } from './pdf'

export interface RenderI18n {
  locale: Locale
  timeZone: string
}

const DASH = '—'

/** Column labels and formatted cells of a report, shared by the PDF and the email. */
export function reportCells(report: SlaReportData, i18n: RenderI18n) {
  const t = serverTranslator(i18n.locale)
  const format = organizationFormatter(i18n)
  const minutes = (seconds: number | null) =>
    seconds === null ? DASH : format.number(seconds / 60, 'minutes')
  const columns = [
    { label: t('sla.columns.item'), width: 5 },
    { label: t('sla.columns.target'), width: 2, align: 'right' as const },
    { label: t('sla.columns.uptime'), width: 2, align: 'right' as const },
    { label: t('sla.columns.downtime'), width: 2.4, align: 'right' as const },
    { label: t('sla.columns.incidents'), width: 1.6, align: 'right' as const },
    { label: t('sla.columns.mttr'), width: 2, align: 'right' as const },
    { label: t('sla.columns.remaining'), width: 2.6, align: 'right' as const },
    { label: t('sla.columns.met'), width: 1.6 },
  ]
  const row = (r: SlaReportRow) => [
    r.businessHours ? `${r.name} (${t('sla.report.businessHours')})` : r.name,
    format.number(r.target / 100, 'targetPercent'),
    r.uptime === null ? DASH : format.number(r.uptime, 'slaPercent'),
    minutes(r.downtimeSeconds),
    format.number(r.incidents, 'integer'),
    minutes(r.mttrSeconds),
    minutes(r.uptime === null ? null : r.remainingSeconds),
    r.met === null ? DASH : r.met ? t('sla.met.yes') : t('sla.met.no'),
  ]
  const range = t('sla.report.range', {
    from: format.dateTime(new Date(`${report.from}T00:00:00Z`), 'utcDate'),
    to: format.dateTime(new Date(`${report.to}T00:00:00Z`), 'utcDate'),
    timeZone: report.timeZone,
  })
  const generated = t('sla.report.generatedAt', {
    date: format.dateTime(new Date(report.generatedAt), 'zoned'),
  })
  return { t, columns, rows: report.rows.map(row), range, generated }
}

/** The report as a PDF document. */
export function renderSlaReportPdf(report: SlaReportData, i18n: RenderI18n): Buffer {
  const { t, columns, rows, range, generated } = reportCells(report, i18n)
  return renderTablePdf({
    title: report.name,
    lines: [range, generated],
    columns,
    rows,
    empty: t('sla.report.empty'),
    footer: t('sla.report.footnote'),
  })
}

export interface RenderedReportEmail {
  subject: string
  text: string
  html: string
}

/** The scheduled report email (the CSV and PDF go as attachments). */
export function renderSlaReportEmail(
  report: SlaReportData,
  organizationName: string,
  i18n: RenderI18n,
): RenderedReportEmail {
  const { t, columns, rows, range } = reportCells(report, i18n)
  const met = report.rows.filter((r) => r.met === true).length
  const summary = t('sla.email.summary', { met, total: report.rows.length })
  const textRows = rows.map((cells) =>
    columns.map((column, i) => `${column.label}: ${cells[i]}`).join(' · '),
  )
  const cell = (value: string, align?: 'left' | 'right', header = false) =>
    `<${header ? 'th' : 'td'} style="padding:6px 8px;border-bottom:1px solid #e6e2db;text-align:${align ?? 'left'};font-size:13px${header ? ';color:#6b6760;font-weight:600' : ''}">${escapeHtml(value)}</${header ? 'th' : 'td'}>`
  const table = `<table style="border-collapse:collapse;width:100%;margin-top:12px"><thead><tr>${columns.map((c) => cell(c.label, c.align, true)).join('')}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((value, i) => cell(value, columns[i].align)).join('')}</tr>`).join('')}</tbody></table>`
  return {
    subject: t('sla.email.subject', { name: report.name, organization: organizationName }),
    text: [
      `${report.name} (${organizationName})`,
      range,
      summary,
      textRows.join('\n') || t('sla.report.empty'),
      t('sla.email.attachments'),
    ].join('\n\n'),
    html: emailLayout(
      `<h1 style="margin:0 0 4px;font-size:20px">${escapeHtml(report.name)}</h1><p style="margin:0;color:#6b6760">${escapeHtml(organizationName)} · ${escapeHtml(range)}</p><p style="margin:12px 0 0">${escapeHtml(summary)}</p>${rows.length > 0 ? table : `<p>${escapeHtml(t('sla.report.empty'))}</p>`}`,
      escapeHtml(t('sla.email.attachments')),
    ),
  }
}
