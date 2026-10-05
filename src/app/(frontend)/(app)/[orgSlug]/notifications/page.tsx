import { Bell, Plus } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'Notifications' }

export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Where Marmot tells you when something changes."
        actions={
          <Button disabled>
            <Plus /> Add channel
          </Button>
        }
      />
      <section className="p-6 md:p-8">
        <EmptyState
          icon={Bell}
          title="No notification channels"
          description="Connect email, Slack, Discord, webhooks and more; then attach channels to monitors."
        />
      </section>
    </>
  )
}
