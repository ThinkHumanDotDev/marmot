'use client'

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Box, GripVertical, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
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
import type { ComponentType } from '@/lib/status-page-components'
import { cn } from '@/lib/utils'
import type { StatusPage } from '@/payload-types'

import {
  relationId,
  statusPagesApi,
  type MonitorOption,
  type OrgId,
  type StatusPageGroup,
} from '../api'

/**
 * One component row (see `src/lib/status-page-components.ts`). `id` is the stored row id: it is
 * sent back on save so incidents that reference the component keep pointing at it.
 */
interface DraftMonitor {
  key: string
  id?: string
  type: ComponentType
  monitorId: string
  name: string
  description: string
  showValues: boolean
  sendUrl: boolean
  customUrl: string
}

interface DraftGroup {
  key: string
  id?: string
  name: string
  defaultOpen: boolean
  monitors: DraftMonitor[]
}

let counter = 0
const uid = () => `k${++counter}-${Math.random().toString(36).slice(2, 7)}`

function fromPage(page: StatusPage): DraftGroup[] {
  return (page.groups ?? []).map((group) => ({
    key: group.id ?? uid(),
    ...(group.id ? { id: group.id } : {}),
    name: group.name,
    defaultOpen: group.defaultOpen !== false,
    monitors: (group.monitors ?? []).map((row) => ({
      key: row.id ?? uid(),
      ...(row.id ? { id: row.id } : {}),
      type: row.type === 'static' ? 'static' : 'monitor',
      monitorId: row.type === 'static' || row.monitor == null ? '' : relationId(row.monitor),
      name: row.name ?? '',
      description: row.description ?? '',
      showValues: row.showValues !== false,
      sendUrl: Boolean(row.sendUrl),
      customUrl: row.customUrl ?? '',
    })),
  }))
}

function toPatch(
  groups: DraftGroup[],
  monitors: MonitorOption[],
  untitled: string,
): StatusPage['groups'] {
  const byId = new Map(monitors.map((m) => [String(m.id), m.id]))
  return groups.map((group) => ({
    ...(group.id ? { id: group.id } : {}),
    name: group.name.trim() || untitled,
    defaultOpen: group.defaultOpen,
    monitors: group.monitors.flatMap((row): NonNullable<StatusPageGroup['monitors']> => {
      const common = {
        ...(row.id ? { id: row.id } : {}),
        type: row.type,
        name: row.name.trim() || null,
        description: row.description.trim() || null,
        showValues: row.showValues,
        customUrl: row.customUrl.trim() || null,
      }
      if (row.type === 'static') return [{ ...common, monitor: null, sendUrl: false }]
      const id = byId.get(row.monitorId)
      return id === undefined ? [] : [{ ...common, monitor: id, sendUrl: row.sendUrl }]
    }),
  }))
}

const isInvalid = (groups: DraftGroup[]) =>
  groups.some((g) => g.monitors.some((row) => row.type === 'static' && !row.name.trim()))

type SortableHandle = Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners'>

function DragHandle({ attributes, listeners, label }: SortableHandle & { label: string }) {
  return (
    <button
      type="button"
      className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
      aria-label={label}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  )
}

function SortableMonitorRow({
  row,
  monitor,
  disabled,
  onChange,
  onRemove,
}: {
  row: DraftMonitor
  monitor: MonitorOption | undefined
  disabled: boolean
  onChange: (next: DraftMonitor) => void
  onRemove: () => void
}) {
  const t = useTranslations('statusPages.groups')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.key,
    disabled,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const isStatic = row.type === 'static'
  const monitorName = monitor?.name ?? t('unknownMonitor', { id: row.monitorId })
  const label = row.name.trim() || (isStatic ? t('componentFallback') : monitorName)
  const defaultName = monitor?.publicName?.trim() || monitor?.name || ''

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-component-type={row.type}
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg border bg-background px-2 py-2',
        isDragging && 'z-10 shadow-md',
      )}
    >
      <DragHandle
        attributes={attributes}
        listeners={listeners}
        label={t('reorderMonitor', { name: label })}
      />
      <span className="flex min-w-0 items-center gap-2 text-sm">
        {isStatic ? (
          <>
            <Box className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t('staticBadge')}
            </span>
            <span className="truncate text-xs text-muted-foreground">{t('staticHint')}</span>
          </>
        ) : (
          <>
            <StatusDot status={monitor?.lastStatus ?? 'unknown'} pulse={false} />
            <span className="truncate font-medium">{monitorName}</span>
            {monitor && monitor.active === false && (
              <span className="text-xs text-muted-foreground">{t('pausedHidden')}</span>
            )}
          </>
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('removeComponent')}
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>

      <div className="col-span-3 grid gap-2 sm:col-start-2 sm:col-end-4 sm:grid-cols-2">
        <Input
          className="h-8 text-xs"
          aria-label={t('componentName')}
          aria-invalid={isStatic && !row.name.trim() ? true : undefined}
          required={isStatic}
          placeholder={
            isStatic
              ? t('staticNamePlaceholder')
              : t('componentNamePlaceholder', { name: defaultName })
          }
          value={row.name}
          disabled={disabled}
          onChange={(e) => onChange({ ...row, name: e.target.value })}
        />
        <Input
          className="h-8 text-xs"
          aria-label={t('componentDescription')}
          placeholder={t('componentDescription')}
          value={row.description}
          disabled={disabled}
          onChange={(e) => onChange({ ...row, description: e.target.value })}
        />
        <Input
          className="h-8 text-xs"
          aria-label={t('customUrlPlaceholder')}
          placeholder={t('customUrlPlaceholder')}
          value={row.customUrl}
          disabled={disabled}
          onChange={(e) => onChange({ ...row, customUrl: e.target.value })}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {!isStatic && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                size="sm"
                checked={row.sendUrl}
                disabled={disabled}
                onCheckedChange={(v) => onChange({ ...row, sendUrl: v })}
              />
              {t('showUrl')}
            </label>
          )}
          {!isStatic && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                size="sm"
                checked={row.showValues}
                disabled={disabled}
                onCheckedChange={(v) => onChange({ ...row, showValues: v })}
              />
              {t('showValues')}
            </label>
          )}
        </div>
      </div>
    </li>
  )
}

function SortableGroup({
  group,
  monitors,
  disabled,
  onChange,
  onRemove,
}: {
  group: DraftGroup
  monitors: MonitorOption[]
  disabled: boolean
  onChange: (next: DraftGroup) => void
  onRemove: () => void
}) {
  const t = useTranslations('statusPages.groups')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.key,
    disabled,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [picker, setPicker] = React.useState('')

  const used = new Set(group.monitors.filter((m) => m.type === 'monitor').map((m) => m.monitorId))
  const available = monitors.filter((m) => !used.has(String(m.id)))
  const byId = new Map(monitors.map((m) => [String(m.id), m]))

  function onMonitorDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = group.monitors.findIndex((m) => m.key === active.id)
    const to = group.monitors.findIndex((m) => m.key === over.id)
    if (from < 0 || to < 0) return
    onChange({ ...group, monitors: arrayMove(group.monitors, from, to) })
  }

  const blank = { name: '', description: '', showValues: true, sendUrl: false, customUrl: '' }

  function addMonitor(id: string) {
    if (!id) return
    onChange({
      ...group,
      monitors: [...group.monitors, { ...blank, key: uid(), type: 'monitor', monitorId: id }],
    })
    setPicker('')
  }

  function addStatic() {
    onChange({
      ...group,
      monitors: [...group.monitors, { ...blank, key: uid(), type: 'static', monitorId: '' }],
    })
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-xl border bg-card p-4 shadow-sm',
        isDragging && 'z-10 opacity-90 shadow-lg',
      )}
    >
      <div className="flex items-center gap-2">
        <DragHandle
          attributes={attributes}
          listeners={listeners}
          label={t('reorderGroup', { name: group.name })}
        />
        <Input
          aria-label={t('groupName')}
          value={group.name}
          disabled={disabled}
          placeholder={t('groupName')}
          className="h-8 max-w-xs font-medium"
          onChange={(e) => onChange({ ...group, name: e.target.value })}
        />
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={group.defaultOpen}
            disabled={disabled}
            onCheckedChange={(v) => onChange({ ...group, defaultOpen: v })}
          />
          {t('defaultOpen')}
        </label>
        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
          {t('componentCount', { count: group.monitors.length })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('removeGroup')}
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onMonitorDragEnd}>
        <SortableContext
          items={group.monitors.map((m) => m.key)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="mt-3 flex flex-col gap-2">
            {group.monitors.map((row, index) => (
              <SortableMonitorRow
                key={row.key}
                row={row}
                monitor={byId.get(row.monitorId)}
                disabled={disabled}
                onChange={(next) => {
                  const monitorsNext = group.monitors.slice()
                  monitorsNext[index] = next
                  onChange({ ...group, monitors: monitorsNext })
                }}
                onRemove={() =>
                  onChange({ ...group, monitors: group.monitors.filter((m) => m.key !== row.key) })
                }
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select
          value={picker}
          onValueChange={addMonitor}
          disabled={disabled || available.length === 0}
        >
          <SelectTrigger className="h-8 w-full max-w-sm text-xs" aria-label={t('addMonitor')}>
            <SelectValue
              placeholder={available.length ? t('addMonitorPlaceholder') : t('allMonitorsAdded')}
            />
          </SelectTrigger>
          <SelectContent>
            {available.map((m) => (
              <SelectItem key={String(m.id)} value={String(m.id)}>
                <span className="inline-flex items-center gap-2">
                  <StatusDot status={m.lastStatus ?? 'unknown'} pulse={false} />
                  {m.name}
                  {m.publicName && (
                    <span className="text-xs text-muted-foreground">({m.publicName})</span>
                  )}
                  <span className="text-xs text-muted-foreground">{m.type}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={addStatic}>
          <Plus /> {t('addStatic')}
        </Button>
      </div>
    </li>
  )
}

export function GroupsEditor({
  orgId,
  page,
  monitors,
  onSaved,
  canEdit,
}: {
  orgId: OrgId
  page: StatusPage
  monitors: MonitorOption[]
  onSaved: (page: StatusPage) => void
  canEdit: boolean
}) {
  const t = useTranslations('statusPages.groups')
  const untitled = t('untitled')
  const [groups, setGroups] = React.useState<DraftGroup[]>(() => fromPage(page))
  const [saving, setSaving] = React.useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const dirty =
    JSON.stringify(toPatch(groups, monitors, untitled)) !==
    JSON.stringify(toPatch(fromPage(page), monitors, untitled))
  const invalid = isInvalid(groups)

  function onGroupDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = groups.findIndex((g) => g.key === active.id)
    const to = groups.findIndex((g) => g.key === over.id)
    if (from < 0 || to < 0) return
    setGroups(arrayMove(groups, from, to))
  }

  async function save() {
    setSaving(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, {
        groups: toPatch(groups, monitors, untitled),
      })
      onSaved(doc)
      setGroups(fromPage(doc))
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label className="text-base">{t('title')}</Label>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit}
            onClick={() =>
              setGroups((g) => [
                ...g,
                {
                  key: uid(),
                  name: t('defaultName', { number: g.length + 1 }),
                  defaultOpen: true,
                  monitors: [],
                },
              ])
            }
          >
            <Plus /> {t('addGroup')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canEdit || !dirty || saving || invalid}
            onClick={save}
          >
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>

      {invalid && (
        <p role="alert" className="text-sm text-destructive">
          {t('staticNameRequired')}
        </p>
      )}

      {monitors.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          {t('noMonitors')}
        </p>
      )}

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onGroupDragEnd}>
          <SortableContext items={groups.map((g) => g.key)} strategy={verticalListSortingStrategy}>
            <ul className="flex flex-col gap-3">
              {groups.map((group, index) => (
                <SortableGroup
                  key={group.key}
                  group={group}
                  monitors={monitors}
                  disabled={!canEdit}
                  onChange={(next) => {
                    const copy = groups.slice()
                    copy[index] = next
                    setGroups(copy)
                  }}
                  onRemove={() => setGroups(groups.filter((g) => g.key !== group.key))}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
