'use client'

import { Download, FileJson2, Loader2, Upload } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
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

export function ImportExportView({
  orgId,
  orgSlug,
  canImport,
  canImportNotifications,
  canImportStatusPages,
  canExport,
}: ImportExportViewProps) {
  const t = useTranslations('importExport')
  const format = useFormatter()
  const formatBytes = (bytes: number) =>
    t('import.sizeMb', {
      size: format.number(bytes / (1024 * 1024), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    })
  const [stage, setStage] = React.useState<Stage>({ kind: 'idle' })
  const inputRef = React.useRef<HTMLInputElement>(null)
  const inputId = React.useId()

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error(
        t('import.tooLarge', {
          fileName: file.name,
          size: formatBytes(file.size),
          limit: formatBytes(MAX_IMPORT_BYTES),
        }),
      )
      return
    }
    let json: unknown
    try {
      json = JSON.parse(await file.text())
    } catch {
      toast.error(t('import.invalidJson'))
      return
    }
    const format = detectImportFormat(json)
    if (!format) {
      toast.error(t('import.unrecognised'))
      return
    }
    setStage({ kind: 'checking', fileName: file.name })
    try {
      const report = await importExportApi.dryRun(orgId, json)
      setStage({ kind: 'ready', fileName: file.name, format, json, report })
    } catch (error) {
      setStage({ kind: 'idle' })
      toast.error(error instanceof Error ? error.message : t('import.checkFailed'))
    }
  }

  async function commit() {
    if (stage.kind !== 'ready') return
    setStage({ ...stage, kind: 'importing' })
    try {
      const report = await importExportApi.commit(orgId, stage.json)
      setStage({ kind: 'done', fileName: stage.fileName, format: stage.format, report })
      toast.success(t('import.success', { count: totalCreates(report) }))
    } catch (error) {
      setStage({ ...stage, kind: 'ready' })
      toast.error(error instanceof Error ? error.message : t('import.failed'))
    }
  }

  const reset = () => setStage({ kind: 'idle' })
  const busy = stage.kind === 'checking' || stage.kind === 'importing'

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('import.title')}</CardTitle>
          <CardDescription>
            {t.rich('import.description', { code: (chunks) => <code>{chunks}</code> })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canImport ? (
            <p className="text-sm text-muted-foreground">{t('import.forbidden')}</p>
          ) : (
            <>
              {(!canImportNotifications || !canImportStatusPages) && (
                <p className="text-sm text-muted-foreground">
                  {!canImportNotifications && t('import.skipNotifications')}
                  {!canImportStatusPages && t('import.skipStatusPages')}
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
                  {t('import.choose')}
                </Button>
              )}
              {stage.kind === 'checking' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t('import.checking', { fileName: stage.fileName })}
                </div>
              )}
              {(stage.kind === 'ready' || stage.kind === 'importing' || stage.kind === 'done') && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <FileJson2 className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{stage.fileName}</span>
                    <Badge variant="secondary">{t(`formats.${stage.format}`)}</Badge>
                    {stage.kind === 'done' && <Badge>{t('import.imported')}</Badge>}
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
                  <Link href={`/${orgSlug}/monitors`}>{t('import.goToMonitors')}</Link>
                </Button>
                <Button type="button" variant="outline" onClick={reset}>
                  {t('import.another')}
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
                  {t('import.submit', { count: totalCreates(stage.report) })}
                </Button>
                <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                  {t('import.cancel')}
                </Button>
              </>
            )}
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('export.title')}</CardTitle>
          <CardDescription>{t('export.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t.rich('export.secrets', {
              strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
            })}
          </p>
        </CardContent>
        <CardFooter>
          {canExport ? (
            <Button asChild variant="outline">
              <a href={importExportApi.exportUrl(orgId)} download>
                <Download className="size-4" aria-hidden />
                {t('export.download')}
              </a>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t('export.forbidden')}</p>
          )}
        </CardFooter>
      </Card>
    </>
  )
}
