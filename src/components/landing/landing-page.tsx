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

import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'

import { MonitorPreview } from './monitor-preview'

const REPO_URL = 'https://github.com/ThinkHumanDotDev/marmot'
const DOCS_URL = `${REPO_URL}/blob/main/docs/Home.md`
const GETTING_STARTED_URL = `${REPO_URL}/blob/main/docs/Getting-Started.md`

const FEATURES = [
  {
    icon: RadarIcon,
    title: '30+ monitor types',
    body: 'HTTP and keywords, TCP, ping, DNS, Docker, databases, MQTT, gRPC, push heartbeats and more.',
  },
  {
    icon: BellRingIcon,
    title: '40+ notification providers',
    body: 'Slack, Discord, Teams, email, ntfy, webhooks and the rest of the Uptime Kuma catalogue.',
  },
  {
    icon: GlobeIcon,
    title: 'Public status pages',
    body: 'Branded pages on your own domain with incidents, RSS and per-group uptime.',
  },
  {
    icon: CalendarClockIcon,
    title: 'Maintenance windows',
    body: 'Schedule one-off or recurring windows so planned work never pages anyone.',
  },
  {
    icon: BuildingIcon,
    title: 'Organizations and roles',
    body: 'Invite your team, separate environments by organization and control who can change what.',
  },
  {
    icon: ZapIcon,
    title: 'Live by default',
    body: 'Heartbeats stream to the dashboard as they happen; no refresh button, no polling.',
  },
] as const

/**
 * Marketing page shown at `/` to signed-out visitors when `LANDING_PAGE_ENABLED` is on (the hosted
 * instance). Self-hosted installs never render it: `/` redirects to the login page instead.
 */
export function LandingPage({ signupEnabled }: { signupEnabled: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col bg-sidebar">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" aria-label="Marmot home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href="#features">Features</a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href="#self-host">Self-host</a>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          {signupEnabled && (
            <Button asChild size="sm">
              <Link href="/signup">Get started</Link>
            </Button>
          )}
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-12 pb-20 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
          <div>
            <p className="text-sm font-medium text-primary">Uptime monitoring for teams</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Know it&rsquo;s down before your users do.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
              Marmot watches your websites, APIs and servers, alerts the right people the moment
              something breaks and keeps your customers informed with public status pages.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {signupEnabled ? (
                <Button asChild size="lg">
                  <Link href="/signup">
                    Start monitoring <ArrowRightIcon />
                  </Link>
                </Button>
              ) : (
                <Button asChild size="lg">
                  <Link href="/login">
                    Sign in <ArrowRightIcon />
                  </Link>
                </Button>
              )}
              <Button asChild size="lg" variant="outline">
                <a href="#self-host">Run it yourself</a>
              </Button>
            </div>
          </div>
          <MonitorPreview />
        </section>

        <section id="features" className="scroll-mt-8 border-y bg-background">
          <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="text-3xl font-semibold tracking-tight text-balance">
              Everything Uptime Kuma does, built for a team
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              The monitors and notifications you already know, with organizations, roles and an API
              on top.
            </p>
            <ul className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <li key={title}>
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-accent text-primary">
                    <Icon className="size-[18px]" aria-hidden />
                  </span>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
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
                Open source. Self-host it any time.
              </h2>
              <p className="mt-3 text-muted-foreground">
                Marmot is AGPL-3.0 software. Run the same image on your own server with Postgres or
                MongoDB and Redis, and keep every check and every heartbeat on infrastructure you
                control.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <a href={GETTING_STARTED_URL}>Getting started guide</a>
                </Button>
                <Button asChild variant="ghost">
                  <a href={REPO_URL}>View on GitHub</a>
                </Button>
              </div>
            </div>
            <pre className="overflow-x-auto rounded-xl border bg-card p-5 text-[13px] leading-relaxed text-card-foreground shadow-sm">
              <code>
                <span className="text-muted-foreground"># one Docker image, automatic HTTPS</span>
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
          <p>Marmot · status monitoring for teams</p>
          <nav className="flex gap-5">
            <a className="hover:text-foreground" href={DOCS_URL}>
              Docs
            </a>
            <a className="hover:text-foreground" href={REPO_URL}>
              GitHub
            </a>
            <Link className="hover:text-foreground" href="/login">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
