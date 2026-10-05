import { Plus, Wrench } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Maintenance' }

export default function MaintenancePage() {
  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Planned windows during which monitors are paused and status pages say so."
        actions={
          <Button disabled>
            <Plus /> Schedule maintenance
          </Button>
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
        <EmptyState
          icon={Wrench}
          title="No maintenance scheduled"
          description="Schedule a window to silence alerts and inform your users ahead of time."
        />
      </section>
    </>
  )
}
