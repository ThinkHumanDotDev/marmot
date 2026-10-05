'use client'

import { useConsentManager } from '@c15t/nextjs'
import { usePathname } from 'next/navigation'
import * as React from 'react'

import { setAnalyticsConsent, trackPageview } from '@/lib/analytics'

import { PRIVACY_SETTINGS_EVENT } from './privacy-settings'

/**
 * Glue between c15t's consent store and the PostHog facade: mirrors the `measurement` category
 * into `setAnalyticsConsent`, records a pageview per route while consent holds, and opens the
 * preferences dialog when the user menu asks for it.
 */
export function ConsentBridge() {
  const { consents, isLoadingConsentInfo, setActiveUI } = useConsentManager()
  const pathname = usePathname()
  const granted = !isLoadingConsentInfo && consents.measurement === true

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
