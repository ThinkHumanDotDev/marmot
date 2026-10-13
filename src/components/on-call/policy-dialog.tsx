'use client'

import { Plus, Trash2, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  ESCALATION_TARGET_TYPES,
  MAX_ESCALATION_REPEATS,
  type EscalationPolicySummary,
  type EscalationTargetType,
} from '@/lib/on-call'

import { errorMessage, onCallApi } from './api'
import type { Choice } from './schedule-dialog'

export interface TargetChoices {
  schedule: Choice[]
  user: Choice[]
  channel: Choice[]
}

interface StepState {
  escalateAfterMinutes: number
  targets: { type: EscalationTargetType; id: string }[]
}

const emptyStep = (): StepState => ({ escalateAfterMinutes: 10, targets: [] })

/** "New policy" / "Edit" button and the policy form: steps, targets, repeat, monitors. */
export function PolicyDialog({
  orgId,
  choices,
  monitors,
  initial,
  trigger,
}: {
  orgId: string | number
  choices: TargetChoices
  monitors: Choice[]
  initial?: EscalationPolicySummary
  trigger: React.ReactNode
}) {
  const t = useTranslations('onCall.policies')
  const router = useRouter()
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [repeat, setRepeat] = React.useState(0)
  const [steps, setSteps] = React.useState<StepState[]>([])
  const [selected, setSelected] = React.useState<string[]>([])

  const reset = () => {
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setRepeat(initial?.repeat ?? 0)
    setSteps(
      initial
        ? initial.steps.map((step) => ({
            escalateAfterMinutes: step.escalateAfterMinutes,
            targets: step.targets.map((target) => ({ type: target.type, id: target.id })),
          }))
        : [emptyStep()],
    )
    setSelected(initial?.monitors.map((monitor) => monitor.id) ?? [])
  }

  const updateStep = (index: number, patch: Partial<StepState>) =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)))

  const label = (type: EscalationTargetType, targetId: string) =>
    choices[type].find((choice) => choice.id === targetId)?.name ?? targetId

  const valid = name.trim().length > 0 && steps.length > 0 && steps.every((s) => s.targets.length)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid) return
    setPending(true)
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      repeat,
      steps,
      monitors: selected,
    }
    try {
      if (initial) await onCallApi.updatePolicy(orgId, initial.id, body)
      else await onCallApi.createPolicy(orgId, body)
      toast.success(initial ? t('saved') : t('created'))
      setOpen(false)
      router.refresh()
    } catch (error) {
      toast.error(errorMessage(error, t('failed')))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <span
        onClickCapture={() => {
          reset()
          setOpen(true)
        }}
      >
        {trigger}
      </span>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <form onSubmit={submit} className="flex flex-col gap-5" data-testid="policy-form">
            <DialogHeader>
              <DialogTitle>{t('dialogTitle')}</DialogTitle>
              <DialogDescription>{t('dialogDescription')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-name`}>{t('name')}</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={100}
                  placeholder={t('namePlaceholder')}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-repeat`}>{t('repeat')}</Label>
                <Input
                  id={`${id}-repeat`}
                  type="number"
                  min={0}
                  max={MAX_ESCALATION_REPEATS}
                  value={repeat}
                  title={t('repeatHint')}
                  onChange={(event) =>
                    setRepeat(
                      Math.min(
                        MAX_ESCALATION_REPEATS,
                        Math.max(0, Number(event.target.value) || 0),
                      ),
                    )
                  }
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-description`}>{t('description')}</Label>
              <Textarea
                id={`${id}-description`}
                value={description}
                rows={2}
                maxLength={1000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t('steps')}</p>
              {steps.map((step, index) => (
                <fieldset
                  key={index}
                  className="flex flex-col gap-3 rounded-lg border p-3"
                  data-testid="policy-step"
                >
                  <div className="flex items-center justify-between gap-2">
                    <legend className="text-sm font-medium">
                      {t('step', { number: index + 1 })}
                    </legend>
                    {steps.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('removeStep', { number: index + 1 })}
                        onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>{t('targets')}</Label>
                    <ul className="flex flex-wrap gap-2">
                      {step.targets.map((target, ti) => (
                        <li
                          key={`${target.type}-${target.id}`}
                          className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm"
                        >
                          <span className="text-muted-foreground">
                            {t(`targetTypes.${target.type}`)}
                          </span>
                          <span>{label(target.type, target.id)}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            aria-label={t('removeTarget')}
                            onClick={() =>
                              updateStep(index, {
                                targets: step.targets.filter((_, i) => i !== ti),
                              })
                            }
                          >
                            <X className="size-3.5" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                    <Select
                      value=""
                      onValueChange={(value) => {
                        const [type, ...rest] = value.split(':')
                        const targetId = rest.join(':')
                        if (step.targets.some((x) => x.type === type && x.id === targetId)) return
                        updateStep(index, {
                          targets: [
                            ...step.targets,
                            { type: type as EscalationTargetType, id: targetId },
                          ],
                        })
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label={t('addTarget')}>
                        <SelectValue placeholder={t('addTarget')} />
                      </SelectTrigger>
                      <SelectContent>
                        {ESCALATION_TARGET_TYPES.flatMap((type) =>
                          choices[type].map((choice) => (
                            <SelectItem key={`${type}:${choice.id}`} value={`${type}:${choice.id}`}>
                              {t(`targetTypes.${type}`)}
                              {': '}
                              {choice.name}
                            </SelectItem>
                          )),
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2 sm:w-56">
                    <Label htmlFor={`${id}-${index}-after`}>{t('escalateAfter')}</Label>
                    <Input
                      id={`${id}-${index}-after`}
                      type="number"
                      min={1}
                      max={1440}
                      value={step.escalateAfterMinutes}
                      onChange={(event) =>
                        updateStep(index, {
                          escalateAfterMinutes: Math.min(
                            1440,
                            Math.max(1, Number(event.target.value) || 1),
                          ),
                        })
                      }
                    />
                  </div>
                </fieldset>
              ))}
              {!valid && steps.some((step) => step.targets.length === 0) && (
                <p className="text-xs text-muted-foreground">{t('noTargets')}</p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={steps.length >= 20}
                onClick={() => setSteps((current) => [...current, emptyStep()])}
              >
                <Plus className="size-4" />
                {t('addStep')}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{t('monitors')}</p>
              <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-lg border p-3">
                {monitors.map((monitor) => {
                  const on = selected.includes(monitor.id)
                  return (
                    <label key={monitor.id} className="flex items-center gap-3 text-sm">
                      <Switch
                        checked={on}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...current, monitor.id]
                              : current.filter((other) => other !== monitor.id),
                          )
                        }
                      />
                      {monitor.name}
                    </label>
                  )
                })}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={pending || !valid}>
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
