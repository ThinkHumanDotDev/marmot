/**
 * A minimal PDF writer for SLA reports (#156): A4 landscape pages with a title, a few lines of
 * text and one table, set in the standard Helvetica fonts (no embedded fonts, no dependencies).
 * Text is encoded as WinAnsi; characters outside Latin-1 are replaced by `?`.
 */

export interface PdfTable {
  title: string
  /** Lines under the title (range, generation time, …). */
  lines: string[]
  columns: { label: string /** Relative width. */; width: number; align?: 'left' | 'right' }[]
  rows: string[][]
  /** Shown when there are no rows. */
  empty?: string
  /** Small print at the bottom of every page. */
  footer?: string
}

const PAGE_WIDTH = 842
const PAGE_HEIGHT = 595
const MARGIN = 40
const ROW_HEIGHT = 18
const FONT_SIZE = 9

/** WinAnsi codes of the common typographic characters outside Latin-1. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '\u202f': 0x20,
}

/** WinAnsi bytes of `text`, with PDF string escapes; other characters become `?`. */
function pdfString(text: string): string {
  let out = ''
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 63
    const byte =
      WIN_ANSI[char] ??
      ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) ? code : 63)
    const c = String.fromCharCode(byte)
    out += c === '\\' || c === '(' || c === ')' ? `\\${c}` : c
  }
  return `(${out})`
}

/** Rough Helvetica advance width (average glyph ≈ 0.52 em), enough to truncate cells. */
const textWidth = (text: string, size: number) => text.length * size * 0.52

function fit(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text
  let cut = text
  while (cut.length > 1 && textWidth(`${cut}…`, size) > width) cut = cut.slice(0, -1)
  return `${cut}…`
}

const num = (value: number) => (Math.round(value * 100) / 100).toString()

function text(
  x: number,
  y: number,
  value: string,
  { size = FONT_SIZE, bold = false } = {},
): string {
  return `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${num(x)} ${num(y)} Td ${pdfString(value)} Tj ET`
}

/** Render `table` as a PDF document. */
export function renderTablePdf(table: PdfTable): Buffer {
  const usable = PAGE_WIDTH - 2 * MARGIN
  const totalWeight = table.columns.reduce((sum, column) => sum + column.width, 0) || 1
  const widths = table.columns.map((column) => (column.width / totalWeight) * usable)

  const pages: string[] = []
  let ops: string[] = []
  let y = PAGE_HEIGHT - MARGIN

  const header = () => {
    let x = MARGIN
    ops.push(
      '0.95 0.94 0.92 rg',
      `${MARGIN} ${num(y - 5)} ${usable} ${ROW_HEIGHT} re f`,
      '0 0 0 rg',
    )
    table.columns.forEach((column, i) => {
      const label = fit(column.label, widths[i] - 8, FONT_SIZE)
      const tx = column.align === 'right' ? x + widths[i] - 4 - textWidth(label, FONT_SIZE) : x + 4
      ops.push(text(tx, y, label, { bold: true }))
      x += widths[i]
    })
    y -= ROW_HEIGHT
  }

  const finishPage = () => {
    if (table.footer) {
      ops.push('0.4 0.4 0.4 rg', text(MARGIN, MARGIN / 2, table.footer, { size: 7 }), '0 0 0 rg')
    }
    pages.push(ops.join('\n'))
    ops = []
    y = PAGE_HEIGHT - MARGIN
  }

  ops.push(text(MARGIN, y - 8, fit(table.title, usable, 18), { size: 18, bold: true }))
  y -= 32
  for (const line of table.lines) {
    ops.push(text(MARGIN, y, fit(line, usable, 10), { size: 10 }))
    y -= 14
  }
  y -= 10
  header()

  if (table.rows.length === 0 && table.empty) {
    ops.push(text(MARGIN + 4, y, table.empty))
  }
  for (const row of table.rows) {
    if (y < MARGIN + ROW_HEIGHT) {
      finishPage()
      header()
    }
    let x = MARGIN
    row.forEach((cell, i) => {
      const width = widths[i] ?? 0
      const value = fit(cell, width - 8, FONT_SIZE)
      const align = table.columns[i]?.align
      const tx = align === 'right' ? x + width - 4 - textWidth(value, FONT_SIZE) : x + 4
      ops.push(text(tx, y, value))
      x += width
    })
    ops.push(
      '0.85 0.85 0.85 RG 0.5 w',
      `${MARGIN} ${num(y - 6)} m ${MARGIN + usable} ${num(y - 6)} l S`,
    )
    y -= ROW_HEIGHT
  }
  finishPage()

  // Objects: 1 catalog, 2 page tree, 3 Helvetica, 4 Helvetica-Bold, then (page, content) pairs.
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 5 + i * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  pages.forEach((content, i) => {
    const pageId = pageIds[i]
    const length = Buffer.byteLength(content, 'latin1')
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`
    objects[pageId + 1] = `<< /Length ${length} >>\nstream\n${content}\nendstream`
  })

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1')
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
