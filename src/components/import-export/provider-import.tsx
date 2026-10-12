'use client'

import { Loader2, PlugZap } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  IMPORT_PROVIDER_INFO,
  IMPORT_PROVIDERS,
  totalCreates,
  type ImportProviderId,
  type ImportReport,
  type ImportResource,
} from '@/lib/import-export'

import { importExportApi } from './api'
import { ImportReportView } from './import-report'

type Stage =
  | { kind: 'form' }
  | { kind: 'checking' }
  | { kind: 'ready'; report: ImportReport }
  | { kind: 'importing'; report: ImportReport }
  | { kind: 'done'; report: ImportReport }

/**
 * Import from a hosted service's API (#120): connect → preview → choose → import. The credentials
 * stay in this component's state until the import finishes or is cancelled; they are sent with the
 * preview and again with the commit, and never stored.
 */
export function ProviderImport({ orgId, orgSlug }: { orgId: string | number; orgSlug: string }) {
  const t = useTranslations('importExport')
  const [provider, setProvider] = React.useState<ImportProviderId>('statuspage')
  const [credentials, setCredentials] = React.useState<Record<string, string>>({})
  const info = IMPORT_PROVIDER_INFO[provider]
  const [resources, setResources] = React.useState<Set<ImportResource>>(
    () => new Set(info.resources),
  )
  const [stage, setStage] = React.useState<Stage>({ kind: 'form' })
  const idPrefix = React.useId()

  const chosen = info.resources.filter((resource) => resources.has(resource))
  const complete = info.credentials.every((field) => !field.required || credentials[field.name])
  const locked = stage.kind !== 'form'

  function chooseProvider(value: string) {
    const next = value as ImportProviderId
    setProvider(next)
    setCredentials({})
    setResources(new Set(IMPORT_PROVIDER_INFO[next].resources))
  }

  function reset() {
    setCredentials({})
    setStage({ kind: 'form' })
  }

  async function preview(event: React.FormEvent) {
    event.preventDefault()
    setStage({ kind: 'checking' })
    try {
      const report = await importExportApi.provider(
        orgId,
        provider,
        { credentials, resources: chosen },
        true,
      )
      setStage({ kind: 'ready', report })
    } catch (error) {
      setStage({ kind: 'form' })
      toast.error(error instanceof Error ? error.message : t('providers.previewFailed'))
    }
  }

  async function commit() {
    if (stage.kind !== 'ready') return
    setStage({ kind: 'importing', report: stage.report })
    try {
      const report = await importExportApi.provider(
        orgId,
        provider,
        { credentials, resources: chosen },
        false,
      )
      setCredentials({})
      setStage({ kind: 'done', report })
      toast.success(t('import.success', { count: totalCreates(report) }))
    } catch (error) {
      setStage({ kind: 'ready', report: stage.report })
      toast.error(error instanceof Error ? error.message : t('import.failed'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('providers.title')}</CardTitle>
        <CardDescription>{t('providers.description')}</CardDescription>
      </CardHeader>
      <form onSubmit={preview} autoComplete="off">
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-provider`}>{t('providers.provider')}</Label>
              <Select value={provider} onValueChange={chooseProvider} disabled={locked}>
                <SelectTrigger id={`${idPrefix}-provider`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMPORT_PROVIDERS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {t(`formats.${id}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {info.credentials.map((field) => (
              <div key={`${provider}-${field.name}`} className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-${field.name}`}>
                  {t(`providers.fields.${field.name}` as 'providers.fields.apiKey')}
                  {!field.required && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      {t('providers.optional')}
                    </span>
                  )}
                </Label>
                <Input
                  id={`${idPrefix}-${field.name}`}
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  required={field.required}
                  disabled={locked}
                  value={credentials[field.name] ?? ''}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t(`providers.hints.${provider}`)}</p>
          <fieldset className="space-y-2" disabled={locked}>
            <legend className="text-sm font-medium">{t('providers.resourcesLabel')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {info.resources.map((resource) => (
                <label key={resource} className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={resources.has(resource)}
                    disabled={locked}
                    onCheckedChange={(checked) =>
                      setResources((current) => {
                        const next = new Set(current)
                        if (checked) next.add(resource)
                        else next.delete(resource)
                        return next
                      })
                    }
                  />
                  {t(`providers.resources.${resource}`)}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('providers.resourcesHint')}</p>
          </fieldset>
          {stage.kind === 'checking' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('providers.previewing', { provider: t(`formats.${provider}`) })}
            </div>
          )}
          {(stage.kind === 'ready' || stage.kind === 'importing' || stage.kind === 'done') && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">{t(`formats.${provider}`)}</Badge>
                {stage.kind === 'done' && <Badge>{t('import.imported')}</Badge>}
              </div>
              <ImportReportView report={stage.report} />
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {stage.kind === 'form' || stage.kind === 'checking' ? (
            <Button type="submit" disabled={!complete || chosen.length === 0 || locked}>
              {stage.kind === 'checking' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <PlugZap className="size-4" aria-hidden />
              )}
              {t('providers.preview')}
            </Button>
          ) : stage.kind === 'done' ? (
            <>
              <Button asChild>
                <Link href={`/${orgSlug}/status-pages`}>{t('import.goToStatusPages')}</Link>
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
                disabled={stage.kind === 'importing' || totalCreates(stage.report) === 0}
              >
                {stage.kind === 'importing' && (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                )}
                {t('import.submit', { count: totalCreates(stage.report) })}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={reset}
                disabled={stage.kind === 'importing'}
              >
                {t('import.cancel')}
              </Button>
            </>
          )}
        </CardFooter>
      </form>
    </Card>
  )
}
