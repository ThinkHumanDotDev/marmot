'use client'

import * as React from 'react'

export interface PickerGroup {
  name: string
  components: { id: string; name: string }[]
}

/** Groups of components a subscriber can choose from (public page groups → picker options). */
export function pickerGroups(
  groups: readonly {
    name: string
    monitors: readonly { componentId: string | null; name: string }[]
  }[],
): PickerGroup[] {
  return groups
    .map((group) => ({
      name: group.name,
      components: group.monitors.flatMap((row) =>
        row.componentId ? [{ id: row.componentId, name: row.name }] : [],
      ),
    }))
    .filter((group) => group.components.length > 0)
}

/**
 * "All components" or "only these": a radio pair and, when scoped, one checkbox per component.
 * With `name`, the inputs also post as a plain HTML form (`components` repeated).
 */
export function ComponentPicker({
  legend,
  allLabel,
  someLabel,
  groups,
  scoped,
  selected,
  onScopedChange,
  onSelectedChange,
  name,
}: {
  legend: string
  allLabel: string
  someLabel: string
  groups: PickerGroup[]
  scoped: boolean
  selected: string[]
  onScopedChange: (scoped: boolean) => void
  onSelectedChange: (selected: string[]) => void
  name?: string
}) {
  const id = React.useId()
  const toggle = (componentId: string, checked: boolean) =>
    onSelectedChange(
      checked ? [...selected, componentId] : selected.filter((value) => value !== componentId),
    )

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${id}-scope`}
          checked={!scoped}
          onChange={() => onScopedChange(false)}
          className="accent-primary"
        />
        {allLabel}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name={`${id}-scope`}
          checked={scoped}
          onChange={() => onScopedChange(true)}
          className="accent-primary"
        />
        {someLabel}
      </label>
      {scoped && (
        <div className="ml-6 flex max-h-60 flex-col gap-3 overflow-y-auto rounded-md border p-3">
          {groups.map((group, i) => (
            <div key={`${group.name}-${i}`} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{group.name}</span>
              {group.components.map((component) => (
                <label key={component.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={name}
                    value={component.id}
                    checked={selected.includes(component.id)}
                    onChange={(e) => toggle(component.id, e.target.checked)}
                    className="accent-primary"
                  />
                  {component.name}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  )
}
