import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { canWithOverrides } from '@/access/permissions'
import { MembersView } from '@/components/members/members-view'
import { requireUser } from '@/lib/auth'
import { effectiveRole, getOrgBySlug } from '@/lib/org'
import type { InvitationRow, InviteLink } from '@/lib/org-api'
import { inviteLinkUrl } from '@/server/invites'
import { listOrgMembers } from '@/server/members'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('members.page')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

export default async function MembersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/members`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org) notFound()

  const payload = await getPayload({ config })
  const role = effectiveRole(user, org.id)
  const canInvite = canWithOverrides(user, org, 'member:invite')

  const members = await listOrgMembers(payload, org.id, { user, overrideAccess: false })

  let invitations: InvitationRow[] = []
  let inviteLink: InviteLink | null = null
  if (canInvite) {
    const { docs } = await payload.find({
      collection: 'invitations',
      where: {
        and: [{ organization: { equals: org.id } }, { status: { equals: 'pending' } }],
      },
      depth: 0,
      limit: 100,
      sort: '-createdAt',
      user,
      overrideAccess: false,
    })
    invitations = docs.map((doc) => ({
      id: doc.id,
      email: doc.email,
      role: doc.role,
      expiresAt: doc.expiresAt ?? null,
      createdAt: doc.createdAt,
    }))
    inviteLink = {
      url: org.inviteLinkToken ? inviteLinkUrl(org.inviteLinkToken) : null,
      role: org.inviteLinkRole ?? 'member',
    }
  }

  return (
    <MembersView
      org={{ id: org.id, name: org.name, slug: org.slug }}
      currentUserId={user.id}
      role={role}
      members={members}
      invitations={invitations}
      inviteLink={inviteLink}
    />
  )
}
