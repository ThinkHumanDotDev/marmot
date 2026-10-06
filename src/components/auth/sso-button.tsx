import { KeyRound } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'

export interface SsoButtonProvider {
  id: string
  /** Button label: "Continue with …". */
  name: string
  /** Path that starts the provider's flow (`/api/auth/sso/<id>/login`). */
  loginPath: string
}

interface SsoButtonsProps {
  providers: SsoButtonProvider[]
  /** Same-origin path to return to after login. */
  next?: string
}

/**
 * One "Continue with …" link per enabled single sign-on provider. Plain anchors (not fetches)
 * because the endpoints answer with a redirect to the identity provider.
 */
export function SsoButtons({ providers, next }: SsoButtonsProps) {
  const t = useTranslations('auth.sso')
  if (providers.length === 0) return null
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {providers.map((provider) => (
          <Button key={provider.id} asChild variant="outline" className="w-full">
            <a
              href={`${provider.loginPath}${next ? `?next=${encodeURIComponent(next)}` : ''}`}
              rel="nofollow"
            >
              <KeyRound aria-hidden />
              {t('continueWith', { provider: provider.name })}
            </a>
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        {t('orPassword')}
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
    </div>
  )
}
