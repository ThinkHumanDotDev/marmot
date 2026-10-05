import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { isSuperadmin } from '@/access/permissions'
import { InstanceSettingsForm } from '@/components/settings/instance-settings-form'
import { SmtpTestCard } from '@/components/settings/smtp-test-card'
import { env } from '@/env'
import { requireUser } from '@/lib/auth'
import { resolveInstanceSettings } from '@/server/settings'

export const metadata: Metadata = { title: 'Instance settings' }
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

  return (
    <>
      <InstanceSettingsForm settings={settings} />
      <SmtpTestCard
        smtpHost={env.SMTP_HOST ?? null}
        from={env.EMAIL_FROM}
        defaultRecipient={user.email}
      />
    </>
  )
}
