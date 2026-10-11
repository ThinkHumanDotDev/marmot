import {
  ArrowRightIcon,
  BellRingIcon,
  BuildingIcon,
  CalendarClockIcon,
  GlobeIcon,
  RadarIcon,
  ServerIcon,
  ZapIcon,
} from 'lucide-react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { Button } from '@/components/ui/button'
import type { SiteLinks } from '@/server/site-links'

import { LandingFooter, LandingHeader, REPO_URL } from './landing-chrome'
import { MonitorPreview } from './monitor-preview'

const GETTING_STARTED_URL = `${REPO_URL}/blob/main/docs/Getting-Started.md`

/** Feature cards; title and body come from `landing.features.<key>`. */
const FEATURES = [
  { key: 'monitorTypes', icon: RadarIcon },
  { key: 'notifications', icon: BellRingIcon },
  { key: 'statusPages', icon: GlobeIcon },
  { key: 'maintenance', icon: CalendarClockIcon },
  { key: 'organizations', icon: BuildingIcon },
  { key: 'live', icon: ZapIcon },
] as const

/**
 * Marketing page shown at `/` to signed-out visitors when `LANDING_PAGE_ENABLED` is on (the hosted
 * instance). Self-hosted installs never render it: `/` redirects to the login page instead.
 */
interface LandingPageProps {
  signupEnabled: boolean
  pricingEnabled: boolean
  links: SiteLinks
}

export async function LandingPage({ signupEnabled, pricingEnabled, links }: LandingPageProps) {
  const t = await getTranslations('landing')
  return (
    <div className="flex min-h-dvh flex-col bg-sidebar">
      <LandingHeader signupEnabled={signupEnabled} pricingEnabled={pricingEnabled} onLandingPage />

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-12 pb-20 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
          <div>
            <p className="text-sm font-medium text-primary">{t('hero.eyebrow')}</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              {t('hero.title')}
            </h1>
            <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
              {t('hero.description')}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {signupEnabled ? (
                <Button asChild size="lg">
                  <Link href="/signup">
                    {t('hero.startMonitoring')} <ArrowRightIcon />
                  </Link>
                </Button>
              ) : (
                <Button asChild size="lg">
                  <Link href="/login">
                    {t('hero.signIn')} <ArrowRightIcon />
                  </Link>
                </Button>
              )}
              <Button asChild size="lg" variant="outline">
                <a href="#self-host">{t('hero.runItYourself')}</a>
              </Button>
            </div>
          </div>
          <MonitorPreview />
        </section>

        <section id="features" className="scroll-mt-8 border-y bg-background">
          <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="text-3xl font-semibold tracking-tight text-balance">
              {t('features.title')}
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">{t('features.description')}</p>
            <ul className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ key, icon: Icon }) => (
                <li key={key}>
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-accent text-primary">
                    <Icon className="size-[18px]" aria-hidden />
                  </span>
                  <h3 className="mt-4 font-semibold">{t(`features.${key}.title`)}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {t(`features.${key}.body`)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="self-host" className="scroll-mt-8">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2">
            <div>
              <span className="inline-flex size-9 items-center justify-center rounded-lg bg-accent text-primary">
                <ServerIcon className="size-[18px]" aria-hidden />
              </span>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-balance">
                {t('selfHost.title')}
              </h2>
              <p className="mt-3 text-muted-foreground">{t('selfHost.description')}</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <a href={GETTING_STARTED_URL}>{t('selfHost.gettingStarted')}</a>
                </Button>
                <Button asChild variant="ghost">
                  <a href={REPO_URL}>{t('selfHost.viewOnGitHub')}</a>
                </Button>
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl border bg-card p-5 text-[13px] leading-relaxed text-card-foreground shadow-sm">
              <code>
                <span className="text-muted-foreground">{t('selfHost.commandComment')}</span>
                {'\n'}mkdir marmot && cd marmot
                {'\n'}curl -fsSL …/docker-compose.yml -o docker-compose.yml
                {'\n'}curl -fsSL …/.env.example -o .env
                {'\n'}docker compose up -d --wait
              </code>
            </pre>
          </div>
        </section>
      </main>

      <LandingFooter links={links} pricingEnabled={pricingEnabled} />
    </div>
  )
}
