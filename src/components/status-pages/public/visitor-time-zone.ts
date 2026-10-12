'use client'

import { useTimeZone } from 'next-intl'
import * as React from 'react'

import { STATUS_TIME_ZONE_STORAGE_KEY } from '@/lib/status-page-locales'

/**
 * Time zone of a public status page (#114). The server renders every timestamp in the page's own
 * zone (`statusPageTimeZone`), so the HTML hydrates without a mismatch. After hydration the
 * effective zone is the visitor's choice from the footer switcher, else the visitor's browser zone
 * (pages that follow the visitor, the default), else the page zone.
 */

/** What the footer switcher stores: `visitor` or `page` (nothing = the page's setting). */
export type TimeZoneChoice = 'visitor' | 'page'

const CHANGE_EVENT = 'marmot:status-page-time-zone'

/** Choice made in this tab when storage is blocked (so the switcher still reflects it). */
let memoryChoice: TimeZoneChoice | null = null

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

function readChoice(): TimeZoneChoice | null {
  if (memoryChoice) return memoryChoice
  try {
    const value = window.localStorage.getItem(STATUS_TIME_ZONE_STORAGE_KEY)
    return value === 'visitor' || value === 'page' ? value : null
  } catch {
    return null
  }
}

/** Remembers the visitor's choice (per browser, for every status page) and re-renders the page. */
export function chooseTimeZone(choice: TimeZoneChoice) {
  memoryChoice = null
  try {
    window.localStorage.setItem(STATUS_TIME_ZONE_STORAGE_KEY, choice)
  } catch {
    memoryChoice = choice
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

const browserZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/** The visitor's IANA zone, or null during server rendering and hydration. */
export function useBrowserTimeZone(): string | null {
  return React.useSyncExternalStore(subscribe, browserZone, () => null)
}

/** The visitor's switcher choice, or null (also during server rendering and hydration). */
export function useTimeZoneChoice(): TimeZoneChoice | null {
  return React.useSyncExternalStore(subscribe, readChoice, () => null)
}

/**
 * The zone timestamps are shown in: the page zone on the server and during hydration, then the
 * visitor's choice, else the browser zone when the page follows the visitor.
 */
export function useEffectiveTimeZone(pageTimeZone: string, followVisitor: boolean): string {
  const browser = useBrowserTimeZone()
  const choice = useTimeZoneChoice() ?? (followVisitor ? 'visitor' : 'page')
  return choice === 'visitor' && browser ? browser : pageTimeZone
}

/**
 * The zone to label times with (`zoned` format) once the page is hydrated, or null during server
 * rendering and hydration (the server HTML uses the page zone without a label switch).
 */
export function useVisitorTimeZone(): string | null {
  const hydrated = React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
  const zone = useTimeZone()
  return hydrated ? (zone ?? null) : null
}
