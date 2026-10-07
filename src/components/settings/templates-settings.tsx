'use client'

import { FileText, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { ComponentImpactEditor } from '@/components/status-pages/editor/incidents-panel'
import { placeholderToken, templateKindKey } from '@/components/templates/template-picker'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  COMPONENT_IMPACTS,
  INCIDENT_STATUSES,
  type ComponentImpact,
  type IncidentStatus,
} from '@/lib/incident-timeline'
import {
  TEMPLATE_KINDS,
  TEMPLATE_MAX_DURATION_MINUTES,
  TEMPLATE_VARIABLES,
  type TemplateKind,
  type TemplateRow,
} from '@/lib/templates'
import type { TemplatePageOption } from '@/server/templates/page-data'

import { templatesApi } from './resources-api'

interface TemplatesSettingsProps {
  orgId: string
  initial: TemplateRow[]
  /** Status pages and their components, for default components. */
  pages: TemplatePageOption[]
  /** `template:update` — create, edit and delete. */
  canManage: boolean
}

/** Select value standing for "no value" (Radix selects cannot hold an empty string). */
const NONE = '__none__'

const byName = (locale: string) => (a: TemplateRow, b: TemplateRow) =>
  a.name.localeCompare(b.name, locale)

export function TemplatesSettings({ orgId, initial, pages, canManage }: TemplatesSettingsProps) {
  const t = useTranslations('settings.templates')
  const tKinds = useTranslations('templates.kinds')
  const locale = useLocale()
  const [rows, setRows] = React.useState<TemplateRow[]>(() => [...initial].sort(byName(locale)))
  const [editing, setEditing] = React.useState<TemplateRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<TemplateRow | null>(null)
  const pageTitle = (id: string | null) =>
    id === null ? t('allPages') : (pages.find((page) => page.id === id)?.title ?? t('allPages'))

  const upsert = (row: TemplateRow) =>
    setRows((current) =>
      (current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [...current, row]
      ).sort(byName(locale)),
    )

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {t.rich('description', { strong: (chunks) => <strong>{chunks}</strong> })}
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="template-new">
            <Plus /> {t('new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState icon={FileText} title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li
                key={row.id}
                data-template-id={row.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{row.name}</span>
                    <Badge variant="outline">{tKinds(templateKindKey(row.kind))}</Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {pageTitle(row.statusPage)}
                    {row.components.length > 0 &&
                      ` · ${t('componentCount', { count: row.components.length })}`}
                  </p>
                </div>
                {canManage && (
                  <span className="flex gap-1">
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
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
            {/* Radix unmounts the content when closed, so the form starts fresh on every open. */}
            <TemplateForm
              orgId={orgId}
              template={editing === 'new' ? null : editing}
              pages={pages}
              onCancel={() => setEditing(null)}
              onSaved={(row) => {
                upsert(row)
                setEditing(null)
              }}
            />
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
            await templatesApi.remove(deleting.id)
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

function TemplateForm({
  orgId,
  template,
  pages,
  onCancel,
  onSaved,
}: {
  orgId: string
  template: TemplateRow | null
  pages: TemplatePageOption[]
  onCancel: () => void
  onSaved: (row: TemplateRow) => void
}) {
  const t = useTranslations('settings.templates.form')
  const tAll = useTranslations('settings.templates')
  const tKinds = useTranslations('templates.kinds')
  const tVariables = useTranslations('templates.variables')
  const tPublic = useTranslations('statusPages.public')
  const [name, setName] = React.useState(template?.name ?? '')
  const [kind, setKind] = React.useState<TemplateKind>(template?.kind ?? 'incident')
  const [title, setTitle] = React.useState(template?.title ?? '')
  const [body, setBody] = React.useState(template?.body ?? '')
  const [status, setStatus] = React.useState<IncidentStatus | null>(template?.status ?? null)
  const [impact, setImpact] = React.useState<ComponentImpact | null>(template?.impact ?? null)
  const [statusPage, setStatusPage] = React.useState<string | null>(template?.statusPage ?? null)
  const [impacts, setImpacts] = React.useState<Record<string, ComponentImpact>>(() =>
    Object.fromEntries((template?.components ?? []).map((row) => [row.component, row.impact])),
  )
  const [duration, setDuration] = React.useState<number | null>(template?.duration ?? null)
  const [saving, setSaving] = React.useState(false)

  const maintenance = kind === 'maintenance'
  const page = pages.find((p) => p.id === statusPage) ?? null
  const canSave = name.trim().length > 0 && !saving

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        kind,
        title: kind === 'incident-update' ? null : title,
        body,
        status: maintenance ? null : status,
        impact: maintenance ? null : impact,
        statusPage,
        components:
          maintenance || !page
            ? []
            : Object.entries(impacts).map(([component, value]) => ({ component, impact: value })),
        duration: maintenance ? duration : null,
      }
      const row = template
        ? await templatesApi.update(template.id, data)
        : await templatesApi.create(orgId, data)
      toast.success(template ? t('saved') : t('created'))
      onSaved(row)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="grid gap-5" data-testid="template-form">
      <DialogHeader>
        <DialogTitle>{template ? t('editTitle') : t('newTitle')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="template-name">{t('name')}</Label>
          <Input
            id="template-name"
            value={name}
            maxLength={100}
            autoComplete="off"
            placeholder={t('namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="template-kind">{t('kind')}</Label>
          <Select value={kind} onValueChange={(value) => setKind(value as TemplateKind)}>
            <SelectTrigger id="template-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_KINDS.map((value) => (
                <SelectItem key={value} value={value}>
                  {tKinds(templateKindKey(value))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {kind !== 'incident-update' && (
        <div className="grid gap-2">
          <Label htmlFor="template-title">{t('title')}</Label>
          <Input
            id="template-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="template-body">{t('body')}</Label>
        <Textarea
          id="template-body"
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('bodyHint')}</p>
        <div className="text-xs text-muted-foreground">
          <p>{t('variables')}</p>
          <ul className="mt-1 grid gap-0.5" data-testid="template-variables">
            {TEMPLATE_VARIABLES[kind].map((variable) => (
              <li key={variable}>
                <code className="rounded bg-muted px-1 py-0.5">{placeholderToken(variable)}</code>{' '}
                {tVariables(variable)}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {maintenance ? (
        <div className="grid gap-2">
          <Label htmlFor="template-duration">{t('duration')}</Label>
          <div className="relative sm:w-56">
            <Input
              id="template-duration"
              type="number"
              inputMode="numeric"
              min={1}
              max={TEMPLATE_MAX_DURATION_MINUTES}
              step={1}
              value={duration ?? ''}
              className="pr-20"
              onChange={(e) => setDuration(e.target.value === '' ? null : Number(e.target.value))}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
              {t('minutesUnit')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t('durationHint')}</p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="template-status">{t('status')}</Label>
              <Select
                value={status ?? NONE}
                onValueChange={(value) =>
                  setStatus(value === NONE ? null : (value as IncidentStatus))
                }
              >
                <SelectTrigger id="template-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('statusNone')}</SelectItem>
                  {INCIDENT_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {tPublic(`incidents.status.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('statusHint')}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="template-impact">{t('impact')}</Label>
              <Select
                value={impact ?? NONE}
                onValueChange={(value) =>
                  setImpact(value === NONE ? null : (value as ComponentImpact))
                }
              >
                <SelectTrigger id="template-impact" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('impactNone')}</SelectItem>
                  {COMPONENT_IMPACTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {tPublic(`impact.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('impactHint')}</p>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="template-page">{t('statusPage')}</Label>
            <Select
              value={statusPage ?? NONE}
              onValueChange={(value) => {
                setStatusPage(value === NONE ? null : value)
                setImpacts({})
              }}
            >
              <SelectTrigger id="template-page" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{tAll('allPages')}</SelectItem>
                {pages.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('statusPageHint')}</p>
          </div>

          {page && (
            <div className="grid gap-2">
              <Label>{t('components')}</Label>
              <ComponentImpactEditor
                idPrefix="template"
                options={page.components}
                value={impacts}
                onChange={setImpacts}
              />
            </div>
          )}
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saving && <Loader2 className="animate-spin" />}
          {template ? t('save') : t('create')}
        </Button>
      </DialogFooter>
    </form>
  )
}
