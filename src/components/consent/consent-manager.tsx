'use client'

import {
  ConsentBanner,
  ConsentDialog,
  ConsentManagerProvider,
  type ConsentManagerOptions,
} from '@c15t/nextjs'
import * as React from 'react'

import '@c15t/nextjs/styles.css'

import { TELEMETRY_DOCS_URL } from '@/lib/analytics-config'

import { ConsentBridge } from './consent-bridge'
import { consentTheme } from './consent-theme'

/**
 * c15t in offline mode: consent lives in the visitor's browser (cookie + localStorage), no
 * consent backend is contacted. Only the `measurement` category is offered because analytics is
 * the only optional processing Marmot does. Jurisdiction defaults to opt-in everywhere, so the
 * banner shows once per browser until a choice is made.
 */
const options: ConsentManagerOptions = {
  mode: 'offline',
  consentCategories: ['necessary', 'measurement'],
  theme: consentTheme,
  legalLinks: {
    privacyPolicy: {
      href: TELEMETRY_DOCS_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      label: 'What is collected',
    },
  },
  i18n: {
    locale: 'en',
    detectBrowserLanguage: false,
    messages: {
      en: {
        cookieBanner: {
          title: 'Help improve Marmot',
          description:
            'The operator of this instance has enabled anonymous usage analytics. With your permission Marmot records which features are used, never emails, names, monitor targets or page addresses. You can change your choice at any time from the account menu.',
        },
        consentManagerDialog: {
          title: 'Privacy settings',
          description:
            'Choose whether this browser may send anonymous usage analytics. Nothing is sent until you allow it.',
        },
        consentTypes: {
          necessary: {
            title: 'Essential',
            description:
              'Signing in, remembering your theme and sidebar, and storing this consent choice. Always on.',
          },
          measurement: {
            title: 'Usage analytics',
            description:
              'Anonymous product events (for example "monitor created") and route-level pageviews, tied to a hashed account id. Sent through this instance to PostHog.',
          },
        },
        common: {
          acceptAll: 'Allow analytics',
          rejectAll: 'Decline',
          customize: 'Preferences',
        },
      },
    },
  },
}

/** Mounted by the frontend root layout only when analytics are enabled. */
export function ConsentManager() {
  return (
    <ConsentManagerProvider options={options}>
      <ConsentBanner />
      <ConsentDialog hideBranding />
      <ConsentBridge />
    </ConsentManagerProvider>
  )
}
