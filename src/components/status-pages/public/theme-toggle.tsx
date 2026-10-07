'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { cn } from '@/lib/utils'

import { STATUS_THEME_STORAGE_KEY, VISITOR_THEMES, type VisitorTheme } from './theme-storage'

const ICONS: Record<VisitorTheme, typeof Sun> = { system: Monitor, light: Sun, dark: Moon }

function readStored(): VisitorTheme {
  try {
    const value = window.localStorage.getItem(STATUS_THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

const CHANGE_EVENT = 'marmot:status-page-theme'

/** Choice made in this tab when storage is blocked (so the toggle still reflects it). */
let memoryChoice: VisitorTheme | null = null

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

const getSnapshot = (): VisitorTheme => memoryChoice ?? readStored()
const getServerSnapshot = (): VisitorTheme => 'system'

function apply(choice: VisitorTheme) {
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

/** Remembers the visitor's choice, applies it and notifies every toggle on the page. */
function selectTheme(next: VisitorTheme) {
  memoryChoice = null
  try {
    if (next === 'system') window.localStorage.removeItem(STATUS_THEME_STORAGE_KEY)
    else window.localStorage.setItem(STATUS_THEME_STORAGE_KEY, next)
  } catch {
    // Storage blocked: the choice still applies for this visit.
    memoryChoice = next
  }
  apply(next)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/**
 * System / light / dark switch for visitors of an `auto` status page. The choice is remembered in
 * localStorage; "system" removes it and follows `prefers-color-scheme`, live. Pages that force a
 * mode do not render this.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations('statusPages.theme.toggle')
  // Server HTML always renders "system"; the stored choice is applied before paint by the layout
  // script and picked up here after hydration.
  const choice = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  React.useEffect(() => {
    if (choice !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [choice])

  return (
    <div
      role="group"
      aria-label={t('label')}
      data-theme-toggle
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border bg-card p-0.5',
        className,
      )}
    >
      {VISITOR_THEMES.map((value) => {
        const Icon = ICONS[value]
        const active = choice === value
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            title={t(value)}
            onClick={() => selectTheme(value)}
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              active && 'bg-muted text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className="sr-only">{t(value)}</span>
          </button>
        )
      })}
    </div>
  )
}
