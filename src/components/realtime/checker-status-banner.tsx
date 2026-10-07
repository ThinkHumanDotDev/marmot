'use client'

import { WifiOffIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { getSocket } from '@/lib/socket'
import { RealtimeEvents, type RealtimePayloads } from '@/server/realtime/events'

export type CheckerStatus = RealtimePayloads['checkerStatus']

/**
 * "Checker offline" banner (#148): shown while the worker's self connectivity check reports the
 * worker offline, i.e. checks of external targets are held instead of going DOWN. The initial
 * status is rendered by the server; `checkerStatus` socket events (broadcast to every socket by the
 * worker) keep it current. The socket itself is connected by `SocketProvider`.
 */
export function CheckerStatusBanner({ initial }: { initial: CheckerStatus }) {
  const t = useTranslations('shell.checkerOffline')
  const format = useFormatter()
  const [status, setStatus] = React.useState<CheckerStatus>(initial)

  React.useEffect(() => {
    const socket = getSocket()
    const onStatus = (payload: CheckerStatus) => setStatus(payload)
    socket.on(RealtimeEvents.checkerStatus, onStatus)
    return () => {
      socket.off(RealtimeEvents.checkerStatus, onStatus)
    }
  }, [])

  if (status.status !== 'offline') return null

  return (
    <div
      role="status"
      data-testid="checker-offline-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-status-pending/40 bg-status-pending/10 px-4 py-3 text-sm"
    >
      <WifiOffIcon className="mt-0.5 size-4 shrink-0 text-status-pending-text" aria-hidden />
      <div className="space-y-0.5">
        <p className="font-medium">{t('title')}</p>
        <p className="text-muted-foreground">
          {status.since
            ? t('since', { time: format.dateTime(new Date(status.since), 'short') })
            : t('now')}{' '}
          {t('description')}
        </p>
      </div>
    </div>
  )
}
