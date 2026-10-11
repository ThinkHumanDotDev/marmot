'use client'

import { Loader2, Pencil, Plus, Send, Telescope, Trash2, X } from 'lucide-react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OTEL_MAX_HEADERS, type OtelCollectorRow } from '@/lib/otel'
import { otelApi } from '@/lib/otel-api'
import { cn } from '@/lib/utils'

import { SwitchRow } from './proxies-settings'

interface OtelCollectorsSettingsProps {
  orgId: string
  initial: OtelCollectorRow[]
  /** `otel-collector:manage` — create, edit, test and delete. */
  canManage: boolean
}

const sortRows = (rows: OtelCollectorRow[], locale: string) =>
  [...rows].sort((a, b) => a.name.localeCompare(b.name, locale))

/** Settings → OpenTelemetry (#99): the organization's OTLP/HTTP metrics collectors. */
export function OtelCollectorsSettings({ orgId, initial, canManage }: OtelCollectorsSettingsProps) {
  const t = useTranslations('settings.openTelemetry')
  const format = useFormatter()
  const locale = useLocale()
  const [rows, setRows] = React.useState<OtelCollectorRow[]>(() => sortRows(initial, locale))
  const [editing, setEditing] = React.useState<OtelCollectorRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<OtelCollectorRow | null>(null)
  const [testing, setTesting] = React.useState<string | null>(null)

  const upsert = (row: OtelCollectorRow) =>
    setRows((current) => {
      // Saving a default collector clears the flag on the others (server-side hook).
      const others = current
        .filter((r) => r.id !== row.id)
        .map((r) => (row.default ? { ...r, default: false } : r))
      return sortRows([...others, row], locale)
    })

  async function test(row: OtelCollectorRow) {
    setTesting(row.id)
    try {
      const result = await otelApi.test(orgId, row.id)
      if (result.ok) {
        toast.success(t('testSucceeded'))
        upsert({ ...row, lastExportAt: new Date().toISOString(), lastError: null })
      } else {
        const error = result.error ?? String(result.status ?? '')
        toast.error(t('testFailed', { error }))
        upsert({ ...row, lastError: error })
      }
    } catch (error) {
      toast.error(t('testFailed', { error: error instanceof Error ? error.message : '' }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="otel-collector-new">
            <Plus /> {t('new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Telescope}
            title={t('emptyTitle')}
            description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li
                key={row.id}
                className={cn(
                  'flex items-center justify-between gap-3 px-3 py-2',
                  !row.active && 'text-muted-foreground',
                )}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{row.name}</span>
                    {row.default && <Badge variant="secondary">{t('badge.default')}</Badge>}
                    {row.headerNames.length > 0 && (
                      <Badge variant="outline">
                        {t('badge.headers', { count: row.headerNames.length })}
                      </Badge>
                    )}
                    {!row.active && <Badge variant="outline">{t('badge.inactive')}</Badge>}
                  </span>
                  <p className="truncate font-mono text-xs text-muted-foreground">{row.endpoint}</p>
                  <p
                    className={cn(
                      'text-xs',
                      row.lastError ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {row.lastError
                      ? t('lastError', { error: row.lastError })
                      : row.lastExportAt
                        ? t('lastExport', {
                            time: format.dateTime(new Date(row.lastExportAt), 'short'),
                          })
                        : t('neverExported')}
                  </p>
                </div>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('testLabel', { name: row.name })}
                      disabled={testing === row.id}
                      onClick={() => void test(row)}
                    >
                      {testing === row.id ? <Loader2 className="animate-spin" /> : <Send />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('editLabel', { name: row.name })}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { name: row.name })}
                      onClick={() => setDeleting(row)}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {canManage && (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="sm:max-w-lg">
            {editing !== null && (
              <CollectorForm
                orgId={orgId}
                collector={editing === 'new' ? null : editing}
                onCancel={() => setEditing(null)}
                onSaved={(row) => {
                  upsert(row)
                  setEditing(null)
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('confirmDeleteTitle', { name: deleting?.name ?? '' })}
        description={t('confirmDeleteDescription')}
        confirmLabel={t('confirmDelete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await otelApi.remove(orgId, deleting.id)
            setRows((current) => current.filter((r) => r.id !== deleting.id))
            toast.success(t('deleted'))
            setDeleting(null)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('deleteFailed'))
          }
        }}
      />
    </Card>
  )
}

interface HeaderRow {
  key: number
  name: string
  value: string
  /** The value is stored on the server; empty `value` keeps it. */
  stored: boolean
}

function CollectorForm({
  orgId,
  collector,
  onCancel,
  onSaved,
}: {
  orgId: string
  collector: OtelCollectorRow | null
  onCancel: () => void
  onSaved: (row: OtelCollectorRow) => void
}) {
  const t = useTranslations('settings.openTelemetry.form')
  // Row keys: stored headers take 0…n-1, added rows count on from there.
  const nextKey = React.useRef(collector?.headerNames.length ?? 0)
  const [name, setName] = React.useState(collector?.name ?? '')
  const [endpoint, setEndpoint] = React.useState(collector?.endpoint ?? '')
  const [active, setActive] = React.useState(collector?.active ?? true)
  const [isDefault, setIsDefault] = React.useState(collector?.default ?? false)
  const [headers, setHeaders] = React.useState<HeaderRow[]>(() =>
    (collector?.headerNames ?? []).map((header, index) => ({
      key: index,
      name: header,
      value: '',
      stored: true,
    })),
  )
  const [saving, setSaving] = React.useState(false)

  const setHeader = (key: number, patch: Partial<HeaderRow>) =>
    setHeaders((current) => current.map((h) => (h.key === key ? { ...h, ...patch } : h)))

  const filled = headers.filter((h) => h.name.trim())
  const canSave = name.trim().length > 0 && endpoint.trim().length > 0 && !saving

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        endpoint: endpoint.trim(),
        active,
        default: isDefault,
        headers: filled.map((h) => ({
          name: h.name.trim(),
          value: h.stored && h.value === '' ? null : h.value,
        })),
      }
      const { doc } = collector
        ? await otelApi.update(orgId, collector.id, data)
        : await otelApi.create(orgId, data)
      toast.success(collector ? t('saved') : t('created'))
      onSaved(doc)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{collector ? t('editTitle') : t('newTitle')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="otel-name">{t('name')}</Label>
        <Input
          id="otel-name"
          value={name}
          maxLength={100}
          placeholder={t('namePlaceholder')}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="otel-endpoint">{t('endpoint')}</Label>
        <Input
          id="otel-endpoint"
          type="url"
          value={endpoint}
          placeholder={t('endpointPlaceholder')}
          autoComplete="off"
          onChange={(e) => setEndpoint(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">{t('endpointHint')}</p>
      </div>
      <div className="grid gap-2">
        <Label>{t('headers')}</Label>
        <p className="text-sm text-muted-foreground">{t('headersHint')}</p>
        {headers.map((header) => (
          <div key={header.key} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              aria-label={t('headerName')}
              value={header.name}
              placeholder={t('headerName')}
              autoComplete="off"
              className="font-mono"
              onChange={(e) => setHeader(header.key, { name: e.target.value, stored: false })}
            />
            <Input
              aria-label={t('headerValue')}
              type="password"
              value={header.value}
              placeholder={header.stored ? t('headerKept') : t('headerValue')}
              autoComplete="new-password"
              className="font-mono"
              onChange={(e) => setHeader(header.key, { value: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('removeHeader', { name: header.name })}
              onClick={() => setHeaders((current) => current.filter((h) => h.key !== header.key))}
            >
              <X />
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={headers.length >= OTEL_MAX_HEADERS}
            onClick={() =>
              setHeaders((current) => [
                ...current,
                { key: nextKey.current++, name: '', value: '', stored: false },
              ])
            }
          >
            <Plus /> {t('addHeader')}
          </Button>
        </div>
      </div>
      <SwitchRow
        id="otel-active"
        label={t('active')}
        description={t('activeHint')}
        checked={active}
        onChange={setActive}
      />
      <SwitchRow
        id="otel-default"
        label={t('default')}
        description={t('defaultHint')}
        checked={isDefault}
        onChange={setIsDefault}
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saving && <Loader2 className="animate-spin" />}
          {collector ? t('save') : t('create')}
        </Button>
      </DialogFooter>
    </form>
  )
}
