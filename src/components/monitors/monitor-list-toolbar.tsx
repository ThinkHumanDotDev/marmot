'use client'

import { ChevronDown, Search, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { isEditableTarget } from '@/components/shell/keyboard-shortcuts'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  FILTER_KEYS,
  hasActiveFilters,
  EMPTY_FILTERS,
  type FilterKey,
  type MonitorFilters,
} from '@/lib/monitor-filters'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'

export interface FilterOption {
  value: string
  label: string
  /** Swatch colour (tags). */
  color?: string | null
}

export type FilterOptions = Partial<Record<FilterKey, FilterOption[]>>

interface MonitorListToolbarProps {
  filters: MonitorFilters
  onChange: (next: MonitorFilters) => void
  /** Options per filter; a filter without options is not shown. */
  options: FilterOptions
  searchRef: React.RefObject<HTMLInputElement | null>
}

/** Focus the search box on `/` (outside text fields, dialogs and the command palette). */
function useSlashShortcut(searchRef: React.RefObject<HTMLInputElement | null>) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return
      if (useUiStore.getState().commandPaletteOpen) return
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [searchRef])
}

function FilterMenu({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: FilterOption[]
  selected: readonly string[]
  onChange: (values: string[]) => void
}) {
  const t = useTranslations('monitors.list.filters')
  const count = selected.length
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(count > 0 && 'border-primary/60')}
          aria-label={count > 0 ? t('menuLabelActive', { label, count }) : label}
        >
          {label}
          {count > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">
              {count}
            </span>
          )}
          <ChevronDown aria-hidden className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-48 overflow-y-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            // Keep the menu open so several values can be picked in a row.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...selected, option.value]
                  : selected.filter((value) => value !== option.value),
              )
            }
          >
            {option.color && (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: option.color }}
              />
            )}
            <span className="truncate">{option.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
        {count > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>{t('clearOne')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Search box and filter menus above the monitor list, plus a removable chip per active filter
 * value. Purely controlled: the list owns the state and mirrors it into the URL.
 */
export function MonitorListToolbar({
  filters,
  onChange,
  options,
  searchRef,
}: MonitorListToolbarProps) {
  const t = useTranslations('monitors.list.filters')
  const tSearch = useTranslations('monitors.list.search')
  useSlashShortcut(searchRef)

  const labels: Record<FilterKey, string> = {
    status: t('status'),
    type: t('type'),
    tag: t('tags'),
    notification: t('notifications'),
    location: t('locations'),
  }

  const chips = FILTER_KEYS.flatMap((key) =>
    filters[key].map((value) => {
      const option = options[key]?.find((candidate) => candidate.value === value)
      return { key, value, label: option?.label ?? value, color: option?.color }
    }),
  )

  return (
    <div className="grid gap-3" data-testid="monitor-list-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            type="search"
            value={filters.q}
            onChange={(event) => onChange({ ...filters, q: event.target.value })}
            placeholder={tSearch('placeholder')}
            aria-label={tSearch('label')}
            aria-keyshortcuts="/"
            className="pr-9 pl-8"
            data-testid="monitor-search"
          />
          <kbd
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded-sm border bg-background px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground sm:block"
          >
            /
          </kbd>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('label')}>
          {FILTER_KEYS.map((key) => {
            const list = options[key]
            if (!list || list.length === 0) return null
            return (
              <FilterMenu
                key={key}
                label={labels[key]}
                options={list}
                selected={filters[key]}
                onChange={(values) => onChange({ ...filters, [key]: values })}
              />
            )
          })}
        </div>
      </div>
      {(chips.length > 0 || hasActiveFilters(filters)) && (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label={t('active')}>
          {chips.map((chip) => (
            <li key={`${chip.key}:${chip.value}`}>
              <span className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pr-0.5 pl-2 text-xs">
                <span className="text-muted-foreground">{labels[chip.key]}:</span>
                {chip.color && (
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: chip.color }}
                  />
                )}
                <span className="max-w-40 truncate">{chip.label}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t('remove', { label: `${labels[chip.key]}: ${chip.label}` })}
                  onClick={() =>
                    onChange({
                      ...filters,
                      [chip.key]: filters[chip.key].filter((value) => value !== chip.value),
                    })
                  }
                >
                  <X aria-hidden className="size-3" />
                </button>
              </span>
            </li>
          ))}
          <li>
            <Button variant="ghost" size="xs" onClick={() => onChange({ ...EMPTY_FILTERS })}>
              {t('clear')}
            </Button>
          </li>
        </ul>
      )}
    </div>
  )
}
