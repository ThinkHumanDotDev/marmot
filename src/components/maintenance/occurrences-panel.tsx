'use client'

import { Loader2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusDot } from '@/components/status-dot'
import {
  PlaceholderNotice,
  TemplatePicker,
  useTemplateDate,
} from '@/components/templates/template-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  isFinishedState,
  MAX_UPDATE_MESSAGE_LENGTH,
  type OccurrenceState,
} from '@/lib/maintenance-announcements'
import { renderMarkdown } from '@/lib/markdown'
import {
  fillPlaceholder,
  findPlaceholders,
  renderTemplateText,
  type TemplateRow,
} from '@/lib/templates'
import { cn } from '@/lib/utils'
import type { MonitorStatusKey } from '@/stores/monitor-store'

import { maintenanceApi, type OccurrenceSummary } from './types'

const dot: Record<OccurrenceState, MonitorStatusKey> = {
  scheduled: 'pending',
  'in-progress': 'maintenance',
  verifying: 'maintenance',
  completed: 'up',
  cancelled: 'unknown',
}

export function OccurrenceStateBadge({ state }: { state: OccurrenceState }) {
  const t = useTranslations('maintenance.announcements.state')
  return (
    <Badge
      variant="outline"
      data-state={state}
      className={cn(
        'gap-1.5 px-2.5 py-1 text-xs',
        state === 'in-progress' || state === 'verifying'
          ? 'border-status-maintenance/40 bg-status-maintenance/10'
          : state === 'scheduled'
            ? 'border-status-pending/40 bg-status-pending/10'
            : 'text-muted-foreground',
      )}
    >
      <StatusDot status={dot[state]} className="size-2" pulse={false} />
      {t(state)}
    </Badge>
  )
}

/** Transitions offered as buttons for each state (notes use the composer). */
type ActionKey = 'start' | 'cancel' | 'verifying' | 'resume' | 'complete'
const ACTIONS: Record<
  OccurrenceState,
  { to: OccurrenceState; key: ActionKey; primary?: boolean }[]
> = {
  scheduled: [
    { to: 'in-progress', key: 'start', primary: true },
    { to: 'cancelled', key: 'cancel' },
  ],
  'in-progress': [
    { to: 'verifying', key: 'verifying' },
    { to: 'completed', key: 'complete', primary: true },
  ],
  verifying: [
    { to: 'in-progress', key: 'resume' },
    { to: 'completed', key: 'complete', primary: true },
  ],
  completed: [],
  cancelled: [],
}

/** "Use template" for maintenance updates: the templates and the values of their variables. */
export interface MaintenanceTemplateContext {
  /** `maintenance-update` templates of the organization. */
  templates: TemplateRow[]
  organization: string
  maintenance: string
}

function OccurrenceCard({
  item,
  timeZone,
  canEdit,
  templateContext,
  onPost,
}: {
  item: OccurrenceSummary
  timeZone: string
  canEdit: boolean
  templateContext?: MaintenanceTemplateContext
  onPost: (item: OccurrenceSummary, status: OccurrenceState, message: string) => Promise<boolean>
}) {
  const t = useTranslations('maintenance.announcements.panel')
  const tTemplates = useTranslations('templates.picker')
  const templateDate = useTemplateDate()
  const tState = useTranslations('maintenance.announcements.state')
  const tDefault = useTranslations('maintenance.announcements.defaultMessage')
  const format = useFormatter()
  const [message, setMessage] = React.useState('')
  const [pending, setPending] = React.useState<OccurrenceState | 'note' | null>(null)
  const [confirmCancel, setConfirmCancel] = React.useState(false)

  const start = new Date(item.start)
  const period = item.end
    ? format.dateTimeRange(start, new Date(item.end), 'zoned', { timeZone })
    : t('openEnded', { start: format.dateTime(start, 'zoned', { timeZone }) })

  const unfilled = findPlaceholders(message)
  const templates = templateContext?.templates ?? []
  const idPrefix = `occurrence-${item.id}`

  function applyTemplate(template: TemplateRow) {
    setMessage(
      renderTemplateText(template.body, 'maintenance-update', {
        organization: templateContext?.organization,
        maintenance: templateContext?.maintenance,
        start: format.dateTime(start, 'zoned', { timeZone }),
        end: item.end ? format.dateTime(new Date(item.end), 'zoned', { timeZone }) : null,
        date: templateDate,
      }),
    )
    toast.success(tTemplates('applied', { name: template.name }))
  }

  async function post(status: OccurrenceState, note = false) {
    if (unfilled.length > 0) return
    if (note && !message.trim()) {
      toast.error(t('messageRequired'))
      return
    }
    setPending(note ? 'note' : status)
    const ok = await onPost(item, status, message)
    setPending(null)
    if (ok) setMessage('')
  }

  return (
    <article
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid="maintenance-occurrence"
      data-state={item.state}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <OccurrenceStateBadge state={item.state} />
          <time
            dateTime={item.start}
            className="text-sm text-muted-foreground tabular-nums"
            suppressHydrationWarning
          >
            {period}
          </time>
        </div>
        {canEdit && ACTIONS[item.state].length > 0 && (
          <div className="flex flex-wrap gap-2">
            {ACTIONS[item.state].map((action) => (
              <Button
                key={action.key}
                type="button"
                size="sm"
                variant={action.primary ? 'default' : 'outline'}
                disabled={pending !== null || unfilled.length > 0}
                data-testid={`occurrence-${action.key}`}
                onClick={() =>
                  action.to === 'cancelled' ? setConfirmCancel(true) : void post(action.to)
                }
              >
                {pending === action.to && <Loader2 className="animate-spin" />}
                {t(action.key)}
              </Button>
            ))}
          </div>
        )}
      </header>

      {canEdit && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <Label htmlFor={`occurrence-message-${item.id}`}>{t('messageLabel')}</Label>
            {templates.length > 0 && (
              <TemplatePicker
                id={`${idPrefix}-template`}
                templates={templates}
                onApply={applyTemplate}
              />
            )}
          </div>
          <Textarea
            id={`occurrence-message-${item.id}`}
            rows={2}
            maxLength={MAX_UPDATE_MESSAGE_LENGTH}
            placeholder={t('messagePlaceholder')}
            value={message}
            aria-invalid={unfilled.length > 0 || undefined}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="occurrence-message"
          />
          <PlaceholderNotice
            idPrefix={idPrefix}
            names={unfilled}
            onFill={(name, value) => setMessage((text) => fillPlaceholder(text, name, value))}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending !== null || !message.trim() || unfilled.length > 0}
              onClick={() => void post(item.state, true)}
              data-testid="occurrence-post"
            >
              {pending === 'note' && <Loader2 className="animate-spin" />}
              {t('postUpdate')}
            </Button>
          </div>
        </div>
      )}

      <section aria-label={t('timeline')} className="flex flex-col gap-3">
        {item.updates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noUpdates')}</p>
        ) : (
          <ol className="flex flex-col gap-3 border-l pl-4">
            {item.updates.map((update) => (
              <li
                key={update.id}
                className="flex flex-col gap-1"
                data-update-status={update.status}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium">{tState(update.status)}</span>
                  <time
                    dateTime={update.postedAt}
                    className="text-muted-foreground tabular-nums"
                    suppressHydrationWarning
                  >
                    {format.dateTime(new Date(update.postedAt), 'zoned', { timeZone })}
                  </time>
                </div>
                {update.message ? (
                  <div
                    className="text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ul]:list-disc [&_ul]:pl-5"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(update.message) }}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{tDefault(update.status)}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t('confirmCancelTitle')}
        description={t('confirmCancelDescription')}
        confirmLabel={t('confirmCancel')}
        destructive
        onConfirm={async () => {
          await post('cancelled')
          setConfirmCancel(false)
        }}
      />
    </article>
  )
}

/**
 * The windows (occurrences) of one maintenance with their state and public timeline. Admins start,
 * verify, complete or cancel a window by hand and post updates that status pages show.
 */
export function OccurrencesPanel({
  orgId,
  maintenanceId,
  initial,
  timeZone,
  canEdit,
  templateContext,
}: {
  orgId: string | number
  maintenanceId: string
  initial: OccurrenceSummary[]
  /** IANA zone the maintenance is planned in. */
  timeZone: string
  canEdit: boolean
  /** Maintenance update templates offered by "Use template". */
  templateContext?: MaintenanceTemplateContext
}) {
  const t = useTranslations('maintenance.announcements.panel')
  const [items, setItems] = React.useState(initial)

  const reload = React.useCallback(async () => {
    try {
      setItems(await maintenanceApi.occurrences(orgId, maintenanceId))
    } catch {
      toast.error(t('loadFailed'))
    }
  }, [orgId, maintenanceId, t])

  async function onPost(
    item: OccurrenceSummary,
    status: OccurrenceState,
    message: string,
  ): Promise<boolean> {
    try {
      await maintenanceApi.postUpdate(orgId, maintenanceId, item.id, {
        status,
        message: message.trim() || undefined,
      })
      toast.success(t('posted'))
      await reload()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('postFailed'))
      return false
    }
  }

  // Unfinished windows first (upcoming, then running), then the most recent finished ones.
  const ordered = [
    ...items.filter((item) => !isFinishedState(item.state)),
    ...items.filter((item) => isFinishedState(item.state)).slice(0, 5),
  ]

  return (
    <Card className="mx-auto w-full max-w-3xl" data-testid="maintenance-occurrences">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {ordered.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          ordered.map((item) => (
            <OccurrenceCard
              key={item.id}
              item={item}
              timeZone={timeZone}
              canEdit={canEdit}
              templateContext={templateContext}
              onPost={onPost}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}
