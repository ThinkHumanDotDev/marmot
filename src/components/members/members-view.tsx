'use client'

import { UserPlus } from 'lucide-react'
import * as React from 'react'

import { can, type Role } from '@/access/permissions'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import type { InvitationRow, InviteLink, MemberRow } from '@/lib/org-api'

import { InviteDialog } from './invite-dialog'
import { InviteLinkCard } from './invite-link-card'
import { MembersTable } from './members-table'
import { PendingInvitations } from './pending-invitations'

export interface MembersViewProps {
  org: { id: string | number; name: string; slug: string }
  currentUserId: string | number
  /** The viewer's effective role (superadmins are owners). */
  role: Role | null
  members: MemberRow[]
  invitations: InvitationRow[]
  /** `null` when the viewer may not invite. */
  inviteLink: InviteLink | null
}

/** Members page body: table of members, pending invitations and the shareable invite link. */
export function MembersView({
  org,
  currentUserId,
  role,
  members,
  invitations,
  inviteLink,
}: MembersViewProps) {
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const viewer = { id: currentUserId, organizations: role ? [{ organization: org.id, role }] : [] }
  const canInvite = can(viewer, org.id, 'member:invite')

  return (
    <>
      <PageHeader
        title="Members"
        description={`People in ${org.name} and what they can do.`}
        actions={
          canInvite ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite member
            </Button>
          ) : undefined
        }
      />
      <section className="flex flex-col gap-8 p-6 md:p-8">
        <MembersTable
          orgId={org.id}
          orgSlug={org.slug}
          currentUserId={currentUserId}
          viewerRole={role}
          members={members}
        />
        {canInvite && (
          <>
            <PendingInvitations
              orgId={org.id}
              invitations={invitations}
              onInvite={() => setInviteOpen(true)}
            />
            {inviteLink && <InviteLinkCard orgId={org.id} link={inviteLink} viewerRole={role} />}
          </>
        )}
      </section>
      {canInvite && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          orgId={org.id}
          orgName={org.name}
          viewerRole={role}
        />
      )}
    </>
  )
}
