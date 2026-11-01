'use client'

import { useConsent, useSetActiveUI } from '@c15t/react'
import { usePathname } from 'next/navigation'
import * as React from 'react'

import { setAnalyticsConsent, trackPageview } from '@/lib/analytics'

import { PRIVACY_SETTINGS_EVENT } from './privacy-settings'

/**
 * Glue between c15t's consent store and the PostHog facade: mirrors the `measurement` category
 * into `setAnalyticsConsent`, records a pageview per route while consent holds, and opens the
 * preferences dialog when the user menu asks for it. `useConsent` stays false until the policy
 * resolves and a stored or new choice grants the category.
 */
export function ConsentBridge() {
  const granted = useConsent('measurement')
  const setActiveUI = useSetActiveUI()
  const pathname = usePathname()

  React.useEffect(() => {
    setAnalyticsConsent(granted)
  }, [granted])

  React.useEffect(() => {
    if (granted) trackPageview(pathname)
  }, [granted, pathname])

  React.useEffect(() => {
    const open = () => setActiveUI('dialog')
    window.addEventListener(PRIVACY_SETTINGS_EVENT, open)
    return () => window.removeEventListener(PRIVACY_SETTINGS_EVENT, open)
  }, [setActiveUI])

  return null
}
