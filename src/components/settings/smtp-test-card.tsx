'use client'

import { Send } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { instanceApi } from '@/lib/org-api'

interface SmtpTestCardProps {
  /** `SMTP_HOST` as configured, or `null` when mail only goes to the console. */
  smtpHost: string | null
  from: string
  defaultRecipient: string
}

/** Email is configured through environment variables; this card only verifies the connection. */
export function SmtpTestCard({ smtpHost, from, defaultRecipient }: SmtpTestCardProps) {
  const t = useTranslations('settings.instance.smtp')
  const [to, setTo] = React.useState(defaultRecipient)
  const [pending, setPending] = React.useState(false)
  const id = React.useId()

  async function send() {
    setPending(true)
    try {
      const result = await instanceApi.smtpTest(to.trim() || undefined)
      toast.success(t('sent', { to: result.to }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('title')}
          {smtpHost ? (
            <Badge>{t('configured')}</Badge>
          ) : (
            <Badge variant="secondary">{t('notConfigured')}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {smtpHost
            ? t.rich('configuredDescription', {
                host: () => <code className="font-mono">{smtpHost}</code>,
                from: () => <code className="font-mono">{from}</code>,
                code: (chunks) => <code>{chunks}</code>,
              })
            : t.rich('notConfiguredDescription', { code: (chunks) => <code>{chunks}</code> })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="grid gap-2 sm:max-w-sm">
          <Label htmlFor={id}>{t('recipient')}</Label>
          <Input
            id={id}
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={!smtpHost}
          />
        </div>
      </CardContent>
      <CardFooter className="justify-end border-t pt-6">
        <Button onClick={send} disabled={!smtpHost || pending}>
          <Send aria-hidden /> {pending ? t('sending') : t('send')}
        </Button>
      </CardFooter>
    </Card>
  )
}
