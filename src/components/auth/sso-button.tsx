import { KeyRound } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'

interface SsoButtonProps {
  /** `OIDC_DISPLAY_NAME`, e.g. "Okta" or "Company SSO". */
  displayName: string
  /** Same-origin path to return to after login. */
  next?: string
}

/**
 * "Continue with …" link that starts the OIDC flow. A plain anchor (not a fetch) because the
 * endpoint answers with a redirect to the identity provider.
 */
export function SsoButton({ displayName, next }: SsoButtonProps) {
  const t = useTranslations('auth.sso')
  const href = `/api/auth/oidc/login${next ? `?next=${encodeURIComponent(next)}` : ''}`
  return (
    <div className="flex flex-col gap-5">
      <Button asChild variant="outline" className="w-full">
        <a href={href} rel="nofollow">
          <KeyRound aria-hidden />
          {t('continueWith', { provider: displayName })}
        </a>
      </Button>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        {t('orPassword')}
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
    </div>
  )
}
