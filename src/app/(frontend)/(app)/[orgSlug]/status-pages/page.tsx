import { Globe, Plus } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Status pages' }

export default function StatusPagesPage() {
  return (
    <>
      <PageHeader
        title="Status pages"
        description="Public pages that show your customers what is up."
        actions={
          <Button disabled>
            <Plus /> New status page
          </Button>
        }
      />
      <section className="p-6 md:p-8">
        <EmptyState
          icon={Globe}
          title="No status pages yet"
          description="Publish a status page to share uptime, incidents and maintenance with the people who rely on you."
        />
      </section>
    </>
  )
}
