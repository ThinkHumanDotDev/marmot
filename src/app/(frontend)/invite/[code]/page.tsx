import { Building2, Clock, LinkIcon, MailX } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { getPayload } from 'payload'

import config from '@payload-config'
import { getUserRole } from '@/access/permissions'
import { AcceptInvite } from '@/components/invite/accept-invite'
import { Logo } from '@/components/logo'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/components/members/role-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { env } from '@/env'
import { getCurrentUser } from '@/lib/auth'
import { resolveInviteCode } from '@/server/invites'

export const metadata: Metadata = { title: 'Invitation' }
export const dynamic = 'force-dynamic'

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-sidebar px-4 py-10">
      <Link href="/" aria-label="Marmot">
        <Logo />
      </Link>
      <Card className="w-full max-w-md">{children}</Card>
    </main>
  )
}

function Problem({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof MailX
  title: string
  description: string
}) {
  return (
    <>
      <CardHeader className="items-center text-center">
        <span className="mx-auto mb-2 flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
        <h1 data-slot="card-title" className="text-xl leading-none font-semibold">
          {title}
        </h1>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter className="justify-center">
        <Button asChild variant="outline">
          <Link href="/">Go to Marmot</Link>
        </Button>
      </CardFooter>
    </>
  )
}

/**
 * `/invite/<code>` — the landing page of invitation emails and shareable invite links.
 * Signed out: explains the invite and routes to sign in / sign up with `?next=` back here.
 * Signed in: joins through `POST /api/invite/:code/accept` and redirects to the organization.
 */
export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const payload = await getPayload({ config })
  const invite = await resolveInviteCode(payload, code)

  if (!invite) {
    return (
      <Frame>
        <Problem
          icon={MailX}
          title="This invite link is not valid"
          description="It may have been revoked or mistyped. Ask the person who invited you for a new link."
        />
      </Frame>
    )
  }

  if (invite.kind === 'invitation' && invite.status !== 'pending') {
    const copy = {
      accepted: {
        title: 'Invitation already used',
        description: 'This invitation has already been accepted. Sign in to continue.',
      },
      revoked: {
        title: 'Invitation revoked',
        description: 'This invitation was withdrawn. Ask an admin to invite you again.',
      },
      expired: {
        title: 'Invitation expired',
        description: 'Invitations are valid for seven days. Ask an admin to resend it.',
      },
    }[invite.status]
    return (
      <Frame>
        <Problem icon={Clock} {...copy} />
      </Frame>
    )
  }

  const user = await getCurrentUser()
  const next = `/invite/${encodeURIComponent(code)}`
  const org = invite.organization

  if (!user) {
    return (
      <Frame>
        <CardHeader className="items-center text-center">
          <span className="mx-auto mb-2 flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Building2 className="size-5" aria-hidden />
          </span>
          <h1 data-slot="card-title" className="text-xl leading-none font-semibold">
            Join {org.name}
          </h1>
          <CardDescription>
            {invite.kind === 'invitation'
              ? `You have been invited to join ${org.name} as ${ROLE_LABELS[invite.role].toLowerCase()}.`
              : `You have been given a link to join ${org.name} as ${ROLE_LABELS[invite.role].toLowerCase()}.`}{' '}
            {ROLE_DESCRIPTIONS[invite.role]}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button asChild className="w-full">
            <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in to accept</Link>
          </Button>
          {!env.DISABLE_SIGNUP && (
            <Button asChild variant="outline" className="w-full">
              <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link>
            </Button>
          )}
        </CardContent>
        <CardFooter className="justify-center text-xs text-muted-foreground">
          <LinkIcon className="mr-1 size-3" aria-hidden /> Sent through Marmot
        </CardFooter>
      </Frame>
    )
  }

  const alreadyMember = getUserRole(user, org.id)
  const emailMismatch =
    invite.kind === 'invitation' && invite.email.toLowerCase() !== user.email.toLowerCase()

  return (
    <Frame>
      <AcceptInvite
        code={code}
        organization={{ name: org.name, slug: org.slug }}
        role={invite.role}
        userEmail={user.email}
        invitedEmail={invite.kind === 'invitation' ? invite.email : null}
        alreadyMember={Boolean(alreadyMember)}
        autoAccept={!emailMismatch}
      />
    </Frame>
  )
}
