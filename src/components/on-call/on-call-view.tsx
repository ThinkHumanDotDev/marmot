'use client'

import { CalendarClock, Pencil, ShieldAlert, Trash2, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type {
  EscalationPolicySummary,
  OnCallScheduleSummary,
  OnCallShiftSummary,
} from '@/lib/on-call'

import { errorMessage, onCallApi, useOnCallRefresh } from './api'
import { OverrideDialog, overridesBody } from './override-dialog'
import { PolicyDialog, type TargetChoices } from './policy-dialog'
import { ScheduleDialog, type Choice } from './schedule-dialog'

interface OnCallViewProps {
  orgId: string | number
  schedules: OnCallScheduleSummary[]
  /** Upcoming shifts of every schedule (next four weeks). */
  shifts: OnCallShiftSummary[]
  /** The signed-in member's id, to pick their own shifts. */
  userId: string
  policies: EscalationPolicySummary[] | null
  members: Choice[]
  choices: TargetChoices
  monitors: Choice[]
  canManage: boolean
  canManagePolicies: boolean
}

function Section({
  title,
  action,
  children,
  testId,
}: {
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  testId?: string
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** On-call dashboard: who is on call, the member's shifts, schedules and escalation policies. */
export function OnCallView(props: OnCallViewProps) {
  const { orgId, schedules, shifts, userId, policies, members, canManage, canManagePolicies } =
    props
  const t = useTranslations('onCall')
  const format = useFormatter()
  const router = useRouter()
  const [deleting, setDeleting] = React.useState<{
    kind: 'schedule' | 'policy'
    id: string
    name: string
  } | null>(null)
  useOnCallRefresh(orgId)

  const mine = shifts.filter((shift) => shift.user.id === userId)
  const range = (start: string, end: string) =>
    format.dateTimeRange(new Date(start), new Date(end), 'short')

  async function removeOverride(schedule: OnCallScheduleSummary, overrideId: string) {
    try {
      await onCallApi.updateSchedule(orgId, schedule.id, {
        overrides: overridesBody(schedule).filter(
          (_, i) => schedule.overrides[i].id !== overrideId,
        ),
      })
      toast.success(t('override.removed'))
      router.refresh()
    } catch (error) {
      toast.error(errorMessage(error, t('override.failed')))
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    const scope = deleting.kind === 'schedule' ? 'schedule' : 'policies'
    try {
      if (deleting.kind === 'schedule') await onCallApi.deleteSchedule(orgId, deleting.id)
      else await onCallApi.deletePolicy(orgId, deleting.id)
      toast.success(t(`${scope}.deleted`))
      setDeleting(null)
      router.refresh()
    } catch (error) {
      toast.error(errorMessage(error, t(`${scope}.failed`)))
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <Section title={t('mine.title')} testId="my-shifts">
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('mine.empty')}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {mine.map((shift) => (
              <li
                key={`${shift.scheduleId}-${shift.start}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              >
                <span className="font-medium">{shift.scheduleName}</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {shift.source === 'override' && (
                    <Badge variant="secondary">{t('mine.override')}</Badge>
                  )}
                  {range(shift.start, shift.end)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t('now.title')}
        testId="on-call-now"
        action={
          canManage ? (
            <ScheduleDialog
              orgId={orgId}
              members={members}
              trigger={<Button size="sm">{t('schedule.new')}</Button>}
            />
          ) : undefined
        }
      >
        {schedules.length === 0 ? (
          <EmptyState icon={CalendarClock} title={t('now.empty')} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {schedules.map((schedule) => {
              const upcoming = shifts
                .filter((shift) => shift.scheduleId === schedule.id)
                .slice(0, 4)
              return (
                <article
                  key={schedule.id}
                  className="flex flex-col gap-4 rounded-xl border bg-card p-4"
                  data-testid="schedule-card"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{schedule.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t('now.timezone', { zone: schedule.timezone })}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex gap-1">
                        <ScheduleDialog
                          orgId={orgId}
                          members={members}
                          initial={schedule}
                          trigger={
                            <Button variant="ghost" size="icon" aria-label={t('schedule.edit')}>
                              <Pencil className="size-4" />
                            </Button>
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('schedule.delete')}
                          onClick={() =>
                            setDeleting({ kind: 'schedule', id: schedule.id, name: schedule.name })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg bg-muted/50 px-3 py-2" data-testid="on-call-person">
                    {schedule.onCall ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{schedule.onCall.user.name}</span>
                        {schedule.onCall.source === 'override' && (
                          <Badge variant="secondary">{t('now.override')}</Badge>
                        )}
                        <span className="text-sm text-muted-foreground">
                          {schedule.onCall.until
                            ? t('now.until', {
                                date: format.dateTime(new Date(schedule.onCall.until), 'short'),
                              })
                            : t('now.noEnd')}
                        </span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">{t('now.nobody')}</span>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase">
                      {t('schedule.upcoming')}
                    </p>
                    {upcoming.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t('schedule.noUpcoming')}</p>
                    ) : (
                      <ul className="flex flex-col gap-1 text-sm">
                        {upcoming.map((shift) => (
                          <li key={shift.start} className="flex justify-between gap-2">
                            <span>{shift.user.name}</span>
                            <span className="text-muted-foreground">
                              {range(shift.start, shift.end)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {(schedule.overrides.length > 0 || canManage) && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase">
                          {t('override.list')}
                        </p>
                        {canManage && (
                          <OverrideDialog orgId={orgId} schedule={schedule} members={members} />
                        )}
                      </div>
                      <ul className="flex flex-col gap-1 text-sm">
                        {schedule.overrides.map((override) => (
                          <li key={override.id} className="flex items-center justify-between gap-2">
                            <span>{override.user.name}</span>
                            <span className="flex items-center gap-1 text-muted-foreground">
                              {range(override.start, override.end)}
                              {canManage && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-6"
                                  aria-label={t('override.remove', { name: override.user.name })}
                                  onClick={() => removeOverride(schedule, override.id)}
                                >
                                  <X className="size-3.5" />
                                </Button>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </Section>

      {policies && (
        <Section
          title={t('policies.title')}
          testId="escalation-policies"
          action={
            canManagePolicies ? (
              <PolicyDialog
                orgId={orgId}
                choices={props.choices}
                monitors={props.monitors}
                trigger={<Button size="sm">{t('policies.new')}</Button>}
              />
            ) : undefined
          }
        >
          {policies.length === 0 ? (
            <EmptyState icon={ShieldAlert} title={t('policies.empty')} />
          ) : (
            <div className="flex flex-col gap-4">
              {policies.map((policy) => (
                <article
                  key={policy.id}
                  className="flex flex-col gap-3 rounded-xl border bg-card p-4"
                  data-testid="policy-card"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{policy.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {t('policies.repeats', { count: policy.repeat })}
                      </p>
                    </div>
                    {canManagePolicies && (
                      <div className="flex gap-1">
                        <PolicyDialog
                          orgId={orgId}
                          choices={props.choices}
                          monitors={props.monitors}
                          initial={policy}
                          trigger={
                            <Button variant="ghost" size="icon" aria-label={t('policies.edit')}>
                              <Pencil className="size-4" />
                            </Button>
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('policies.delete')}
                          onClick={() =>
                            setDeleting({ kind: 'policy', id: policy.id, name: policy.name })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                  <ol className="flex flex-col gap-2 text-sm">
                    {policy.steps.map((step, index) => (
                      <li key={index} className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium">
                          {t('policies.step', { number: index + 1 })}
                        </span>
                        <span>
                          {step.targets
                            .map(
                              (target) => target.name || t(`policies.targetTypes.${target.type}`),
                            )
                            .join(', ')}
                        </span>
                        <span className="text-muted-foreground">
                          {t('policies.after', { minutes: step.escalateAfterMinutes })}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-muted-foreground">
                    {policy.monitors.length === 0
                      ? t('policies.noMonitors')
                      : `${t('policies.monitors')}: ${policy.monitors.map((m) => m.name).join(', ')}`}
                  </p>
                </article>
              ))}
            </div>
          )}
        </Section>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={
          deleting
            ? t(`${deleting.kind === 'schedule' ? 'schedule' : 'policies'}.deleteTitle`, {
                name: deleting.name,
              })
            : ''
        }
        description={
          deleting
            ? t(`${deleting.kind === 'schedule' ? 'schedule' : 'policies'}.deleteDescription`)
            : undefined
        }
        confirmLabel={
          deleting ? t(`${deleting.kind === 'schedule' ? 'schedule' : 'policies'}.delete`) : ''
        }
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  )
}
