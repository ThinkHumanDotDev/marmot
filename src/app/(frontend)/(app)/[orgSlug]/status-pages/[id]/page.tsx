import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { StatusPageEditor } from '@/components/status-pages/editor/status-page-editor'
import type { MonitorOption } from '@/components/status-pages/api'
import { toTemplateRow } from '@/lib/templates'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'
import { getInstanceSettings } from '@/server/settings'

import { resolveOrg } from '../resolve-org'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('statusPages.editorPage')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

export default async function StatusPageEditorPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>
}) {
  const { orgSlug, id } = await params
  const { payload, user, org, can } = await resolveOrg(orgSlug)
  const pageId = payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

  const [{ docs: pages }, { docs: monitors }, timeZone, { docs: templates }, settings] =
    await Promise.all([
      payload.find({
        collection: 'status-pages',
        where: { and: [{ id: { equals: pageId } }, { organization: { equals: org.id } }] },
        limit: 1,
        depth: 1,
        user,
        overrideAccess: false,
      }),
      payload.find({
        collection: 'monitors',
        where: { organization: { equals: org.id } },
        sort: 'name',
        limit: 500,
        pagination: false,
        depth: 0,
        user,
        overrideAccess: false,
      }),
      getOrganizationTimezone(payload, org.id),
      payload.find({
        collection: 'templates',
        where: {
          and: [
            { organization: { equals: org.id } },
            { kind: { in: ['incident', 'incident-update'] } },
          ],
        },
        sort: 'name',
        limit: 500,
        pagination: false,
        depth: 0,
        user,
        overrideAccess: false,
      }),
      getInstanceSettings(payload),
    ])

  const page = pages[0]
  if (!page) notFound()

  const { docs: incidents } = await payload.find({
    collection: 'incidents',
    where: { statusPage: { equals: page.id } },
    sort: '-createdAt',
    limit: 200,
    depth: 0,
    user,
    overrideAccess: false,
  })

  // Twilio channels for the SMS sender of subscriptions (names only: configs hold credentials).
  const { docs: twilioChannels } = can('notification:read')
    ? await payload.find({
        collection: 'notifications',
        where: { and: [{ organization: { equals: org.id } }, { type: { equals: 'twilio' } }] },
        sort: 'name',
        limit: 100,
        depth: 0,
        select: { name: true },
        user,
        overrideAccess: false,
      })
    : { docs: [] }

  const monitorOptions: MonitorOption[] = monitors.map((m) => ({
    id: m.id,
    name: m.name,
    publicName: m.publicName ?? null,
    type: m.type,
    active: m.active,
    url: m.url,
    hostname: m.hostname,
    lastStatus: m.status?.lastStatus ?? undefined,
  }))

  return (
    <StatusPageEditor
      orgId={org.id}
      orgSlug={org.slug}
      initialPage={page}
      initialIncidents={incidents}
      monitors={monitorOptions}
      canEdit={can('status-page:update')}
      canDelete={can('status-page:delete')}
      timeZone={timeZone}
      orgName={org.name}
      templates={templates.map(toTemplateRow)}
      canReadSubscribers={can('subscriber:read')}
      canManageSubscribers={can('subscriber:manage')}
      canSendNotifications={can('subscriber:send')}
      smsChannels={twilioChannels.map((channel) => ({ id: channel.id, name: channel.name }))}
      trustProxy={settings.trustProxy}
    />
  )
}
