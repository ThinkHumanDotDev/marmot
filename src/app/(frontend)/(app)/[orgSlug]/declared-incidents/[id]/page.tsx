import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { DeclaredDetail } from '@/components/declared-incidents/declared-detail'
import { PageHeader } from '@/components/page-header'
import type { DeclaredIncidentSummary } from '@/lib/declared-incidents'
import { memberChoices, statusPageIncidentChoices } from '@/server/declared-incidents/page-data'
import {
  loadOrgDeclaredIncident,
  serializeDeclaredIncident,
} from '@/server/declared-incidents/store'
import { parseId } from '@/server/monitors/http'
import { getOrgPageContext, type OrgPageContext } from '@/server/monitors/page-data'

export const dynamic = 'force-dynamic'

interface DeclaredIncidentPageProps {
  params: Promise<{ orgSlug: string; id: string }>
}

async function load(ctx: OrgPageContext, id: string): Promise<DeclaredIncidentSummary> {
  if (!ctx.allowed('declared-incident:read')) notFound()
  const doc = await loadOrgDeclaredIncident(
    ctx.payload,
    ctx.requestUser,
    ctx.org.id,
    parseId(ctx.payload, id),
  )
  if (!doc) notFound()
  return serializeDeclaredIncident(ctx.payload, doc)
}

export async function generateMetadata({ params }: DeclaredIncidentPageProps): Promise<Metadata> {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/declared-incidents/${id}`)
  return { title: (await load(ctx, id)).title }
}

/** One declared incident: workflow, details, postmortem and timeline. */
export default async function DeclaredIncidentPage({ params }: DeclaredIncidentPageProps) {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/declared-incidents/${id}`)
  const incident = await load(ctx, id)
  const t = await getTranslations('declaredIncidents.detail')
  const canUpdate = ctx.allowed('declared-incident:update')
  const [members, statusPageIncidents] = canUpdate
    ? await Promise.all([memberChoices(ctx), statusPageIncidentChoices(ctx)])
    : [[], []]

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/declared-incidents`} className="hover:text-foreground">
            {t('breadcrumb')}
          </Link>
        }
        title={incident.title}
      />
      <section className="p-4 sm:p-6 md:p-8">
        <DeclaredDetail
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          initial={incident}
          members={members}
          statusPageIncidents={statusPageIncidents}
          canUpdate={canUpdate}
          canSkipPostmortem={ctx.allowed('declared-incident:skip-postmortem')}
        />
      </section>
    </>
  )
}
