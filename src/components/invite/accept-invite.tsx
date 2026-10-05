'use client'

import { Building2, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import * as React from 'react'

import type { Role } from '@/access/permissions'
import { ROLE_LABELS } from '@/components/members/role-badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { orgApi } from '@/lib/org-api'

interface AcceptInviteProps {
  code: string
  organization: { name: string; slug: string }
  role: Role
  userEmail: string
  /** Email the personal invitation was addressed to (null for shareable links). */
  invitedEmail: string | null
  alreadyMember: boolean
  /** Accept as soon as the component mounts (skipped when the invited email does not match). */
  autoAccept: boolean
}

/**
 * Signed-in half of `/invite/<code>`: POSTs the acceptance (never on a GET, so link prefetching
 * cannot join anyone) and then sends the user into the organization.
 */
export function AcceptInvite({
  code,
  organization,
  role,
  userEmail,
  invitedEmail,
  alreadyMember,
  autoAccept,
}: AcceptInviteProps) {
  const router = useRouter()
  const [state, setState] = React.useState<'idle' | 'joining' | 'done' | 'error'>(
    autoAccept ? 'joining' : 'idle',
  )
  const [error, setError] = React.useState<string | null>(null)
  const started = React.useRef(false)

  const accept = React.useCallback(async () => {
    setState('joining')
    setError(null)
    try {
      const result = await orgApi.acceptInvite(code)
      setState('done')
      router.replace(`/${result.organization.slug}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept the invitation.')
      setState('error')
    }
  }, [code, router])

  React.useEffect(() => {
    if (autoAccept && !started.current) {
      started.current = true
      void accept()
    }
  }, [autoAccept, accept])

  const joining = state === 'joining' || state === 'done'

  return (
    <>
      <CardHeader className="items-center text-center">
        <span className="mx-auto mb-2 flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {joining ? (
            <Loader2 className="size-5 animate-spin" aria-hidden />
          ) : (
            <Building2 className="size-5" aria-hidden />
          )}
        </span>
        <h1 data-slot="card-title" className="text-xl leading-none font-semibold">
          {joining ? `Joining ${organization.name}…` : `Join ${organization.name}`}
        </h1>
        <CardDescription>
          {alreadyMember
            ? `You are already a member of ${organization.name}.`
            : `You will join as ${ROLE_LABELS[role].toLowerCase()}, signed in as ${userEmail}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {invitedEmail && invitedEmail.toLowerCase() !== userEmail.toLowerCase() && (
          <p className="rounded-md border border-status-pending/40 bg-status-pending/10 p-3 text-sm">
            This invitation was sent to <strong>{invitedEmail}</strong>, but you are signed in as{' '}
            <strong>{userEmail}</strong>. You can still accept it with this account.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!joining && (
          <Button onClick={accept} className="w-full">
            {state === 'error'
              ? 'Try again'
              : alreadyMember
                ? 'Open organization'
                : 'Accept invitation'}
          </Button>
        )}
      </CardContent>
      <CardFooter className="justify-center">
        <Link
          href="/"
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Not now
        </Link>
      </CardFooter>
    </>
  )
}
