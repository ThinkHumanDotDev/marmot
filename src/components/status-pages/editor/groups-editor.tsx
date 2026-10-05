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
import { GripVertical, Plus, Trash2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import type { StatusPage } from '@/payload-types'

import { relationId, statusPagesApi, type MonitorOption, type OrgId } from '../api'

interface DraftMonitor {
  key: string
  monitorId: string
  sendUrl: boolean
  customUrl: string
}

interface DraftGroup {
  key: string
  name: string
  monitors: DraftMonitor[]
}

let counter = 0
const uid = () => `k${++counter}-${Math.random().toString(36).slice(2, 7)}`

function fromPage(page: StatusPage): DraftGroup[] {
  return (page.groups ?? []).map((group) => ({
    key: group.id ?? uid(),
    name: group.name,
    monitors: (group.monitors ?? []).map((row) => ({
      key: row.id ?? uid(),
      monitorId: relationId(row.monitor),
      sendUrl: Boolean(row.sendUrl),
      customUrl: row.customUrl ?? '',
    })),
  }))
}

function toPatch(groups: DraftGroup[], monitors: MonitorOption[]): StatusPage['groups'] {
  const byId = new Map(monitors.map((m) => [String(m.id), m.id]))
  return groups.map((group) => ({
    name: group.name.trim() || 'Untitled group',
    monitors: group.monitors.flatMap((row) => {
      const id = byId.get(row.monitorId)
      return id === undefined
        ? []
        : [{ monitor: id, sendUrl: row.sendUrl, customUrl: row.customUrl.trim() || null }]
    }),
  }))
}

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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.key,
    disabled,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg border bg-background px-2 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,14rem)_auto]',
        isDragging && 'z-10 shadow-md',
      )}
    >
      <DragHandle
        attributes={attributes}
        listeners={listeners}
        label={`Reorder ${monitor?.name ?? 'monitor'}`}
      />
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <StatusDot status={monitor?.lastStatus ?? 'unknown'} pulse={false} />
        <span className="truncate font-medium">{monitor?.name ?? `Monitor #${row.monitorId}`}</span>
        {monitor && monitor.active === false && (
          <span className="text-xs text-muted-foreground">(paused, hidden publicly)</span>
        )}
      </span>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          size="sm"
          checked={row.sendUrl}
          disabled={disabled}
          onCheckedChange={(v) => onChange({ ...row, sendUrl: v })}
        />
        Show URL
      </label>
      <Input
        className="col-span-2 h-8 text-xs sm:col-span-1"
        placeholder="Custom link (optional)"
        value={row.customUrl}
        disabled={disabled}
        onChange={(e) => onChange({ ...row, customUrl: e.target.value })}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Remove monitor from group"
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
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

  const used = new Set(group.monitors.map((m) => m.monitorId))
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

  function addMonitor(id: string) {
    if (!id) return
    onChange({
      ...group,
      monitors: [...group.monitors, { key: uid(), monitorId: id, sendUrl: false, customUrl: '' }],
    })
    setPicker('')
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
          label={`Reorder group ${group.name}`}
        />
        <Input
          aria-label="Group name"
          value={group.name}
          disabled={disabled}
          placeholder="Group name"
          className="h-8 max-w-xs font-medium"
          onChange={(e) => onChange({ ...group, name: e.target.value })}
        />
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {group.monitors.length} monitor{group.monitors.length === 1 ? '' : 's'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove group"
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

      <div className="mt-3 flex items-center gap-2">
        <Select
          value={picker}
          onValueChange={addMonitor}
          disabled={disabled || available.length === 0}
        >
          <SelectTrigger className="h-8 w-full max-w-sm text-xs" aria-label="Add monitor">
            <SelectValue
              placeholder={available.length ? 'Add a monitor…' : 'All monitors are in this group'}
            />
          </SelectTrigger>
          <SelectContent>
            {available.map((m) => (
              <SelectItem key={String(m.id)} value={String(m.id)}>
                <span className="inline-flex items-center gap-2">
                  <StatusDot status={m.lastStatus ?? 'unknown'} pulse={false} />
                  {m.name}
                  <span className="text-xs text-muted-foreground">{m.type}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
  const [groups, setGroups] = React.useState<DraftGroup[]>(() => fromPage(page))
  const [saving, setSaving] = React.useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const dirty =
    JSON.stringify(toPatch(groups, monitors)) !== JSON.stringify(toPatch(fromPage(page), monitors))

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
        groups: toPatch(groups, monitors),
      })
      onSaved(doc)
      setGroups(fromPage(doc))
      toast.success('Groups saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save groups')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label className="text-base">Groups &amp; monitors</Label>
          <p className="text-sm text-muted-foreground">
            Drag to reorder. Paused monitors stay in the list but are hidden from visitors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit}
            onClick={() =>
              setGroups((g) => [...g, { key: uid(), name: `Group ${g.length + 1}`, monitors: [] }])
            }
          >
            <Plus /> Add group
          </Button>
          <Button type="button" size="sm" disabled={!canEdit || !dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save groups'}
          </Button>
        </div>
      </div>

      {monitors.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          This organization has no monitors yet. Create monitors first, then add them here.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
          No groups yet. Add a group to start listing monitors.
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
