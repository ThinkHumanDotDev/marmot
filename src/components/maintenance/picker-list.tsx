'use client'

import { Check, Search } from 'lucide-react'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface PickerOption {
  id: string
  label: string
  hint?: string | null
}

interface PickerListProps {
  options: PickerOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  emptyText?: string
  /** Accessible name of the list. */
  label: string
  /** Shown when the selection is empty and nothing matches the search. */
  disabled?: boolean
}

/**
 * Searchable multi-select checklist (Uptime Kuma uses vue-multiselect here). Keyboard friendly:
 * each row is a toggle button; "Select all" applies to the rows currently shown by the search.
 */
export function PickerList({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  emptyText = 'Nothing to pick from yet.',
  label,
  disabled,
}: PickerListProps) {
  const [query, setQuery] = React.useState('')
  const selected = React.useMemo(() => new Set(value), [value])
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q),
    )
  }, [options, query])
  const allShownSelected = shown.length > 0 && shown.every((o) => selected.has(o.id))

  const toggle = (id: string) => {
    if (disabled) return
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(options.filter((o) => next.has(o.id)).map((o) => o.id))
  }

  const toggleAllShown = () => {
    if (disabled) return
    const next = new Set(selected)
    for (const o of shown) {
      if (allShownSelected) next.delete(o.id)
      else next.add(o.id)
    }
    onChange(options.filter((o) => next.has(o.id)).map((o) => o.id))
  }

  if (options.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
        {emptyText}
      </p>
    )
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          aria-label={`Search ${label}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          disabled={disabled}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={toggleAllShown}
          disabled={disabled || shown.length === 0}
        >
          {allShownSelected ? 'Deselect all' : 'Select all'}
        </Button>
      </div>
      <ul
        role="listbox"
        aria-multiselectable
        aria-label={label}
        className="max-h-64 divide-y overflow-y-auto"
      >
        {shown.length === 0 && (
          <li className="px-3 py-3 text-sm text-muted-foreground">No matches.</li>
        )}
        {shown.map((option) => {
          const checked = selected.has(option.id)
          return (
            <li key={option.id} role="option" aria-selected={checked}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => toggle(option.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-60',
                  checked && 'bg-accent/60',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}
                >
                  {checked && <Check className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && (
                  <span className="shrink-0 text-xs text-muted-foreground">{option.hint}</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
        {value.length} of {options.length} selected
      </div>
    </div>
  )
}
