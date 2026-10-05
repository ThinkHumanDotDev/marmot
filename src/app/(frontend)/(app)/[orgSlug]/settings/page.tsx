import { Settings } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = { title: 'Settings' }

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization name, slug, defaults and integrations."
      />
      <section className="p-6 md:p-8">
        <EmptyState
          icon={Settings}
          title="Nothing to configure yet"
          description="Organization settings arrive with the members and billing issues."
        />
      </section>
    </>
  )
}
