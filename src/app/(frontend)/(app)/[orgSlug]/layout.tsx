import { notFound, redirect } from 'next/navigation'
import React from 'react'

import { AppShell } from '@/components/shell/app-shell'
import { getUserOrganizations, homePathFor, requireUser, type OrgMembership } from '@/lib/auth'

export const dynamic = 'force-dynamic'

interface OrgLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}

/** Resolves the organization from the URL, guards membership and wraps pages in the shell. */
export default async function OrgLayout({ children, params }: OrgLayoutProps) {
  const { orgSlug } = await params
  const user = await requireUser(`/${orgSlug}`)
  const organizations = await getUserOrganizations(user)

  let currentOrg: OrgMembership | undefined = organizations.find((org) => org.slug === orgSlug)

  if (!currentOrg) {
    if (user.superadmin) {
      // Instance admins may inspect any organization; show the slug until the real record loads.
      currentOrg = { id: orgSlug, slug: orgSlug, name: orgSlug, role: 'superadmin' }
    } else if (organizations.length > 0) {
      redirect(homePathFor(organizations))
    } else {
      notFound()
    }
  }

  return (
    <AppShell
      user={{ id: user.id, email: user.email, name: user.name, superadmin: !!user.superadmin }}
      organizations={
        currentOrg && !organizations.includes(currentOrg)
          ? [currentOrg, ...organizations]
          : organizations
      }
      currentOrg={currentOrg}
    >
      {children}
    </AppShell>
  )
}
