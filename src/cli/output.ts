/** Terminal rendering for the CLI: colours, tables and the plan diff. */
import type { FieldChange, MonitorChange, Plan } from './core/plan'
import { t } from './text'

export interface Colors {
  green(text: string): string
  yellow(text: string): string
  red(text: string): string
  dim(text: string): string
  bold(text: string): string
}

const wrap = (open: number, close: number) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`

export function colors(enabled: boolean): Colors {
  if (!enabled) {
    const plain = (text: string) => text
    return { green: plain, yellow: plain, red: plain, dim: plain, bold: plain }
  }
  return {
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  }
}

const ANSI = /\x1b\[[0-9;]*m/g
const visibleLength = (text: string) => text.replace(ANSI, '').length

/** A plain left-aligned table; `rows[0]` is the header. */
export function table(rows: string[][], c: Colors): string {
  if (rows.length === 0) return ''
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map((row) => visibleLength(row[col] ?? ''))),
  )
  return rows
    .map((row, index) => {
      const line = row
        .map((cell, col) =>
          col === row.length - 1 ? cell : cell + ' '.repeat(widths[col] - visibleLength(cell)),
        )
        .join('  ')
        .trimEnd()
      return index === 0 ? c.bold(line) : line
    })
    .join('\n')
}

/** Value for a diff line: JSON, shortened. */
export function formatValue(value: unknown, max = 80): string {
  const text = value === undefined ? 'null' : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Colour of a monitor status word. */
export function statusColor(status: string | null | undefined, c: Colors): string {
  const word = status ?? t('common.unknown')
  if (status === 'up') return c.green(word)
  if (status === 'down') return c.red(word)
  if (status === 'pending' || status === 'degraded') return c.yellow(word)
  return c.dim(word)
}

function fieldLine(change: MonitorChange, field: FieldChange, c: Colors): string {
  if (field.secret) {
    const text = change.action === 'create' ? t('plan.secretSet') : t('plan.secretChanged')
    return `      ${field.field}: ${c.dim(text)}`
  }
  if (change.action === 'create') return `      ${field.field}: ${formatValue(field.after)}`
  return `      ${field.field}: ${formatValue(field.before)} ${c.dim('→')} ${formatValue(field.after)}`
}

/** The human-readable plan (`marmot monitors plan`). */
export function renderPlan(plan: Plan, c: Colors, options: { verbose?: boolean } = {}): string {
  const lines: string[] = []
  for (const name of plan.createTags) lines.push(c.green(`  + ${t('plan.tag', { name })}`))
  for (const change of plan.changes) {
    if (change.action === 'unchanged' && !options.verbose) continue
    const id = change.id === null ? '' : c.dim(` #${change.id}`)
    const head = `${change.key}  ${JSON.stringify(change.name)} (${change.type})${id}`
    if (change.action === 'create') lines.push(c.green(`  + ${t('plan.create')}  `) + head)
    if (change.action === 'update') {
      const adopt = change.adopted ? c.dim(`  ${t('plan.adopted')}`) : ''
      lines.push(c.yellow(`  ~ ${t('plan.update')}  `) + head + adopt)
    }
    if (change.action === 'delete') lines.push(c.red(`  - ${t('plan.delete')}  `) + head)
    if (change.action === 'unchanged') lines.push(c.dim(`    ${t('plan.unchanged')}  ${head}`))
    if (change.action === 'create' || change.action === 'update') {
      for (const field of change.fields) {
        if (change.action === 'create' && ['key', 'name', 'type'].includes(field.field)) continue
        lines.push(fieldLine(change, field, c))
      }
    }
  }
  for (const warning of plan.warnings) lines.push(c.yellow(`! ${warning}`))
  if (lines.length > 0) lines.push('')
  lines.push(c.bold(t('plan.summary', plan.summary)))
  return lines.join('\n')
}
