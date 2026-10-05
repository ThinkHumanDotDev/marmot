import { Activity, Plus } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Monitors' }

export default function MonitorsPage() {
  return (
    <>
      <PageHeader
        title="Monitors"
        description="Everything Marmot is watching for this organization."
        actions={
          <Button disabled>
            <Plus /> New monitor
          </Button>
        }
      />
      <section className="p-6 md:p-8">
        <EmptyState
          icon={Activity}
          title="No monitors yet"
          description="Add an HTTP, TCP, ping or DNS monitor and Marmot starts checking it right away."
        />
      </section>
    </>
  )
}
