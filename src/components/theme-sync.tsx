'use client'

import { useTheme } from 'next-themes'
import * as React from 'react'

import type { ThemePreference } from '@/lib/org-api'

/**
 * Applies the theme saved on the user (`users.theme`) through next-themes once after sign-in, so
 * the preference follows the account across devices. Later changes come from the user menu or the
 * appearance card, which both save and apply.
 */
export function ThemeSync({ theme }: { theme: ThemePreference | null | undefined }) {
  const { theme: current, setTheme } = useTheme()
  const applied = React.useRef(false)
  React.useEffect(() => {
    if (applied.current || !theme) return
    applied.current = true
    if (current !== theme) setTheme(theme)
  }, [theme, current, setTheme])
  return null
}
