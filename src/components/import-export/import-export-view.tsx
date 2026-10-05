'use client'

import { Download, FileJson2, Loader2, Upload } from 'lucide-react'
import Link from 'next/link'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  detectImportFormat,
  FORMAT_LABELS,
  MAX_IMPORT_BYTES,
  totalCreates,
  type ImportFormat,
  type ImportReport,
} from '@/lib/import-export'

import { importExportApi } from './api'
import { ImportReportView } from './import-report'

interface ImportExportViewProps {
  orgId: string | number
  orgSlug: string
  /** `monitor:create` */
  canImport: boolean
  /** `notification:create` — channels in the file are skipped otherwise. */
  canImportNotifications: boolean
  /** `status-page:create` */
  canImportStatusPages: boolean
  /** `organization:update` */
  canExport: boolean
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'checking'; fileName: string }
  | { kind: 'ready'; fileName: string; format: ImportFormat; json: unknown; report: ImportReport }
  | {
      kind: 'importing'
      fileName: string
      format: ImportFormat
      json: unknown
      report: ImportReport
    }
  | { kind: 'done'; fileName: string; format: ImportFormat; report: ImportReport }

const formatBytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

export function ImportExportView({
  orgId,
  orgSlug,
  canImport,
  canImportNotifications,
  canImportStatusPages,
  canExport,
}: ImportExportViewProps) {
  const [stage, setStage] = React.useState<Stage>({ kind: 'idle' })
  const inputRef = React.useRef<HTMLInputElement>(null)
  const inputId = React.useId()

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error(
        `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_IMPORT_BYTES)}.`,
      )
      return
    }
    let json: unknown
    try {
      json = JSON.parse(await file.text())
    } catch {
      toast.error('That file is not valid JSON.')
      return
    }
    const format = detectImportFormat(json)
    if (!format) {
      toast.error('Unrecognised file. Expected an Uptime Kuma backup or a Marmot export.')
      return
    }
    setStage({ kind: 'checking', fileName: file.name })
    try {
      const report = await importExportApi.dryRun(orgId, json)
      setStage({ kind: 'ready', fileName: file.name, format, json, report })
    } catch (error) {
      setStage({ kind: 'idle' })
      toast.error(error instanceof Error ? error.message : 'Could not check the file.')
    }
  }

  async function commit() {
    if (stage.kind !== 'ready') return
    setStage({ ...stage, kind: 'importing' })
    try {
      const report = await importExportApi.commit(orgId, stage.json)
      setStage({ kind: 'done', fileName: stage.fileName, format: stage.format, report })
      toast.success(`Imported ${totalCreates(report)} item${totalCreates(report) === 1 ? '' : 's'}`)
    } catch (error) {
      setStage({ ...stage, kind: 'ready' })
      toast.error(error instanceof Error ? error.message : 'Import failed; nothing was written.')
    }
  }

  const reset = () => setStage({ kind: 'idle' })
  const busy = stage.kind === 'checking' || stage.kind === 'importing'

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Import</CardTitle>
          <CardDescription>
            Upload an Uptime Kuma backup (<code>Uptime_Kuma_Backup_*.json</code>) or a Marmot
            export. The file is checked first; nothing is written until you confirm.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canImport ? (
            <p className="text-sm text-muted-foreground">
              Importing requires the member role or higher in this organization.
            </p>
          ) : (
            <>
              {(!canImportNotifications || !canImportStatusPages) && (
                <p className="text-sm text-muted-foreground">
                  {!canImportNotifications &&
                    'Notification channels in the file will be skipped (admin role required). '}
                  {!canImportStatusPages && 'Status pages in the file will be skipped.'}
                </p>
              )}
              <input
                ref={inputRef}
                id={inputId}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={onFileChosen}
                disabled={busy}
              />
              {stage.kind === 'idle' && (
                <Button type="button" onClick={() => inputRef.current?.click()}>
                  <Upload className="size-4" aria-hidden />
                  Choose a JSON file…
                </Button>
              )}
              {stage.kind === 'checking' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Checking {stage.fileName}…
                </div>
              )}
              {(stage.kind === 'ready' || stage.kind === 'importing' || stage.kind === 'done') && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <FileJson2 className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{stage.fileName}</span>
                    <Badge variant="secondary">{FORMAT_LABELS[stage.format]}</Badge>
                    {stage.kind === 'done' && <Badge>Imported</Badge>}
                  </div>
                  <ImportReportView report={stage.report} />
                </div>
              )}
            </>
          )}
        </CardContent>
        {canImport && stage.kind !== 'idle' && stage.kind !== 'checking' && (
          <CardFooter className="flex flex-wrap gap-2">
            {stage.kind === 'done' ? (
              <>
                <Button asChild>
                  <Link href={`/${orgSlug}/monitors`}>Go to monitors</Link>
                </Button>
                <Button type="button" variant="outline" onClick={reset}>
                  Import another file
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  onClick={commit}
                  disabled={busy || totalCreates(stage.report) === 0}
                >
                  {stage.kind === 'importing' && (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  )}
                  Import {totalCreates(stage.report)} item
                  {totalCreates(stage.report) === 1 ? '' : 's'}
                </Button>
                <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
              </>
            )}
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
          <CardDescription>
            Download this organization&apos;s monitors, notification channels and status pages as a
            Marmot export file. It can be imported into another organization or instance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">The file contains secrets.</strong> Notification
            channel settings (webhook URLs, tokens, SMTP passwords) and monitor credentials are
            exported exactly as stored. Treat it like a password file.
          </p>
        </CardContent>
        <CardFooter>
          {canExport ? (
            <Button asChild variant="outline">
              <a href={importExportApi.exportUrl(orgId)} download>
                <Download className="size-4" aria-hidden />
                Download export
              </a>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Exporting requires the admin role in this organization.
            </p>
          )}
        </CardFooter>
      </Card>
    </>
  )
}
