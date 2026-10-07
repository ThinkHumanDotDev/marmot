'use client'

import { Loader2, Zap } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, ApiError } from '@/lib/api'
import type { OnDemandCheckResult } from '@/lib/on-demand-check'

import { CheckResultView } from './check-result'

/** Whole seconds since `startedAt` (epoch ms), ticking once a second; 0 while it is null. */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (startedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback

/** `POST /api/orgs/:orgId/monitors/:id/check`; resolves with the result or throws `ApiError`. */
export const runCheckNow = (orgId: string | number, monitorId: string | number) =>
  api.post<OnDemandCheckResult>(`/api/orgs/${orgId}/monitors/${monitorId}/check`)

/**
 * "Check now" on the monitor detail page. The worker runs the check; the new heartbeat reaches the
 * page over realtime (heartbeat bar, list), and the result opens in a dialog.
 */
export function CheckNowButton({
  orgId,
  monitor,
}: {
  orgId: string | number
  monitor: { id: string | number; name: string }
}) {
  const t = useTranslations('monitors.check')
  const router = useRouter()
  const [startedAt, setStartedAt] = React.useState<number | null>(null)
  const [result, setResult] = React.useState<OnDemandCheckResult | null>(null)
  const running = startedAt !== null
  const elapsed = useElapsedSeconds(startedAt)

  async function check() {
    setStartedAt(Date.now())
    try {
      setResult(await runCheckNow(orgId, monitor.id))
      // Refresh the server-rendered parts (status badge, last check line).
      router.refresh()
    } catch (error) {
      toast.error(errorMessage(error, t('failed')))
    } finally {
      setStartedAt(null)
    }
  }

  return (
    <>
      <Button variant="outline" onClick={check} disabled={running} data-testid="check-now">
        {running ? <Loader2 className="animate-spin" aria-hidden /> : <Zap aria-hidden />}
        {running ? t('checking', { seconds: elapsed }) : t('checkNow')}
      </Button>
      <Dialog open={result !== null} onOpenChange={(open) => !open && setResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('resultTitle', { name: monitor.name })}</DialogTitle>
            <DialogDescription>{t('resultDescription')}</DialogDescription>
          </DialogHeader>
          {result && <CheckResultView result={result} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
