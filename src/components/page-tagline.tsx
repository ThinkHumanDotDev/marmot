import { getTranslations } from 'next-intl/server'

import { SourceLink } from '@/components/legal-links'
import { cn } from '@/lib/utils'
import { sourceUrl } from '@/server/site-links'

/** The tagline and "Source" link under the sign-in, sign-up, setup and onboarding cards. */
export async function PageTagline({ className }: { className?: string }) {
  const t = await getTranslations('common')
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {t('tagline')}
      {' · '}
      <SourceLink
        href={sourceUrl()}
        className="underline-offset-4 hover:text-foreground hover:underline"
      />
    </p>
  )
}
