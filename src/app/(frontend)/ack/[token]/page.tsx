import { CheckCircle2, Siren, TimerOff } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { getFormatter, getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { canWithOverrides } from '@/access/permissions'
import { AckConfirm } from '@/components/incidents/ack-confirm'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { timeZoneOrDefault } from '@/i18n/formats'
import { getCurrentUser } from '@/lib/auth'
import type { Monitor, Organization } from '@/payload-types'
import { verifyAckToken } from '@/server/incidents/ack-link'
import { getIncident, relId } from '@/server/incidents/store'
import { parseId } from '@/server/monitors/http'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('incidents.ack')
  return { title: t('pageTitle'), robots: { index: false, follow: false } }
}

export const dynamic = 'force-dynamic'

function Frame({ children, home }: { children: React.ReactNode; home: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-sidebar px-4 py-10">
      <Link href="/" aria-label={home}>
        <Logo />
      </Link>
      <Card className="w-full max-w-md">{children}</Card>
    </main>
  )
}

function Heading({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Siren
  title: string
  description?: React.ReactNode
}) {
  return (
    <CardHeader className="items-center text-center">
      <span className="mx-auto mb-2 flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <h1 data-slot="card-title" className="text-xl leading-none font-semibold">
        {title}
      </h1>
      {description && <CardDescription>{description}</CardDescription>}
    </CardHeader>
  )
}

/**
 * `/ack/<token>` — landing page of the acknowledge link in DOWN notifications
 * (`src/server/incidents/ack-link.ts`). It only shows the incident and a button: the
 * acknowledgement is a POST, so link previews cannot trigger it.
 */
export default async function AcknowledgePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const t = await getTranslations('incidents.ack')
  const tc = await getTranslations('common')
  const payload = await getPayload({ config })
  const verified = verifyAckToken(decodeURIComponent(token))
  const incident = verified
    ? await getIncident(payload, parseId(payload, verified.incidentId))
    : null

  if (!incident) {
    return (
      <Frame home={tc('appName')}>
        <Heading icon={TimerOff} title={t('invalidTitle')} description={t('invalidDescription')} />
        <CardFooter className="justify-center">
          <Button asChild variant="outline">
            <Link href="/">{t('openDashboard')}</Link>
          </Button>
        </CardFooter>
      </Frame>
    )
  }

  const monitorId = relId(incident.monitor)
  const orgId = relId(incident.organization)
  const [monitor, org, user] = await Promise.all([
    monitorId === null
      ? null
      : (payload
          .findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true })
          .catch(() => null) as Promise<Monitor | null>),
    orgId === null
      ? null
      : (payload
          .findByID({ collection: 'organizations', id: orgId, depth: 0, overrideAccess: true })
          .catch(() => null) as Promise<Organization | null>),
    getCurrentUser(),
  ])
  const format = await getFormatter()
  const timeZone = timeZoneOrDefault(org?.settings?.timezone)
  const name = monitor?.name ?? ''
  const since = format.dateTime(new Date(incident.startedAt), 'zoned', { timeZone })
  const member = Boolean(user && org && canWithOverrides(user, org, 'monitor-incident:acknowledge'))

  if (incident.status !== 'open') {
    return (
      <Frame home={tc('appName')}>
        <Heading
          icon={CheckCircle2}
          title={incident.status === 'resolved' ? t('resolved') : t('alreadyAcknowledged')}
          description={t('description', { monitor: name, time: since })}
        />
        <CardFooter className="justify-center">
          <Button asChild variant="outline">
            <Link href={org ? `/${org.slug}/incidents/${incident.id}` : '/'}>
              {t('openDashboard')}
            </Link>
          </Button>
        </CardFooter>
      </Frame>
    )
  }

  return (
    <Frame home={tc('appName')}>
      <Heading
        icon={Siren}
        title={t('title')}
        description={t('description', { monitor: name, time: since })}
      />
      <CardContent className="flex flex-col gap-3 text-sm">
        {incident.cause && (
          <p className="break-words text-muted-foreground">
            {t('cause', { cause: incident.cause })}
          </p>
        )}
        <p className="text-muted-foreground">
          {member && user ? t('signedIn', { name: user.name || user.email }) : t('anonymous')}
        </p>
        <AckConfirm token={decodeURIComponent(token)} />
      </CardContent>
    </Frame>
  )
}
