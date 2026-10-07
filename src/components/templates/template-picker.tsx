'use client'

import { FileText, TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { TemplateKind, TemplateRow } from '@/lib/templates'

/** Message key of a template kind (`templates.kinds.*`). */
export const templateKindKey = (kind: TemplateKind) =>
  kind === 'incident-update' ? 'incidentUpdate' : kind

/** `{{ name }}` as written in a template. */
export const placeholderToken = (name: string) => `{{ ${name} }}`

/**
 * "Use template" select of the incident dialog, the update composer and the maintenance form.
 * Renders nothing when no template applies. Picking one calls `onApply`; the select itself keeps no
 * value, so the same template can be applied again.
 */
export function TemplatePicker({
  id,
  templates,
  onApply,
  disabled,
}: {
  id: string
  templates: TemplateRow[]
  onApply: (template: TemplateRow) => void
  disabled?: boolean
}) {
  const t = useTranslations('templates.picker')
  if (templates.length === 0) return null
  return (
    <Select
      value=""
      disabled={disabled}
      onValueChange={(value) => {
        const template = templates.find((row) => row.id === value)
        if (template) onApply(template)
      }}
    >
      <SelectTrigger id={id} aria-label={t('label')} className="w-full sm:w-64">
        <FileText aria-hidden />
        <SelectValue placeholder={t('placeholder')} />
      </SelectTrigger>
      <SelectContent>
        {templates.map((template) => (
          <SelectItem key={template.id} value={template.id}>
            {template.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Lists the placeholders still left in a draft (`findPlaceholders`) with a field to fill each one
 * in. The composers disable publishing while it shows anything.
 */
export function PlaceholderNotice({
  idPrefix,
  names,
  onFill,
}: {
  idPrefix: string
  names: string[]
  onFill: (name: string, value: string) => void
}) {
  const t = useTranslations('templates.placeholders')
  const [values, setValues] = React.useState<Record<string, string>>({})
  if (names.length === 0) return null

  return (
    <div
      role="status"
      data-testid="template-placeholders"
      className="flex flex-col gap-2 rounded-lg border border-status-pending/50 bg-status-pending/10 p-3"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {t('title')}
      </p>
      <p className="text-xs text-muted-foreground">{t('description')}</p>
      <ul className="flex flex-col gap-2">
        {names.map((name) => {
          const value = values[name] ?? ''
          const fill = () => {
            if (!value.trim()) return
            onFill(name, value)
            setValues(({ [name]: _filled, ...rest }) => rest)
          }
          return (
            <li key={name} className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {placeholderToken(name)}
              </code>
              <Input
                id={`${idPrefix}-placeholder-${name}`}
                aria-label={t('valueLabel', { name })}
                value={value}
                className="h-8 min-w-0 flex-1"
                onChange={(e) => setValues((current) => ({ ...current, [name]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    fill()
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!value.trim()}
                onClick={fill}
              >
                {t('fill')}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Today's date in the organization's zone, for the `date` variable. */
export function useTemplateDate(): string {
  const format = useFormatter()
  return React.useMemo(() => format.dateTime(new Date(), 'date'), [format])
}
