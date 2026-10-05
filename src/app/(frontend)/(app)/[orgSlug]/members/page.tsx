import { UserPlus, Users } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Members' }

export default function MembersPage() {
  return (
    <>
      <PageHeader
        title="Members"
        description="People in this organization and what they can do."
        actions={
          <Button disabled>
            <UserPlus /> Invite member
          </Button>
        }
      />
      <section className="p-6 md:p-8">
        <EmptyState
          icon={Users}
          title="Just you for now"
          description="Invite teammates as owners, admins, members or viewers."
        />
      </section>
    </>
  )
}
