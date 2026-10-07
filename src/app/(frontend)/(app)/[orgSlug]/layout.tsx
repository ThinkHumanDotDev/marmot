import { notFound, redirect } from 'next/navigation'
import { getPayload } from 'payload'
import React from 'react'

import config from '@payload-config'
import { AnalyticsIdentity } from '@/components/consent/analytics-identity'
import { SocketProvider } from '@/components/realtime/socket-provider'
import { AppShell } from '@/components/shell/app-shell'
import { OrgTimeZoneProvider } from '@/components/shell/org-time-zone-provider'
import { ThemeSync } from '@/components/theme-sync'
import { timeZoneOrDefault } from '@/i18n/formats'
import {
  getUserOrganizations,
  homePathFor,
  requireUser,
  type CurrentUser,
  type OrgMembership,
} from '@/lib/auth'
import type { Organization } from '@/payload-types'
import { hashAnalyticsId, isServerAnalyticsEnabled } from '@/server/analytics'

export const dynamic = 'force-dynamic'

interface OrgLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}

/** One of the user's organizations when the membership row carries the populated doc. */
function membershipOrg(user: CurrentUser, orgId: string | number): Organization | undefined {
  for (const row of user.organizations ?? []) {
    const org = row.organization
    if (org && typeof org === 'object' && String(org.id) === String(orgId)) return org
  }
  return undefined
}

/** Resolves the organization from the URL, guards membership and wraps pages in the shell. */
export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}`)
  const organizations = await getUserOrganizations(user)

  let currentOrg: OrgMembership | undefined = organizations.find((org) => org.slug === orgSlug)
  const membership = currentOrg ? membershipOrg(user, currentOrg.id) : undefined
  let plan = membership?.plan ?? undefined
  let timeZone = membership?.settings?.timezone

  if (!currentOrg) {
    if (user.superadmin) {
      // Instance admins may inspect any organization they are not a member of.
      const payload = await getPayload({ config })
      const { docs } = await payload.find({
        collection: 'organizations',
        where: { slug: { equals: orgSlug } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      const org = docs[0]
      if (!org) notFound()
      currentOrg = { id: org.id, slug: org.slug, name: org.name, role: 'superadmin' }
      plan = org.plan ?? undefined
      timeZone = org.settings?.timezone
    } else if (organizations.length > 0) {
      redirect(homePathFor(organizations))
    } else {
      notFound()
    }
  }

  return (
    <AppShell
      user={{
        id: user.id,
        email: user.email,
        name: user.name,
        superadmin: !!user.superadmin,
        authProvider: user.authProvider,
        theme: user.theme ?? 'system',
      }}
      organizations={
        currentOrg && !organizations.includes(currentOrg)
          ? [currentOrg, ...organizations]
          : organizations
      }
      currentOrg={currentOrg}
    >
      <ThemeSync theme={user.theme} />
      {/* Dates on the organization's pages render in its time zone (UTC unless configured). */}
      <OrgTimeZoneProvider timeZone={timeZoneOrDefault(timeZone)}>
        <SocketProvider organizationId={currentOrg.id}>{children}</SocketProvider>
      </OrgTimeZoneProvider>
      {isServerAnalyticsEnabled() && (
        // Only a keyed hash of the id reaches the browser/PostHog, never email or name.
        <AnalyticsIdentity hashedUserId={hashAnalyticsId(user.id)} plan={plan} />
      )}
    </AppShell>
  )
}
