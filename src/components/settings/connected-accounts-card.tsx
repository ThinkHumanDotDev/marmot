'use client'

import { KeyRound, Link2, Unlink } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { accountApi, type ConnectedAccount, type ConnectedAccounts } from '@/lib/org-api'

interface ConnectedAccountsCardProps {
  initial: ConnectedAccounts
  /** Same-origin path the provider returns to after linking (this page). */
  returnPath: string
  /** `?error=<code>` from a failed link attempt, already turned into text. */
  error?: string
}

/**
 * Account security: the single sign-on identities linked to the account, with **Unlink** (never the
 * last way in) and **Link** buttons for the providers this instance offers. Linking is a redirect
 * through the provider (`/api/auth/sso/<id>/login?link=1`), so the list is refreshed on return.
 */
export function ConnectedAccountsCard({ initial, returnPath, error }: ConnectedAccountsCardProps) {
  const t = useTranslations('settings.account.connected')
  const format = useFormatter()
  const formatDate = (value: string | null) =>
    value ? format.dateTime(new Date(value), 'short') : '—'
  const router = useRouter()
  const [data, setData] = React.useState(initial)
  const [pending, setPending] = React.useState<string | number | null>(null)
  const [confirm, setConfirm] = React.useState<ConnectedAccount | null>(null)

  const onlyWayIn = !data.hasPassword && data.accounts.length <= 1

  async function unlink(account: ConnectedAccount) {
    setPending(account.id)
    try {
      await accountApi.connectedAccounts.unlink(account.id)
      setData(await accountApi.connectedAccounts.list())
      toast.success(t('unlinked', { provider: account.providerName }))
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('unlinkFailed'))
    } finally {
      setPending(null)
      setConfirm(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-6">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {data.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border">
            {data.accounts.map((account) => (
              <li key={String(account.id)} className="flex items-center gap-3 px-3 py-2">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{account.providerName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t('identity', {
                      identity: account.email ?? account.providerAccountId,
                      lastUsed: formatDate(account.lastLoginAt),
                    })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null || onlyWayIn}
                  title={onlyWayIn ? t('onlyWayIn') : undefined}
                  onClick={() => setConfirm(account)}
                >
                  <Unlink className="size-4" aria-hidden /> {t('unlink')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {data.linkable.length > 0 && (
        <CardFooter className="flex flex-wrap gap-2">
          {data.linkable.map((provider) => (
            <Button key={provider.id} asChild variant="outline" size="sm">
              <a
                href={`${provider.loginPath}?link=1&next=${encodeURIComponent(returnPath)}`}
                rel="nofollow"
              >
                <Link2 className="size-4" aria-hidden /> {t('link', { provider: provider.name })}
              </a>
            </Button>
          ))}
        </CardFooter>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('confirmTitle', { provider: confirm?.providerName ?? '' })}
        description={t('confirmDescription')}
        confirmLabel={t('unlink')}
        destructive
        onConfirm={() => (confirm ? unlink(confirm) : undefined)}
      />
    </Card>
  )
}
