'use client'

import {
  ConsentBanner,
  ConsentDialog,
  ConsentManagerProvider,
  type ConsentManagerOptions,
} from '@c15t/nextjs'
import { useLocale, useTranslations } from 'next-intl'
import * as React from 'react'

import '@c15t/nextjs/styles.css'

import { TELEMETRY_DOCS_URL } from '@/lib/analytics-config'

import { ConsentBridge } from './consent-bridge'
import { consentTheme } from './consent-theme'

/**
 * c15t in offline mode: consent lives in the visitor's browser (cookie + localStorage), no
 * consent backend is contacted. Only the `measurement` category is offered because analytics is
 * the only optional processing Marmot does. Jurisdiction defaults to opt-in everywhere, so the
 * banner shows once per browser until a choice is made. The texts come from the `consent`
 * messages of the active locale.
 */
function useConsentOptions(): ConsentManagerOptions {
  const t = useTranslations('consent')
  const locale = useLocale()
  return React.useMemo(
    () => ({
      mode: 'offline',
      consentCategories: ['necessary', 'measurement'],
      theme: consentTheme,
      legalLinks: {
        privacyPolicy: {
          href: TELEMETRY_DOCS_URL,
          target: '_blank',
          rel: 'noopener noreferrer',
          label: t('privacyPolicy'),
        },
      },
      i18n: {
        locale,
        detectBrowserLanguage: false,
        messages: {
          [locale]: {
            cookieBanner: {
              title: t('banner.title'),
              description: t('banner.description'),
            },
            consentManagerDialog: {
              title: t('dialog.title'),
              description: t('dialog.description'),
            },
            consentTypes: {
              necessary: {
                title: t('types.necessary.title'),
                description: t('types.necessary.description'),
              },
              measurement: {
                title: t('types.measurement.title'),
                description: t('types.measurement.description'),
              },
            },
            common: {
              acceptAll: t('acceptAll'),
              rejectAll: t('rejectAll'),
              customize: t('customize'),
            },
          },
        },
      },
    }),
    [t, locale],
  )
}

/** Mounted by the frontend root layout only when analytics are enabled. */
export function ConsentManager() {
  const options = useConsentOptions()
  return (
    <ConsentManagerProvider options={options}>
      <ConsentBanner />
      <ConsentDialog hideBranding />
      <ConsentBridge />
    </ConsentManagerProvider>
  )
}
