'use client'

import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import * as React from 'react'

import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { ImportReport, ImportSectionReport } from '@/lib/import-export'

interface ImportReportViewProps {
  report: ImportReport
}

type SectionKey = 'monitors' | 'notifications' | 'statusPages' | 'tags'

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'monitors', label: 'Monitors' },
  { key: 'notifications', label: 'Notification channels' },
  { key: 'statusPages', label: 'Status pages' },
  { key: 'tags', label: 'Tags' },
]

function SectionRow({ label, section }: { label: string; section: ImportSectionReport }) {
  const [open, setOpen] = React.useState(false)
  const skipped = section.skipped.length
  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{label}</TableCell>
        <TableCell className="text-right tabular-nums">
          {section.create > 0 ? (
            <Badge variant="default">{section.create}</Badge>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {skipped > 0 ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              {open ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden />
              )}
              {skipped}
            </button>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </TableCell>
      </TableRow>
      {open && skipped > 0 && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={3} className="py-2">
            <ul className="space-y-1 text-xs">
              {section.skipped.map((item, index) => (
                <li
                  key={`${item.name}-${index}`}
                  className="flex flex-col gap-0.5 sm:flex-row sm:gap-2"
                >
                  <span className="font-medium">{item.name}</span>
                  <span className="text-muted-foreground">{item.reason}</span>
                </li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

/** Dry-run / result table: what will be (or was) created and what was skipped, with reasons. */
export function ImportReportView({ report }: ImportReportViewProps) {
  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Section</TableHead>
            <TableHead className="text-right">
              {report.dryRun ? 'Will create' : 'Created'}
            </TableHead>
            <TableHead className="text-right">Skipped</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {SECTIONS.map(({ key, label }) => (
            <SectionRow key={key} label={label} section={report[key]} />
          ))}
        </TableBody>
      </Table>
      {report.warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4 text-amber-600" aria-hidden />
            Notes
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {report.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
