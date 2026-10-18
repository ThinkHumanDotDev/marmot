'use client'

import { MessageSquare, Unlink } from 'lucide-react'
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
import type { SlackInstallationRow, SlackLinkRow } from '@/lib/slack-app'
import { slackApi } from '@/lib/slack-api'

interface SlackAppCardProps {
  orgId: string
  initial: SlackInstallationRow | null
  canManage: boolean
  /** `?slack=<outcome>` after returning from Slack's install screen. */
  outcome?: string
}

/**
 * Settings → Integrations: the Slack app (#129). "Add to Slack" (a redirect through Slack's OAuth
 * screen), the connected workspace, its linked Slack users (admins can unlink them) and removal.
 * Only rendered when the instance has the `SLACK_*` variables set.
 */
export function SlackAppCard({ orgId, initial, canManage, outcome }: SlackAppCardProps) {
  const t = useTranslations('settings.integrations.slack')
  const format = useFormatter()
  const [installation, setInstallation] = React.useState(initial)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [confirmUnlink, setConfirmUnlink] = React.useState<SlackLinkRow | null>(null)
  const [pending, setPending] = React.useState(false)

  React.useEffect(() => {
    if (!outcome) return
    const message = t('outcomes', { outcome })
    if (outcome === 'installed') toast.success(message)
    else toast.error(message)
  }, [outcome, t])

  async function uninstall() {
    setPending(true)
    try {
      await slackApi.uninstall(orgId)
      setInstallation(null)
      toast.success(t('uninstalled'))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('uninstallFailed'))
    } finally {
      setPending(false)
      setConfirmRemove(false)
    }
  }

  async function unlink(link: SlackLinkRow) {
    setPending(true)
    try {
      await slackApi.unlink(orgId, link.id)
      setInstallation((current) =>
        current ? { ...current, links: current.links.filter((l) => l.id !== link.id) } : current,
      )
      toast.success(t('unlinked'))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('unlinkFailed'))
    } finally {
      setPending(false)
      setConfirmUnlink(null)
    }
  }

  return (
    <Card data-testid="slack-app-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-4" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      {installation && (
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="text-sm">
            <p className="font-medium" data-testid="slack-team">
              {t('installedIn', { team: installation.teamName })}
            </p>
            {installation.installedBy && (
              <p className="text-muted-foreground">
                {t('installedBy', {
                  name: installation.installedBy.name,
                  date: format.dateTime(new Date(installation.createdAt), 'short'),
                })}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t('linkedUsers')}</p>
            {installation.links.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noLinks')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border">
                {installation.links.map((link) => (
                  <li key={link.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {t('linkedTo', {
                        slackUser: link.slackUserId,
                        name: link.user?.name ?? t('deletedAccount'),
                      })}
                    </span>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setConfirmUnlink(link)}
                      >
                        <Unlink className="size-4" aria-hidden /> {t('unlink')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      )}
      <CardFooter className="flex flex-wrap gap-2">
        {canManage ? (
          <>
            <Button asChild variant={installation ? 'outline' : 'default'} size="sm">
              <a href={slackApi.installUrl(orgId)} rel="nofollow" data-testid="slack-install">
                {installation ? t('reinstall') : t('install')}
              </a>
            </Button>
            {installation && (
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={() => setConfirmRemove(true)}
              >
                {t('uninstall')}
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
        )}
      </CardFooter>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('uninstallTitle')}
        description={t('uninstallDescription')}
        confirmLabel={t('uninstall')}
        destructive
        onConfirm={uninstall}
      />
      <ConfirmDialog
        open={confirmUnlink !== null}
        onOpenChange={(open) => !open && setConfirmUnlink(null)}
        title={t('unlink')}
        description={
          confirmUnlink
            ? t('linkedTo', {
                slackUser: confirmUnlink.slackUserId,
                name: confirmUnlink.user?.name ?? t('deletedAccount'),
              })
            : ''
        }
        confirmLabel={t('unlink')}
        destructive
        onConfirm={() => (confirmUnlink ? unlink(confirmUnlink) : undefined)}
      />
    </Card>
  )
}
