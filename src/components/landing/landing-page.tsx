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

import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'

import { MonitorPreview } from './monitor-preview'

const REPO_URL = 'https://github.com/ThinkHumanDotDev/marmot'
const DOCS_URL = `${REPO_URL}/blob/main/docs/Home.md`
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
export async function LandingPage({ signupEnabled }: { signupEnabled: boolean }) {
  const t = await getTranslations('landing')
  return (
    <div className="flex min-h-dvh flex-col bg-sidebar">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" aria-label={t('homeLabel')}>
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href="#features">{t('nav.features')}</a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href="#self-host">{t('nav.selfHost')}</a>
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

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>{t('footer.tagline')}</p>
          <nav className="flex gap-5">
            <a className="hover:text-foreground" href={DOCS_URL}>
              {t('footer.docs')}
            </a>
            <a className="hover:text-foreground" href={REPO_URL}>
              {t('footer.github')}
            </a>
            <Link className="hover:text-foreground" href="/login">
              {t('footer.signIn')}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
