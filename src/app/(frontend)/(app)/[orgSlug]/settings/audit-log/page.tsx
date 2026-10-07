import { ScrollText } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { isSuperadmin } from '@/access/permissions'
import { EmptyState } from '@/components/empty-state'
import { AuditLogView } from '@/components/settings/audit-log-view'
import { timeZoneOrDefault } from '@/i18n/formats'
import { listOrgMembers } from '@/server/members'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { listAuditEvents } from '@/server/audit/query'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('auditLog') }
}
export const dynamic = 'force-dynamic'

/**
 * Settings → Audit log: the organization's audit events with filters, a diff per event and CSV
 * export. Needs `audit-log:read` (owners and admins by default; permission overrides apply).
 */
export default async function AuditLogSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/audit-log`)
  const t = await getTranslations('settings.auditLog')

  if (!ctx.allowed('audit-log:read')) {
    return (
      <EmptyState
        icon={ScrollText}
        title={t('adminsOnlyTitle')}
        description={t('adminsOnlyDescription')}
      />
    )
  }

  const [initial, members] = await Promise.all([
    listAuditEvents(ctx.payload, ctx.requestUser, ctx.org.id, {}),
    listOrgMembers(ctx.payload, ctx.org.id, { overrideAccess: true }),
  ])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <AuditLogView
        orgId={String(ctx.org.id)}
        initial={initial}
        actors={members.map((member) => ({
          id: String(member.id),
          label: member.name ? `${member.name} (${member.email})` : member.email,
        }))}
        superadmin={isSuperadmin(ctx.user)}
        timeZone={timeZoneOrDefault(ctx.org.settings?.timezone)}
      />
    </div>
  )
}
