import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { SourceLink } from '@/components/legal-links'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import type { SiteLinks } from '@/server/site-links'

export const REPO_URL = 'https://github.com/ThinkHumanDotDev/marmot'
const DOCS_URL = `${REPO_URL}/blob/main/docs/Home.md`

interface LandingHeaderProps {
  signupEnabled: boolean
  /** `/pricing` is live (landing page and billing on). */
  pricingEnabled: boolean
  /** On `/` the section anchors are local; elsewhere they point back to the landing page. */
  onLandingPage?: boolean
}

/** Top bar shared by the landing page and `/pricing`. */
export async function LandingHeader({
  signupEnabled,
  pricingEnabled,
  onLandingPage = false,
}: LandingHeaderProps) {
  const t = await getTranslations('landing')
  const anchor = (id: string) => (onLandingPage ? `#${id}` : `/#${id}`)
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
      <Link href="/" aria-label={t('homeLabel')}>
        <Logo />
      </Link>
      <nav className="flex items-center gap-1 sm:gap-2">
        <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
          <a href={anchor('features')}>{t('nav.features')}</a>
        </Button>
        {pricingEnabled && (
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/pricing">{t('nav.pricing')}</Link>
          </Button>
        )}
        <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
          <a href={anchor('self-host')}>{t('nav.selfHost')}</a>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">{t('nav.signIn')}</Link>
        </Button>
        {signupEnabled && (
          <Button asChild size="sm">
            <Link href="/signup">{t('nav.getStarted')}</Link>
          </Button>
        )}
      </nav>
    </header>
  )
}

interface LandingFooterProps {
  links: SiteLinks
  pricingEnabled: boolean
}

/** Footer shared by the landing page and `/pricing`: docs, pricing, legal and source links. */
export async function LandingFooter({ links, pricingEnabled }: LandingFooterProps) {
  const [t, tc] = await Promise.all([getTranslations('landing'), getTranslations('common.legal')])
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>{t('footer.tagline')}</p>
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          <a className="hover:text-foreground" href={DOCS_URL}>
            {t('footer.docs')}
          </a>
          {pricingEnabled && (
            <Link className="hover:text-foreground" href="/pricing">
              {t('footer.pricing')}
            </Link>
          )}
          {links.termsUrl && (
            <a className="hover:text-foreground" href={links.termsUrl}>
              {tc('termsLink')}
            </a>
          )}
          {links.privacyUrl && (
            <a className="hover:text-foreground" href={links.privacyUrl}>
              {tc('privacyLink')}
            </a>
          )}
          <SourceLink className="hover:text-foreground" href={links.sourceUrl} />
          <Link className="hover:text-foreground" href="/login">
            {t('footer.signIn')}
          </Link>
        </nav>
      </div>
    </footer>
  )
}
