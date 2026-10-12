'use client'

import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  DECLARED_INCIDENT_SEVERITIES,
  DECLARED_STATUS_TRANSITIONS,
  isTerminalStatus,
  postmortemTemplate,
  type DeclaredIncidentStatus,
  type DeclaredIncidentSummary,
  type DeclaredTimelineEntry,
} from '@/lib/declared-incidents'
import type { UpdateDeclaredIncidentInput } from '@/lib/validation/declared-incident'

import { declaredApi, errorMessage, useDeclaredIncidentEvents } from './api'
import { DeclaredStatusBadge, SeverityBadge } from './badges'
import type { MemberChoice } from './declare-dialog'

const NONE = '__none__'

export interface LinkChoice {
  id: string
  title: string
}

interface DeclaredDetailProps {
  orgId: string | number
  orgSlug: string
  initial: DeclaredIncidentSummary
  members: MemberChoice[]
  statusPageIncidents: LinkChoice[]
  canUpdate: boolean
  canSkipPostmortem: boolean
}

function useTimelineText() {
  const t = useTranslations('declaredIncidents.timeline')
  const ts = useTranslations('declaredIncidents.severity')
  const tst = useTranslations('declaredIncidents.status')
  const severity = (value: string | null) =>
    (DECLARED_INCIDENT_SEVERITIES as readonly string[]).includes(value ?? '')
      ? ts(value as 'major')
      : (value ?? '')
  const status = (value: string | null) => (value ? tst(value as 'open') : '')
  return (entry: DeclaredTimelineEntry): string => {
    switch (entry.type) {
      case 'declared':
        return t('declared', { severity: severity(entry.to) })
      case 'severity_changed':
        return t('severity_changed', { from: severity(entry.from), to: severity(entry.to) })
      case 'status_changed':
        return t('status_changed', { from: status(entry.from), to: status(entry.to) })
      case 'commander_changed':
        return entry.to ? t('commander_changed', { to: entry.to }) : t('commander_cleared')
      case 'linked':
        return t('linked', { title: entry.message ?? '' })
      case 'closed':
        return entry.to === 'postmortem_skipped' ? t('closedSkipped') : t('closed')
      default:
        return t(entry.type)
    }
  }
}

/** One declared incident: workflow actions, details, postmortem and timeline; live over realtime. */
export function DeclaredDetail({
  orgId,
  orgSlug,
  initial,
  members,
  statusPageIncidents,
  canUpdate,
  canSkipPostmortem,
}: DeclaredDetailProps) {
  const t = useTranslations('declaredIncidents.detail')
  const ta = useTranslations('declaredIncidents.actions')
  const tn = useTranslations('declaredIncidents.notes')
  const tp = useTranslations('declaredIncidents.postmortem')
  const ts = useTranslations('declaredIncidents.severity')
  const tst = useTranslations('declaredIncidents.status')
  const tt = useTranslations('declaredIncidents.timeline')
  const format = useFormatter()
  const timelineText = useTimelineText()

  const [incident, setIncident] = React.useState(initial)
  const [postmortem, setPostmortem] = React.useState(initial.postmortem.content)
  const [note, setNote] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [confirm, setConfirm] = React.useState<'closed' | 'canceled' | null>(null)

  const apply = React.useCallback((next: DeclaredIncidentSummary) => {
    setIncident(next)
    setPostmortem((current) => (current.trim() ? current : next.postmortem.content))
  }, [])
  useDeclaredIncidentEvents(orgId, (next) => {
    if (next.id === incident.id) apply(next)
  })

  const readOnly = isTerminalStatus(incident.status)
  const editable = canUpdate && !readOnly
  const when = (iso: string | null) => (iso ? format.dateTime(new Date(iso), 'short') : '—')

  async function save(body: UpdateDeclaredIncidentInput, success?: string): Promise<boolean> {
    setPending(true)
    try {
      const next = await declaredApi.update(orgId, incident.id, body)
      setIncident(next)
      if (body.postmortem !== undefined) setPostmortem(next.postmortem.content)
      toast.success(success ?? t('saved'))
      return true
    } catch (error) {
      toast.error(errorMessage(error, t('failed')))
      return false
    } finally {
      setPending(false)
    }
  }

  async function addNote(event: React.FormEvent) {
    event.preventDefault()
    if (!note.trim()) return
    setPending(true)
    try {
      setIncident(await declaredApi.note(orgId, incident.id, note.trim()))
      setNote('')
      toast.success(tn('added'))
    } catch (error) {
      toast.error(errorMessage(error, t('failed')))
    } finally {
      setPending(false)
    }
  }

  const transition = (to: DeclaredIncidentStatus) => {
    if (to === 'closed' || to === 'canceled') setConfirm(to)
    else void save({ status: to })
  }
  const postmortemDirty = postmortem !== incident.postmortem.content
  const approved = incident.postmortem.status === 'approved'

  return (
    <div className="flex flex-col gap-6" data-testid="declared-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={incident.severity} />
          <DeclaredStatusBadge status={incident.status} />
          {incident.declaredBy && (
            <span className="text-sm text-muted-foreground">
              {t('declaredBy', { name: incident.declaredBy.name })}
            </span>
          )}
        </div>
        {editable && (
          <div className="flex flex-wrap gap-2" data-testid="declared-actions">
            {DECLARED_STATUS_TRANSITIONS[incident.status].map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === 'canceled' || to === 'open' ? 'outline' : 'default'}
                disabled={pending}
                onClick={() => transition(to)}
                data-testid={`declared-to-${to}`}
              >
                {ta(`to.${to}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
      {readOnly && (
        <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {t('readOnly', { status: tst(incident.status) })}
          {incident.postmortemSkipped && ` ${t('skippedPostmortem')}`}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-base">{t('facts')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('severity')}</span>
              {editable ? (
                <Select
                  value={incident.severity}
                  onValueChange={(value) => void save({ severity: value as 'major' })}
                >
                  <SelectTrigger className="w-full" aria-label={t('severity')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DECLARED_INCIDENT_SEVERITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ts(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span>{ts(incident.severity)}</span>
              )}
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('commander')}</span>
              {editable ? (
                <Select
                  value={incident.commander?.id ?? NONE}
                  onValueChange={(value) => void save({ commander: value === NONE ? null : value })}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t('commander')}
                    data-testid="declared-commander"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('noCommander')}</SelectItem>
                    {members.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span>{incident.commander?.name ?? t('noCommander')}</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-3">
              {(
                [
                  ['started', incident.startedAt],
                  ['mitigated', incident.mitigatedAt],
                  ['resolved', incident.resolvedAt],
                  [
                    incident.status === 'canceled' ? 'canceled' : 'closed',
                    incident.canceledAt ?? incident.closedAt,
                  ],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="grid gap-0.5">
                  <dt className="text-xs font-medium text-muted-foreground">{t(key)}</dt>
                  <dd data-testid={`declared-${key}`}>{when(value)}</dd>
                </div>
              ))}
            </dl>
            <div className="grid gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">{t('summary')}</span>
              <p className="break-words whitespace-pre-wrap">
                {incident.summary || (
                  <span className="text-muted-foreground">{t('noSummary')}</span>
                )}
              </p>
            </div>
            {incident.monitorIncident && (
              <div className="grid gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('monitorIncident')}
                </span>
                <Link
                  href={`/${orgSlug}/incidents/${incident.monitorIncident.id}`}
                  className="font-medium text-primary hover:underline"
                >
                  {t('openMonitorIncident', {
                    monitor: incident.monitorIncident.monitorName ?? '—',
                  })}
                </Link>
              </div>
            )}
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t('statusPageIncident')}
              </span>
              {editable ? (
                <Select
                  value={incident.statusPageIncident?.id ?? NONE}
                  onValueChange={(value) =>
                    void save({ statusPageIncident: value === NONE ? null : value })
                  }
                >
                  <SelectTrigger className="w-full" aria-label={t('statusPageIncident')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('notLinked')}</SelectItem>
                    {statusPageIncidents.map((choice) => (
                      <SelectItem key={choice.id} value={choice.id}>
                        {choice.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span>{incident.statusPageIncident?.title ?? t('notLinked')}</span>
              )}
              {incident.statusPageIncident?.statusPage && (
                <Link
                  href={`/${orgSlug}/status-pages/${incident.statusPageIncident.statusPage}`}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {incident.statusPageIncident.title}{' '}
                  <ExternalLink className="size-3" aria-hidden />
                </Link>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          <Card className="gap-3" data-testid="declared-postmortem">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">{tp('title')}</CardTitle>
              <Badge variant="outline" data-testid="postmortem-status">
                {tp(`status.${incident.postmortem.status}`)}
              </Badge>
            </CardHeader>
            <CardContent className="grid gap-3">
              {approved && incident.postmortem.approvedBy && (
                <p className="text-xs text-muted-foreground">
                  {tp('approvedBy', { name: incident.postmortem.approvedBy.name })} ·{' '}
                  {when(incident.postmortem.approvedAt)}
                </p>
              )}
              {editable ? (
                <>
                  {!postmortem && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      onClick={() => setPostmortem(postmortemTemplate((s) => tp(`sections.${s}`)))}
                      data-testid="postmortem-template"
                    >
                      {tp('start')}
                    </Button>
                  )}
                  <Textarea
                    value={postmortem}
                    onChange={(event) => setPostmortem(event.target.value)}
                    placeholder={tp('placeholder')}
                    className="min-h-64 font-mono text-sm"
                    aria-label={tp('title')}
                    data-testid="postmortem-content"
                  />
                  {approved && postmortemDirty && (
                    <p className="text-xs text-muted-foreground">{tp('editApproved')}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={pending || !postmortemDirty}
                      onClick={() => void save({ postmortem }, tp('saved'))}
                      data-testid="postmortem-save"
                    >
                      {tp('save')}
                    </Button>
                    <Button
                      disabled={pending || !postmortem.trim() || (approved && !postmortemDirty)}
                      onClick={() =>
                        void save(
                          postmortemDirty
                            ? { postmortem, approvePostmortem: true }
                            : { approvePostmortem: true },
                          tp('approved'),
                        )
                      }
                      data-testid="postmortem-approve"
                    >
                      {tp('approve')}
                    </Button>
                  </div>
                </>
              ) : incident.postmortem.content ? (
                <pre className="text-sm break-words whitespace-pre-wrap">
                  {incident.postmortem.content}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">{tp('empty')}</p>
              )}
            </CardContent>
          </Card>

          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-base">{tt('title')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5">
              {editable && (
                <form onSubmit={addNote} className="grid gap-2">
                  <Textarea
                    value={note}
                    maxLength={5000}
                    placeholder={tn('placeholder')}
                    aria-label={tn('label')}
                    onChange={(event) => setNote(event.target.value)}
                    data-testid="declared-note"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="justify-self-end"
                    disabled={pending || !note.trim()}
                  >
                    {tn('submit')}
                  </Button>
                </form>
              )}
              <ol
                className="relative flex flex-col gap-5 border-l pl-5"
                data-testid="declared-timeline"
              >
                {[...incident.timeline].reverse().map((entry) => (
                  <li key={entry.id} className="relative" data-type={entry.type}>
                    <span
                      aria-hidden
                      className="absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full bg-primary ring-4 ring-card"
                    />
                    <p className="text-sm font-medium">{timelineText(entry)}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.by?.name ?? tt('system')} ·{' '}
                      {format.dateTime(new Date(entry.at), 'precise')}
                    </p>
                    {entry.message && entry.type === 'note' && (
                      <p className="mt-1 text-sm break-words whitespace-pre-wrap text-muted-foreground">
                        {entry.message}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'canceled' ? ta('cancelTitle') : ta('closeTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'canceled' ? ta('cancelDescription') : ta('closeDescription')}
              {confirm === 'closed' && !approved && ` ${ta('closeNeedsPostmortem')}`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {ta('back')}
            </Button>
            {confirm === 'closed' && !approved && canSkipPostmortem && (
              <Button
                variant="outline"
                disabled={pending}
                data-testid="declared-close-skip"
                onClick={async () => {
                  if (await save({ status: 'closed', skipPostmortem: true })) setConfirm(null)
                }}
              >
                {ta('skipPostmortem')}
              </Button>
            )}
            <Button
              disabled={pending || (confirm === 'closed' && !approved)}
              data-testid="declared-confirm"
              onClick={async () => {
                if (confirm && (await save({ status: confirm }))) setConfirm(null)
              }}
            >
              {ta('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
