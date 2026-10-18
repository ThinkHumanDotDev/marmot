'use client'

import { Loader2, Send } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'

import { slaApi } from './sla-api'

/**
 * "Send test to me" and "Send now" of an SLA report page (#274): emails the report over the range
 * on screen, without touching its schedule.
 */
export function SendReport({
  orgId,
  reportId,
  from,
  to,
  recipients,
}: {
  orgId: string
  reportId: string
  from: string
  to: string
  recipients: string[]
}) {
  const t = useTranslations('sla.report.send')
  const router = useRouter()
  const [pending, setPending] = React.useState<'test' | 'all' | null>(null)
  const [confirming, setConfirming] = React.useState(false)

  const send = async (test: boolean) => {
    setPending(test ? 'test' : 'all')
    try {
      const result = await slaApi.sendReport(orgId, reportId, { test, from, to })
      toast.success(test ? t('testSent') : t('sent', { count: result.sent }))
      if (!test) router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-wrap gap-2 print:hidden" data-testid="sla-send">
      <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => send(true)}>
        {pending === 'test' ? <Loader2 className="animate-spin" /> : <Send />}
        {t('test')}
      </Button>
      <Button
        size="sm"
        disabled={pending !== null || recipients.length === 0}
        title={recipients.length === 0 ? t('noRecipients') : undefined}
        onClick={() => setConfirming(true)}
      >
        {pending === 'all' ? <Loader2 className="animate-spin" /> : <Send />}
        {t('now')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('confirmTitle')}
        description={t('confirmDescription', {
          count: recipients.length,
          recipients: recipients.join(', '),
        })}
        confirmLabel={t('confirm')}
        onConfirm={async () => {
          setConfirming(false)
          await send(false)
        }}
      />
    </div>
  )
}
