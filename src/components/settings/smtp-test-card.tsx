'use client'

import { Send } from 'lucide-react'
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
  const [to, setTo] = React.useState(defaultRecipient)
  const [pending, setPending] = React.useState(false)
  const id = React.useId()

  async function send() {
    setPending(true)
    try {
      const result = await instanceApi.smtpTest(to.trim() || undefined)
      toast.success(`Test email sent to ${result.to}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send the test email.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Email (SMTP)
          {smtpHost ? <Badge>Configured</Badge> : <Badge variant="secondary">Not configured</Badge>}
        </CardTitle>
        <CardDescription>
          {smtpHost ? (
            <>
              Sending through <code className="font-mono">{smtpHost}</code> as{' '}
              <code className="font-mono">{from}</code>. Set via <code>SMTP_*</code> and{' '}
              <code>EMAIL_FROM</code>.
            </>
          ) : (
            <>
              Set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>,{' '}
              <code>SMTP_PASSWORD</code> and <code>EMAIL_FROM</code> and restart to send
              invitations, password resets and email notifications. Until then mail is logged to the
              console.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="grid gap-2 sm:max-w-sm">
          <Label htmlFor={id}>Send a test email to</Label>
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
          <Send aria-hidden /> {pending ? 'Sending…' : 'Send test email'}
        </Button>
      </CardFooter>
    </Card>
  )
}
