import { ArrowLeft, Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = { title: 'New monitor' }

interface NewMonitorPageProps {
  params: Promise<{ orgSlug: string }>
}

/** Placeholder until the monitor form issue lands; keeps the dashboard's CTA routable. */
export default async function NewMonitorPage({ params }: NewMonitorPageProps) {
  const { orgSlug } = await params
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/monitors`} className="inline-flex items-center gap-1">
            <ArrowLeft className="size-3" aria-hidden /> Monitors
          </Link>
        }
        title="New monitor"
        description="Pick a type, point it at a target and choose how often to check."
      />
      <section className="p-6 md:p-8">
        <EmptyState
          icon={Plus}
          title="The monitor form is on its way"
          description="Until it ships, create monitors from the admin panel; they appear on the dashboard live."
          action={
            <Button asChild variant="outline">
              <Link href={`/${orgSlug}/monitors`}>Back to monitors</Link>
            </Button>
          }
        />
      </section>
    </>
  )
}
