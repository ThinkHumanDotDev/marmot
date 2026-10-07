import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { isSuperadmin } from '@/access/permissions'
import { InstanceSettingsForm } from '@/components/settings/instance-settings-form'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SmtpTestCard } from '@/components/settings/smtp-test-card'
import { env } from '@/env'
import { requireUser } from '@/lib/auth'
import { resolveInstanceSettings } from '@/server/settings'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('instance') }
}
export const dynamic = 'force-dynamic'

/** Superadmin-only: the `instance-settings` global and an SMTP check. Others get a 404. */
export default async function InstanceSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}/settings/instance`)
  if (!isSuperadmin(user)) notFound()

  const payload = await getPayload({ config })
  // Read as the superadmin (not through the 60 s cache) so the form always shows what is stored.
  const doc = await payload.findGlobal({
    slug: 'instance-settings',
    depth: 0,
    user: { ...user, collection: 'users' },
    overrideAccess: false,
  })
  const settings = resolveInstanceSettings(doc)
  // Open sign-up lets anyone create monitors; without the guard they can point them at the
  // worker's private network (metadata endpoints, the bundled database, the tailnet).
  const warnPrivateAddresses = settings.allowSignup && !env.MONITOR_DENY_PRIVATE_ADDRESSES
  const t = await getTranslations('settings.instance.privateAddressWarning')

  return (
    <>
      {warnPrivateAddresses ? (
        <Card role="alert" className="border-destructive/50" data-testid="private-address-warning">
          <CardHeader>
            <CardTitle className="text-destructive">{t('title')}</CardTitle>
            <CardDescription>
              {t.rich('description', { code: (chunks) => <code>{chunks}</code> })}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      <InstanceSettingsForm settings={settings} />
      <SmtpTestCard
        smtpHost={env.SMTP_HOST ?? null}
        from={env.EMAIL_FROM}
        defaultRecipient={user.email}
      />
    </>
  )
}
