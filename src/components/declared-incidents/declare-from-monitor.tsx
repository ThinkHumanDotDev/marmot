'use client'

import { Siren } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'

import { declaredApi, errorMessage } from './api'

/**
 * "Declare incident" on a monitor incident (#285): one click declares a major incident titled after
 * the monitor, linked to the outage (which sets its start), and opens it to fill in the rest. Once
 * declared, the button links to that incident instead.
 */
export function DeclareFromMonitorIncident({
  orgId,
  orgSlug,
  monitorIncidentId,
  monitorName,
  declaredId,
}: {
  orgId: string | number
  orgSlug: string
  monitorIncidentId: string
  monitorName: string
  /** The declared incident already linked to this outage, if any. */
  declaredId: string | null
}) {
  const t = useTranslations('declaredIncidents.fromMonitor')
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  if (declaredId) {
    return (
      <Button asChild variant="outline" data-testid="view-declared-incident">
        <Link href={`/${orgSlug}/declared-incidents/${declaredId}`}>
          <Siren /> {t('view')}
        </Link>
      </Button>
    )
  }

  async function declare() {
    setPending(true)
    try {
      const incident = await declaredApi.declare(orgId, {
        title: t('title', { monitor: monitorName }).slice(0, 200),
        severity: 'major',
        monitorIncident: monitorIncidentId,
      })
      toast.success(t('declared'))
      router.push(`/${orgSlug}/declared-incidents/${incident.id}`)
    } catch (error) {
      toast.error(errorMessage(error, t('failed')))
      setPending(false)
    }
  }

  return (
    <Button onClick={() => void declare()} disabled={pending} data-testid="declare-from-monitor">
      <Siren /> {t('declare')}
    </Button>
  )
}
