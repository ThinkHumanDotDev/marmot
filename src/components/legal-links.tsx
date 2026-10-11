import { useTranslations } from 'next-intl'
import * as React from 'react'

import { cn } from '@/lib/utils'

const linkClass = 'underline underline-offset-4 hover:text-foreground'

/**
 * "Source" link required for modified builds by AGPL-3.0 §13 (#178). The target comes from
 * `sourceUrl()` in `src/server/site-links.ts`, passed down because client shells cannot read env.
 */
export function SourceLink({ href, className }: { href: string; className?: string }) {
  const t = useTranslations('common')
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {t('source')}
    </a>
  )
}

interface LegalNoticeProps {
  termsUrl: string | null
  privacyUrl: string | null
  /** Which sentence to use: sign-up consent or the Billing tab's subscription note. */
  context: 'signup' | 'billing'
  className?: string
}

/**
 * "By signing up you agree to…" with the operator's `TERMS_URL` / `PRIVACY_URL`. Renders nothing
 * when neither is set, so self-hosted installs never show it.
 */
export function LegalNotice({ termsUrl, privacyUrl, context, className }: LegalNoticeProps) {
  const t = useTranslations(context === 'signup' ? 'common.legal' : 'settings.billing.legal')
  if (!termsUrl && !privacyUrl) return null
  const key = termsUrl && privacyUrl ? 'both' : termsUrl ? 'terms' : 'privacy'
  const external = (href: string | null) =>
    function ExternalLink(chunks: React.ReactNode) {
      return (
        <a href={href ?? undefined} target="_blank" rel="noopener noreferrer" className={linkClass}>
          {chunks}
        </a>
      )
    }
  return (
    <p className={cn('text-xs text-muted-foreground', className)} data-testid="legal-notice">
      {t.rich(key, { terms: external(termsUrl), privacy: external(privacyUrl) })}
    </p>
  )
}
