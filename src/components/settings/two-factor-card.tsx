'use client'

import { Copy, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
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
  /** Organization time zone the "enabled on" date renders in. */
  timeZone: string
}

type Flow = 'idle' | 'setup' | 'backup-codes' | 'regenerate' | 'disable'

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

/**
 * Account security: enable TOTP (QR code → confirm code → backup codes shown once), regenerate
 * backup codes and disable with password + code. All calls go to `/api/account/2fa/*`.
 */
export function TwoFactorCard({ status, hasPassword, timeZone }: TwoFactorCardProps) {
  const t = useTranslations('settings.account.twoFactor')
  const format = useFormatter()
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
    }, t('setupFailed'))

  const confirmSetup = () =>
    run(async () => {
      const { backupCodes } = await accountApi.twoFactor.verify(code)
      setCodes(backupCodes)
      setFlow('backup-codes')
      setCode('')
      toast.success(t('enabledToast'))
      router.refresh()
    }, t('invalidCode'))

  const regenerate = () =>
    run(async () => {
      const { backupCodes } = await accountApi.twoFactor.regenerateBackupCodes(code)
      setCodes(backupCodes)
      setFlow('backup-codes')
      setCode('')
      toast.success(t('regenerated'))
      router.refresh()
    }, t('regenerateFailed'))

  const disable = () =>
    run(async () => {
      await accountApi.twoFactor.disable({ password, code })
      toast.success(t('disabledToast'))
      reset()
      router.refresh()
    }, t('disableFailed'))

  async function copyCodes() {
    if (!codes) return
    try {
      await navigator.clipboard.writeText(codes.join('\n'))
      toast.success(t('copied'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  const passwordField = hasPassword && (
    <div className="grid gap-2">
      <Label htmlFor={ids.password}>{t('password')}</Label>
      <Input
        id={ids.password}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </div>
  )

  const codeField = (label = t('code')) => (
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
          {t('title')}
          {status.enabled ? (
            <Badge className="gap-1">
              <ShieldCheck aria-hidden /> {t('on')}
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <ShieldOff aria-hidden /> {t('off')}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {status.enabled
            ? t('enabledDescription', { count: status.backupCodesRemaining })
            : t('disabledDescription')}
        </CardDescription>
      </CardHeader>
      {status.enabled && status.verifiedAt && (
        <CardContent className="pt-6 text-sm text-muted-foreground">
          {t('enabledOn', {
            date: format.dateTime(new Date(status.verifiedAt), 'date', { timeZone }),
          })}
          {!hasPassword && ` ${t('ssoNote')}`}
        </CardContent>
      )}
      <CardFooter className="flex flex-wrap justify-end gap-2 border-t pt-6">
        {status.enabled ? (
          <>
            <Button variant="outline" onClick={() => setFlow('regenerate')}>
              <KeyRound aria-hidden /> {t('newBackupCodes')}
            </Button>
            <Button variant="destructive" onClick={() => setFlow('disable')}>
              {t('disable')}
            </Button>
          </>
        ) : (
          <Button onClick={() => setFlow('setup')}>{t('enable')}</Button>
        )}
      </CardFooter>

      {/* Enable: password → QR → confirm */}
      <Dialog open={flow === 'setup'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('setup.title')}</DialogTitle>
            <DialogDescription>
              {setup
                ? t('setup.scan')
                : hasPassword
                  ? t('setup.confirmPassword')
                  : t('setup.newSecret')}
            </DialogDescription>
          </DialogHeader>
          {setup ? (
            <div className="flex flex-col gap-4">
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated server-side */}
                <img
                  src={setup.qrDataUrl}
                  alt={t('setup.qrAlt')}
                  width={240}
                  height={240}
                  className="rounded-lg border bg-white p-2"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t.rich('setup.manualKey', {
                  key: () => (
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground select-all">
                      {setup.secret}
                    </code>
                  ),
                })}
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
              {t('cancel')}
            </Button>
            {setup ? (
              <Button onClick={confirmSetup} disabled={pending || code.trim().length < 6}>
                {pending ? t('setup.verifying') : t('setup.turnOn')}
              </Button>
            ) : (
              <Button onClick={beginSetup} disabled={pending || (hasPassword && !password)}>
                {pending ? t('setup.preparing') : t('setup.continue')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Backup codes, shown once */}
      <Dialog open={flow === 'backup-codes'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('backupCodes.title')}</DialogTitle>
            <DialogDescription>{t('backupCodes.description')}</DialogDescription>
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
              <Copy aria-hidden /> {t('backupCodes.copy')}
            </Button>
            <Button onClick={reset}>{t('backupCodes.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerate backup codes */}
      <Dialog open={flow === 'regenerate'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('regenerate.title')}</DialogTitle>
            <DialogDescription>{t('regenerate.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {codeField()}
            {errorLine}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={reset} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button onClick={regenerate} disabled={pending || code.trim().length < 6}>
              {pending ? t('regenerate.submitting') : t('regenerate.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable */}
      <Dialog open={flow === 'disable'} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('disableDialog.title')}</DialogTitle>
            <DialogDescription>
              {hasPassword
                ? t('disableDialog.descriptionPassword')
                : t('disableDialog.descriptionSso')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {passwordField}
            {codeField(t('disableDialog.codeLabel'))}
            {errorLine}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={reset} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={disable}
              disabled={pending || code.trim().length < 6 || (hasPassword && !password)}
            >
              {pending ? t('disableDialog.submitting') : t('disable')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
