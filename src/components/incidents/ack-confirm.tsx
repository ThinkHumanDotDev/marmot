'use client'

import { CheckCircle2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'

import { incidentsApi } from './api'

/** The one button of the acknowledge-link page. */
export function AckConfirm({ token }: { token: string }) {
  const t = useTranslations('incidents.ack')
  const [state, setState] = React.useState<'idle' | 'working' | 'done'>('idle')
  const [error, setError] = React.useState<string | null>(null)

  async function confirm() {
    setState('working')
    setError(null)
    try {
      await incidentsApi.acknowledgeByLink(token)
      setState('done')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('failed'))
      setState('idle')
    }
  }

  if (state === 'done') {
    return (
      <p
        role="status"
        className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
        data-testid="ack-done"
      >
        <CheckCircle2 className="size-4 text-status-up" aria-hidden /> {t('done')}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={confirm} disabled={state === 'working'} data-testid="ack-confirm">
        {state === 'working' ? t('working') : t('confirm')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
