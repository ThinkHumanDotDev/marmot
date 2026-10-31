'use client'

import {
  ConsentBanner,
  ConsentDialog,
  ConsentProvider,
  type ConsentProviderOptions,
  ConsentTheme,
  local,
  type PolicyRule,
} from '@c15t/react'
import { useLocale, useTranslations } from 'next-intl'
import * as React from 'react'

import { TELEMETRY_DOCS_URL } from '@/lib/analytics-config'

import { ConsentBridge } from './consent-bridge'
import { consentTheme } from './consent-theme'

/**
 * Opt-in everywhere: Marmot sees no visitor location, so one rule matches every visitor, offers
 * accept, reject and customize, and keeps `measurement` denied until it is accepted.
 */
const OPT_IN_EVERYWHERE: PolicyRule = {
  id: 'marmot-opt-in-everywhere',
  match: { isDefault: true, fallback: true },
  model: 'opt-in',
  prompt: 'choice',
  categories: ['measurement'],
  scopeMode: 'strict',
  actions: ['accept', 'reject', 'customize'],
}

/**
 * c15t in local mode: consent lives in the visitor's browser (cookie + localStorage), no
 * consent backend is contacted. Only the `measurement` category is offered because analytics is
 * the only optional processing Marmot does. The banner shows once per browser until a choice is
 * made. The texts come from the `consent` messages of the active locale.
 */
function useConsentOptions(): ConsentProviderOptions {
  const t = useTranslations('consent')
  const locale = useLocale()
  return React.useMemo(
    () => ({
      mode: local({ policyRules: [OPT_IN_EVERYWHERE], acknowledgeNoRecords: true }),
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
    <ConsentProvider options={options}>
      <ConsentTheme theme={consentTheme} />
      <ConsentBanner />
      <ConsentDialog hideBranding />
      <ConsentBridge />
    </ConsentProvider>
  )
}
