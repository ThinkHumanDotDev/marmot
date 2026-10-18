import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { DeclareDialog } from '@/components/declared-incidents/declare-dialog'
import { DeclaredList } from '@/components/declared-incidents/declared-list'
import { PageHeader } from '@/components/page-header'
import { isDeclaredSeverity } from '@/lib/declared-incidents'
import { memberChoices } from '@/server/declared-incidents/page-data'
import { listDeclaredIncidents, parseCommanderFilter } from '@/server/declared-incidents/store'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('declaredIncidents')
  return { title: t('metaTitle') }
}

export const dynamic = 'force-dynamic'

interface DeclaredIncidentsPageProps {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ status?: string; severity?: string; commander?: string; page?: string }>
}

/**
 * Declared incidents (#101): active ones by default, every one with `?status=all`; filtered by
 * `severity` and `commander`, paginated with `page`, with the time-to-mitigate/resolve summary.
 */
export default async function DeclaredIncidentsPage({
  params,
  searchParams,
}: DeclaredIncidentsPageProps) {
  const { orgSlug } = await params
  const query = await searchParams
  const filters = {
    status: query.status === 'all' ? 'all' : 'active',
    severity: isDeclaredSeverity(query.severity) ? query.severity : null,
    commander: query.commander || null,
  } as const
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1)
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/declared-incidents`)
  if (!ctx.allowed('declared-incident:read')) notFound()
  const t = await getTranslations('declaredIncidents')
  const canCreate = ctx.allowed('declared-incident:create')

  const [result, members] = await Promise.all([
    listDeclaredIncidents(ctx.payload, ctx.org.id, {
      status: filters.status,
      severity: filters.severity,
      commander: parseCommanderFilter(ctx.payload, filters.commander),
      page,
      limit: 25,
      user: ctx.requestUser,
    }),
    memberChoices(ctx),
  ])

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canCreate ? (
            <DeclareDialog orgId={ctx.org.id} orgSlug={orgSlug} members={members} />
          ) : undefined
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
        <DeclaredList
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          docs={result.docs}
          stats={result.stats}
          page={result.page}
          totalPages={result.totalPages}
          filters={filters}
          members={members}
        />
      </section>
    </>
  )
}
