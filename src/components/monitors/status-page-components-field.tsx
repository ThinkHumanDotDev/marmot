'use client'

import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import type { Control, FieldValues, Path } from 'react-hook-form'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { api, ApiError } from '@/lib/api'
import type { VendorComponent, VendorIndicator, VendorProvider } from '@/lib/vendor-status'

interface Selected {
  id: string
  name?: string | null
}

interface Lookup {
  provider: VendorProvider
  pageName: string | null
  indicator: VendorIndicator
  components: VendorComponent[]
}

interface StatusPageComponentsFieldProps<T extends FieldValues> {
  control: Control<T>
  name: Path<T>
  orgId: string | number
  url: string | null | undefined
  provider: string | null | undefined
}

const INDICATOR_VARIANT: Record<VendorIndicator, 'secondary' | 'outline' | 'destructive'> = {
  none: 'secondary',
  maintenance: 'outline',
  minor: 'outline',
  major: 'destructive',
  critical: 'destructive',
}

/**
 * Component filter of a third-party status page monitor (#125): loads the vendor's components once
 * and stores the picked ones as `{ id, name }`. The id is what the check matches, so a component
 * the vendor renames keeps working; one that disappears stays listed and is flagged.
 */
export function StatusPageComponentsField<T extends FieldValues>({
  control,
  name,
  orgId,
  url,
  provider,
}: StatusPageComponentsFieldProps<T>) {
  const t = useTranslations('monitors.form.statusPage')
  const [lookup, setLookup] = React.useState<Lookup | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setLookup(
        await api.post<Lookup>(`/api/orgs/${orgId}/status-page-components`, {
          url: url ?? '',
          provider: provider ?? 'auto',
        }),
      )
    } catch (err) {
      setLookup(null)
      setError(err instanceof ApiError ? err.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const selected = (Array.isArray(field.value) ? field.value : []) as Selected[]
        const selectedIds = new Set(selected.map((s) => s.id))
        const known = new Map((lookup?.components ?? []).map((c) => [c.id, c]))
        // Picked components the vendor no longer lists stay visible so they can be removed.
        const missing = lookup ? selected.filter((s) => !known.has(s.id)) : []
        const toggle = (component: { id: string; name: string }, on: boolean) => {
          field.onChange(
            on
              ? [...selected, { id: component.id, name: component.name }]
              : selected.filter((s) => s.id !== component.id),
          )
        }
        return (
          <FormItem>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FormLabel>{t('components')}</FormLabel>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={load}
                disabled={loading || !url || !/^https?:\/\/\S+$/i.test(url)}
                data-testid="status-page-load-components"
              >
                {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {lookup ? t('reload') : t('load')}
              </Button>
            </div>
            <FormDescription>{t('componentsDescription')}</FormDescription>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {lookup && (
              <p className="text-sm text-muted-foreground" data-testid="status-page-detected">
                {t('detected', {
                  provider: t(`provider.${lookup.provider}`),
                  name: lookup.pageName ?? url ?? '',
                })}
              </p>
            )}
            <FormControl>
              <div
                className="flex flex-col divide-y rounded-md border"
                data-testid="status-page-components"
              >
                {lookup
                  ? lookup.components.map((component) => (
                      <label
                        key={component.id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={selectedIds.has(component.id)}
                          onChange={(e) => toggle(component, e.target.checked)}
                        />
                        <span className="min-w-0 flex-1 truncate">{component.name}</span>
                        <Badge variant={INDICATOR_VARIANT[component.indicator]}>
                          {t(`indicator.${component.indicator}`)}
                        </Badge>
                      </label>
                    ))
                  : selected.map((s) => (
                      <label key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked
                          onChange={() => toggle({ id: s.id, name: s.name ?? s.id }, false)}
                        />
                        <span className="min-w-0 flex-1 truncate">{s.name ?? s.id}</span>
                        <code className="text-xs text-muted-foreground">{s.id}</code>
                      </label>
                    ))}
                {missing.map((s) => (
                  <label key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked
                      onChange={() => toggle({ id: s.id, name: s.name ?? s.id }, false)}
                    />
                    <span className="min-w-0 flex-1 truncate">{s.name ?? s.id}</span>
                    <Badge variant="destructive">{t('missing')}</Badge>
                  </label>
                ))}
                {(lookup ? lookup.components.length + missing.length : selected.length) === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {lookup ? t('noComponents') : t('wholePage')}
                  </p>
                )}
              </div>
            </FormControl>
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}
