'use client'

import { ArrowUp, Plus, Trash2, X } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import {
  ROTATION_TYPES,
  ROTATION_UNITS,
  WEEKDAYS,
  type OnCallScheduleSummary,
  type RotationType,
  type RotationUnit,
  type Weekday,
} from '@/lib/on-call'
import { cn } from '@/lib/utils'

import { errorMessage, onCallApi } from './api'

export interface Choice {
  id: string
  name: string
}

interface LayerState {
  name: string
  timezone: string | null
  rotation: RotationType
  customLength: number
  customUnit: RotationUnit
  handoffTime: string
  startDate: string
  members: string[]
  restrictions: { days: Weekday[]; start: string; end: string }[]
}

const today = () => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const emptyLayer = (): LayerState => ({
  name: '',
  timezone: null,
  rotation: 'weekly',
  customLength: 1,
  customUnit: 'days',
  handoffTime: '09:00',
  startDate: today(),
  members: [],
  restrictions: [],
})

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const zones = (): string[] => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

/** "New schedule" / "Edit" button and the schedule form (layers, rotation, members, windows). */
export function ScheduleDialog({
  orgId,
  members,
  initial,
  trigger,
}: {
  orgId: string | number
  members: Choice[]
  initial?: OnCallScheduleSummary
  trigger: React.ReactNode
}) {
  const t = useTranslations('onCall.schedule')
  const router = useRouter()
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [timezone, setTimezone] = React.useState('UTC')
  const [layers, setLayers] = React.useState<LayerState[]>([])
  const zoneList = React.useMemo(() => zones(), [])

  const reset = React.useCallback(() => {
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setTimezone(initial?.timezone ?? browserZone())
    setLayers(
      initial
        ? initial.layers.map((layer) => ({
            name: layer.name,
            timezone: layer.timezone,
            rotation: layer.rotation,
            customLength: layer.customLength ?? 1,
            customUnit: layer.customUnit,
            handoffTime: layer.handoffTime,
            startDate: layer.startDate,
            members: layer.members.map((member) => member.id),
            restrictions: layer.restrictions.map((window) => ({
              ...window,
              days: [...window.days],
            })),
          }))
        : [emptyLayer()],
    )
  }, [initial])

  const memberName = (memberId: string) =>
    members.find((member) => member.id === memberId)?.name ?? memberId

  const updateLayer = (index: number, patch: Partial<LayerState>) =>
    setLayers((current) =>
      current.map((layer, i) => (i === index ? { ...layer, ...patch } : layer)),
    )

  const valid =
    name.trim().length > 0 && layers.every((layer) => layer.members.length > 0 && layer.startDate)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid) return
    setPending(true)
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      timezone,
      layers: layers.map((layer) => ({
        name: layer.name.trim() || undefined,
        timezone: layer.timezone,
        rotation: layer.rotation,
        customLength: layer.rotation === 'custom' ? layer.customLength : null,
        customUnit: layer.customUnit,
        handoffTime: layer.handoffTime,
        startDate: layer.startDate,
        members: layer.members,
        restrictions: layer.restrictions.filter((window) => window.days.length > 0),
      })),
    }
    try {
      if (initial) await onCallApi.updateSchedule(orgId, initial.id, body)
      else await onCallApi.createSchedule(orgId, body)
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
          <form onSubmit={submit} className="flex flex-col gap-5" data-testid="schedule-form">
            <DialogHeader>
              <DialogTitle>{t('dialogTitle')}</DialogTitle>
              <DialogDescription>{t('dialogDescription')}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
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
                <Label htmlFor={`${id}-zone`}>{t('timezone')}</Label>
                <Input
                  id={`${id}-zone`}
                  value={timezone}
                  list={`${id}-zones`}
                  onChange={(event) => setTimezone(event.target.value)}
                  required
                />
                <datalist id={`${id}-zones`}>
                  {zoneList.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-description`}>{t('description')}</Label>
              <Textarea
                id={`${id}-description`}
                value={description}
                maxLength={1000}
                rows={2}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t('layers')}</p>
              {layers.map((layer, index) => (
                <fieldset
                  key={index}
                  className="flex flex-col gap-3 rounded-lg border p-3"
                  data-testid="schedule-layer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <legend className="text-sm font-medium">
                      {t('layer', { number: index + 1 })}
                    </legend>
                    {layers.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('removeLayer')}
                        onClick={() =>
                          setLayers((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`${id}-${index}-name`}>{t('layerName')}</Label>
                      <Input
                        id={`${id}-${index}-name`}
                        value={layer.name}
                        maxLength={100}
                        placeholder={t('layerNamePlaceholder')}
                        onChange={(event) => updateLayer(index, { name: event.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`${id}-${index}-rotation`}>{t('rotation')}</Label>
                      <Select
                        value={layer.rotation}
                        onValueChange={(value) =>
                          updateLayer(index, { rotation: value as RotationType })
                        }
                      >
                        <SelectTrigger id={`${id}-${index}-rotation`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROTATION_TYPES.map((rotation) => (
                            <SelectItem key={rotation} value={rotation}>
                              {t(`rotations.${rotation}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {layer.rotation === 'custom' && (
                      <div className="flex flex-col gap-2">
                        <Label htmlFor={`${id}-${index}-length`}>{t('customLength')}</Label>
                        <div className="flex gap-2">
                          <Input
                            id={`${id}-${index}-length`}
                            type="number"
                            min={1}
                            max={8760}
                            value={layer.customLength}
                            onChange={(event) =>
                              updateLayer(index, {
                                customLength: Math.max(1, Number(event.target.value) || 1),
                              })
                            }
                          />
                          <Select
                            value={layer.customUnit}
                            onValueChange={(value) =>
                              updateLayer(index, { customUnit: value as RotationUnit })
                            }
                          >
                            <SelectTrigger className="w-28" aria-label={t('customLength')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROTATION_UNITS.map((unit) => (
                                <SelectItem key={unit} value={unit}>
                                  {t(`units.${unit}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`${id}-${index}-handoff`}>{t('handoffTime')}</Label>
                      <Input
                        id={`${id}-${index}-handoff`}
                        type="time"
                        value={layer.handoffTime}
                        onChange={(event) =>
                          updateLayer(index, { handoffTime: event.target.value })
                        }
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`${id}-${index}-start`}>{t('startDate')}</Label>
                      <Input
                        id={`${id}-${index}-start`}
                        type="date"
                        value={layer.startDate}
                        onChange={(event) => updateLayer(index, { startDate: event.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label>{t('members')}</Label>
                    <ol className="flex flex-col gap-1">
                      {layer.members.map((memberId, position) => (
                        <li
                          key={memberId}
                          className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm"
                        >
                          <span className="w-5 text-muted-foreground tabular-nums">
                            {position + 1}
                          </span>
                          <span className="flex-1 truncate">{memberName(memberId)}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={position === 0}
                            aria-label={t('moveUp', { name: memberName(memberId) })}
                            onClick={() => {
                              const next = [...layer.members]
                              ;[next[position - 1], next[position]] = [
                                next[position],
                                next[position - 1],
                              ]
                              updateLayer(index, { members: next })
                            }}
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label={t('removeMember', { name: memberName(memberId) })}
                            onClick={() =>
                              updateLayer(index, {
                                members: layer.members.filter((other) => other !== memberId),
                              })
                            }
                          >
                            <X className="size-4" />
                          </Button>
                        </li>
                      ))}
                    </ol>
                    <Select
                      value=""
                      onValueChange={(value) =>
                        value && updateLayer(index, { members: [...layer.members, value] })
                      }
                    >
                      <SelectTrigger className="w-full" aria-label={t('addMember')}>
                        <SelectValue placeholder={t('addMember')} />
                      </SelectTrigger>
                      <SelectContent>
                        {members
                          .filter((member) => !layer.members.includes(member.id))
                          .map((member) => (
                            <SelectItem key={member.id} value={member.id}>
                              {member.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {layer.members.length === 0 && (
                      <p className="text-xs text-muted-foreground">{t('noMembers')}</p>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label>{t('restrictions')}</Label>
                    {layer.restrictions.length === 0 && (
                      <p className="text-xs text-muted-foreground">{t('noRestrictions')}</p>
                    )}
                    {layer.restrictions.map((window, w) => {
                      const setWindow = (patch: Partial<LayerState['restrictions'][number]>) =>
                        updateLayer(index, {
                          restrictions: layer.restrictions.map((other, i) =>
                            i === w ? { ...other, ...patch } : other,
                          ),
                        })
                      return (
                        <div key={w} className="flex flex-wrap items-center gap-2">
                          <div className="flex gap-1">
                            {WEEKDAYS.map((day) => {
                              const on = window.days.includes(day)
                              return (
                                <Button
                                  key={day}
                                  type="button"
                                  size="sm"
                                  variant={on ? 'default' : 'outline'}
                                  aria-pressed={on}
                                  className={cn('h-7 px-2 text-xs')}
                                  onClick={() =>
                                    setWindow({
                                      days: on
                                        ? window.days.filter((other) => other !== day)
                                        : WEEKDAYS.filter(
                                            (other) => other === day || window.days.includes(other),
                                          ),
                                    })
                                  }
                                >
                                  {t(`weekdays.${day}`)}
                                </Button>
                              )
                            })}
                          </div>
                          <Input
                            type="time"
                            className="w-28"
                            aria-label={t('from')}
                            value={window.start}
                            onChange={(event) => setWindow({ start: event.target.value })}
                          />
                          <Input
                            type="time"
                            className="w-28"
                            aria-label={t('to')}
                            value={window.end}
                            onChange={(event) => setWindow({ end: event.target.value })}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label={t('removeRestriction')}
                            onClick={() =>
                              updateLayer(index, {
                                restrictions: layer.restrictions.filter((_, i) => i !== w),
                              })
                            }
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                      )
                    })}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={() =>
                        updateLayer(index, {
                          restrictions: [
                            ...layer.restrictions,
                            {
                              days: ['mon', 'tue', 'wed', 'thu', 'fri'],
                              start: '09:00',
                              end: '17:00',
                            },
                          ],
                        })
                      }
                    >
                      <Plus className="size-4" />
                      {t('addRestriction')}
                    </Button>
                  </div>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={layers.length >= 10}
                onClick={() => setLayers((current) => [...current, emptyLayer()])}
              >
                <Plus className="size-4" />
                {t('addLayer')}
              </Button>
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
