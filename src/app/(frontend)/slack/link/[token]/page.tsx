import { Link2, TimerOff, UserX } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { Logo } from '@/components/logo'
import { SlackLinkConfirm } from '@/components/settings/slack-link-confirm'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth'
import type { UserLike } from '@/access/permissions'
import { isOrgMember } from '@/server/slack/installations'
import { resolveLinkToken } from '@/server/slack/manage'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('slackApp.linkPage')
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
  icon: typeof Link2
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
 * `/slack/link/<token>` — confirms `/marmot link` (#129): the signed-in member links the Slack user
 * named in the token to their account. Signed-out visitors sign in first. The link itself is a
 * POST, so Slack's link previews cannot trigger it.
 */
export default async function SlackLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params
  const token = decodeURIComponent(raw)
  const t = await getTranslations('slackApp.linkPage')
  const tc = await getTranslations('common')
  const payload = await getPayload({ config })
  const target = await resolveLinkToken(payload, token)

  if (!target.ok) {
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

  const user = await getCurrentUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/slack/link/${raw}`)}`)

  const organization = target.organization.name
  if (!isOrgMember(user as UserLike, target.organization.id)) {
    return (
      <Frame home={tc('appName')}>
        <Heading
          icon={UserX}
          title={t('notMemberTitle')}
          description={t('notMemberDescription', { organization })}
        />
      </Frame>
    )
  }

  return (
    <Frame home={tc('appName')}>
      <Heading
        icon={Link2}
        title={t('title')}
        description={t('description', {
          slackUser: target.slackUserId,
          team: target.installation.teamName || target.installation.teamId,
          organization,
        })}
      />
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {t('signedInAs', { name: user.name || user.email })}
        </p>
        <SlackLinkConfirm token={token} />
      </CardContent>
    </Frame>
  )
}
