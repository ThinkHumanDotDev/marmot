'use client'

import { Copy, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { accountApi, type TwoFactorSetup, type TwoFactorStatus } from '@/lib/org-api'

interface TwoFactorCardProps {
  status: TwoFactorStatus
  /** SSO accounts have no Marmot password; the password prompts are skipped for them. */
  hasPassword: boolean
}

type Flow = 'idle' | 'setup' | 'backup-codes' | 'regenerate' | 'disable'

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

/**
 * Account security: enable TOTP (QR code → confirm code → backup codes shown once), regenerate
 * backup codes and disable with password + code. All calls go to `/api/account/2fa/*`.
 */
export function TwoFactorCard({ status, hasPassword }: TwoFactorCardProps) {
  const router = useRouter()
  const [flow, setFlow] = React.useState<Flow>('idle')
  const [setup, setSetup] = React.useState<TwoFactorSetup | null>(null)
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const [password, setPassword] = React.useState('')
  const [code, setCode] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const ids = { password: React.useId(), code: React.useId() }

  function reset() {
    setFlow('idle')
    setSetup(null)
    setCodes(null)
    setPassword('')
    setCode('')
    setError(null)
    setPending(false)
  }

  async function run(action: () => Promise<void>, fallback: string) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(message(err, fallback))
    } finally {
      setPending(false)
    }
  }

  const beginSetup = () =>
    run(async () => {
      const result = await accountApi.twoFactor.setup(password)
      setSetup(result)
      setPassword('')
    }, 'Could not start the setup.')

  const confirmSetup = () =>
    run(async () => {
      const { backupCodes } = await accountApi.twoFactor.verify(code)
      setCodes(backupCodes)
      setFlow('backup-codes')
      setCode('')
      toast.success('Two-factor authentication enabled')
      router.refresh()
    }, 'That code is not valid.')

  const regenerate = () =>
    run(async () => {
      const { backupCodes } = await accountApi.twoFactor.regenerateBackupCodes(code)
      setCodes(backupCodes)
      setFlow('backup-codes')
      setCode('')
      toast.success('New backup codes generated')
      router.refresh()
    }, 'Could not regenerate the backup codes.')

  const disable = () =>
    run(async () => {
      await accountApi.twoFactor.disable({ password, code })
      toast.success('Two-factor authentication disabled')
      reset()
      router.refresh()
    }, 'Could not disable two-factor authentication.')

  async function copyCodes() {
    if (!codes) return
    try {
      await navigator.clipboard.writeText(codes.join('\n'))
      toast.success('Backup codes copied')
    } catch {
      toast.error('Could not copy. Select the codes and copy them manually.')
    }
  }

  const passwordField = hasPassword && (
    <div className="grid gap-2">
      <Label htmlFor={ids.password}>Password</Label>
      <Input
        id={ids.password}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </div>
  )

  const codeField = (label = 'Authentication code') => (
    <div className="grid gap-2">
      <Label htmlFor={ids.code}>{label}</Label>
      <Input
        id={ids.code}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
      />
    </div>
  )

  const errorLine = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          {status.enabled ? (
            <Badge className="gap-1">
              <ShieldCheck aria-hidden /> On
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <ShieldOff aria-hidden /> Off
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {status.enabled
            ? `Signing in requires a code from your authenticator app. ${status.backupCodesRemaining} backup ${status.backupCodesRemaining === 1 ? 'code' : 'codes'} left.`
            : 'Add a second step to your sign-in with an authenticator app (TOTP).'}
        </CardDescription>
      </CardHeader>
      {status.enabled && status.verifiedAt && (
        <CardContent className="pt-6 text-sm text-muted-foreground">
          Enabled on {new Date(status.verifiedAt).toLocaleDateString()}.
          {!hasPassword &&
            ' Your account signs in with single sign-on; the code is asked after the provider login.'}
        </CardContent>
      )}
      <CardFooter className="flex flex-wrap justify-end gap-2 border-t pt-6">
        {status.enabled ? (
          <>
            <Button variant="outline" onClick={() => setFlow('regenerate')}>
              <KeyRound aria-hidden /> New backup codes
            </Button>
            <Button variant="destructive" onClick={() => setFlow('disable')}>
              Disable
            </Button>
          </>
        ) : (
          <Button onClick={() => setFlow('setup')}>Enable two-factor authentication</Button>
        )}
      </CardFooter>

      {/* Enable: password → QR → confirm */}
      <Dialog open={flow === 'setup'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set up two-factor authentication</DialogTitle>
            <DialogDescription>
              {setup
                ? 'Scan the QR code with your authenticator app, then enter the code it shows.'
                : hasPassword
                  ? 'Confirm your password to start.'
                  : 'A new secret will be generated for your authenticator app.'}
            </DialogDescription>
          </DialogHeader>
          {setup ? (
            <div className="flex flex-col gap-4">
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated server-side */}
                <img
                  src={setup.qrDataUrl}
                  alt="QR code for your authenticator app"
                  width={240}
                  height={240}
                  className="rounded-lg border bg-white p-2"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Can&apos;t scan? Enter this key manually:{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground select-all">
                  {setup.secret}
                </code>
              </p>
              {codeField()}
              {errorLine}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {passwordField}
              {errorLine}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={reset} disabled={pending}>
              Cancel
            </Button>
            {setup ? (
              <Button onClick={confirmSetup} disabled={pending || code.trim().length < 6}>
                {pending ? 'Verifying…' : 'Turn on'}
              </Button>
            ) : (
              <Button onClick={beginSetup} disabled={pending || (hasPassword && !password)}>
                {pending ? 'Preparing…' : 'Continue'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Backup codes, shown once */}
      <Dialog open={flow === 'backup-codes'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your backup codes</DialogTitle>
            <DialogDescription>
              Each code signs you in once if you lose access to your authenticator app. They are
              shown only now; store them somewhere safe.
            </DialogDescription>
          </DialogHeader>
          <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm">
            {codes?.map((c) => (
              <li key={c} className="select-all">
                {c}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={copyCodes}>
              <Copy aria-hidden /> Copy
            </Button>
            <Button onClick={reset}>I saved them</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerate backup codes */}
      <Dialog open={flow === 'regenerate'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate new backup codes</DialogTitle>
            <DialogDescription>
              Your current backup codes stop working. Enter a code from your authenticator app to
              continue.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {codeField()}
            {errorLine}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={reset} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={regenerate} disabled={pending || code.trim().length < 6}>
              {pending ? 'Generating…' : 'Generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable */}
      <Dialog open={flow === 'disable'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable two-factor authentication</DialogTitle>
            <DialogDescription>
              Your account will be protected by {hasPassword ? 'your password' : 'single sign-on'}{' '}
              only. Confirm with {hasPassword ? 'your password and ' : ''}a current code (or a
              backup code).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {passwordField}
            {codeField('Authentication or backup code')}
            {errorLine}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={reset} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={disable}
              disabled={pending || code.trim().length < 6 || (hasPassword && !password)}
            >
              {pending ? 'Disabling…' : 'Disable'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
