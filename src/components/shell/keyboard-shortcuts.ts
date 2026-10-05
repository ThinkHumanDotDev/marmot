'use client'

import { useRouter } from 'next/navigation'
import * as React from 'react'

import { useUiStore } from '@/stores/ui-store'

import { orgNavigation, orgPath } from './navigation'

/** How long after "g" the second key of a sequence is accepted. */
export const SEQUENCE_TIMEOUT_MS = 1200

/** True when the key press belongs to a text field (or other editable control) and must not be hijacked. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (
    target.closest('[role="combobox"], [role="listbox"], [role="menu"], [role="textbox"]') !== null
  )
}

/**
 * kan.bn-style "g then key" navigation: `g m` monitors, `g s` status pages, etc. (see
 * `orgNavigation`). Ignored while typing, while a modal is open and when modifiers are held, so it
 * never fights with form input, the command palette or browser shortcuts.
 */
export function useGoShortcuts(orgSlug: string) {
  const router = useRouter()

  React.useEffect(() => {
    let awaiting = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const reset = () => {
      awaiting = false
      if (timer) clearTimeout(timer)
      timer = undefined
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return
      if (useUiStore.getState().commandPaletteOpen) return
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')) return

      const key = event.key.toLowerCase()
      if (awaiting) {
        reset()
        const item = orgNavigation.find((nav) => nav.shortcut === key)
        if (item) {
          event.preventDefault()
          router.push(orgPath(orgSlug, item.segment))
        }
        return
      }
      if (key === 'g' && !event.shiftKey) {
        awaiting = true
        timer = setTimeout(reset, SEQUENCE_TIMEOUT_MS)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      reset()
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [orgSlug, router])
}
