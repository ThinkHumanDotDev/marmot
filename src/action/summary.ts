/** Markdown for the job summary (`$GITHUB_STEP_SUMMARY`) of the GitHub Action (#118). */
import type { ApplyResult } from '../cli/core/apply'
import type { Plan } from '../cli/core/plan'
import { colors, renderPlan } from '../cli/output'
import { t } from '../cli/text'
import type { CheckRow } from './checks'

const MAX_CELL = 300

/** A table cell: one line, no HTML, no column breaks, bounded length. */
export function cell(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  const short = oneLine.length > MAX_CELL ? `${oneLine.slice(0, MAX_CELL - 1)}…` : oneLine
  return short
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
}

const code = (value: string) => `<code>${cell(value)}</code>`

export function monitorLabel(row: Pick<CheckRow, 'name' | 'key' | 'id' | 'ref'>): string {
  const ref = row.key ?? (row.id !== null ? `#${row.id}` : row.ref)
  return row.name ? `${cell(row.name)} ${code(ref)}` : code(ref)
}

const VERDICT_ICON = { pass: '✅', fail: '❌', skip: '⏭️' } as const

export function totals(rows: CheckRow[]) {
  return {
    passed: rows.filter((r) => r.verdict === 'pass').length,
    failed: rows.filter((r) => r.verdict === 'fail').length,
    skipped: rows.filter((r) => r.verdict === 'skip').length,
  }
}

/** The checks table: verdict, monitor, status, response time / HTTP code, message. */
export function checksMarkdown(rows: CheckRow[], url: string): string {
  const head = [
    t('action.columns.result'),
    t('action.columns.monitor'),
    t('action.columns.status'),
    t('action.columns.response'),
    t('action.columns.message'),
  ]
  const lines = [
    `### ${t('action.checksTitle')}`,
    '',
    `**${t('action.totals', totals(rows))}** · ${cell(url)}`,
    '',
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    const response = [
      row.ping !== null ? t('check.ping', { ms: row.ping }) : null,
      row.statusCode !== null ? t('check.statusCode', { code: row.statusCode }) : null,
    ]
      .filter(Boolean)
      .join(' · ')
    const message = [...new Set([row.message, ...row.assertions, row.note ?? ''])]
      .filter(Boolean)
      .map(cell)
      .join('<br>')
    const status = row.status === 'error' ? t('action.statusError') : row.status
    lines.push(
      `| ${VERDICT_ICON[row.verdict]} ${t(`action.verdict.${row.verdict}`)} | ${monitorLabel(row)} | ${cell(status)} | ${response} | ${message} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * The plan as a `diff` block (creates `+`, deletes `-`, updates `!`), as `marmot monitors plan`
 * prints it, without colours. Credential fields only show that they change.
 */
export function planDiff(plan: Plan): string {
  const text = renderPlan({ ...plan, warnings: [] }, colors(false))
  return text
    .split('\n')
    .map((line) =>
      line.replace(/^ {2}([+~-]) /, (_, sign: string) => `${sign === '~' ? '!' : sign} `),
    )
    .join('\n')
}

export interface ApplySummary {
  plan: Plan
  dryRun: boolean
  /** Why the run is a dry run (the `dry-run: auto` event). */
  dryRunNote: string | null
  applied: ApplyResult | null
  /** Error of a failed apply (the plan was valid). */
  error: string | null
}

export function applyMarkdown(summary: ApplySummary, file: string): string {
  const { plan } = summary
  const lines = [
    `### ${t('action.applyTitle')}`,
    '',
    `${code(file)} · ${t('plan.summary', plan.summary)}`,
    '',
  ]
  const changed =
    plan.createTags.length > 0 || plan.changes.some((change) => change.action !== 'unchanged')
  if (changed) {
    const diff = planDiff(plan)
    // A fence longer than any run of backticks in the plan, so values cannot close it.
    const fence = '`'.repeat(Math.max(3, ...(diff.match(/`+/g) ?? []).map((run) => run.length + 1)))
    lines.push(`${fence}diff`, diff, fence, '')
  } else lines.push(t('action.noChanges'), '')
  if (plan.warnings.length > 0) {
    lines.push(`**${t('action.warnings')}**`, '', ...plan.warnings.map((w) => `- ${cell(w)}`), '')
  }
  if (summary.error) lines.push(`❌ ${cell(summary.error)}`, '')
  else if (summary.dryRun) {
    lines.push(
      `> ${t('action.dryRunNote')}${summary.dryRunNote ? ` ${summary.dryRunNote}` : ''}`,
      '',
    )
  } else if (summary.applied) {
    lines.push(
      `✅ ${t('action.applied', {
        created: summary.applied.created.length,
        updated: summary.applied.updated.length,
        deleted: summary.applied.deleted.length,
      })}`,
      '',
    )
  }
  return `${lines.join('\n')}\n`
}

/** A file or API error that stopped the action before it had a plan or results. */
export function errorMarkdown(title: string, lines: string[]): string {
  return `### ${title}\n\n${lines.map((line) => `- ${cell(line)}`).join('\n')}\n`
}
