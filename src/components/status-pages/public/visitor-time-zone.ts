'use client'

import * as React from 'react'

const subscribe = () => () => {}
const browserZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/**
 * The visitor's IANA time zone, or null during server rendering and hydration (so the server HTML,
 * rendered in the organization's zone, hydrates without a mismatch and then switches).
 */
export function useVisitorTimeZone(): string | null {
  return React.useSyncExternalStore(subscribe, browserZone, () => null)
}
