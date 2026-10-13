import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { DeclareDialog } from '@/components/declared-incidents/declare-dialog'
import { DeclaredList } from '@/components/declared-incidents/declared-list'
import { PageHeader } from '@/components/page-header'
import { memberChoices } from '@/server/declared-incidents/page-data'
import { listDeclaredIncidents } from '@/server/declared-incidents/store'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('declaredIncidents')
  return { title: t('metaTitle') }
}

export const dynamic = 'force-dynamic'

interface DeclaredIncidentsPageProps {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ status?: string }>
}

/** Declared incidents (#101): active ones by default, every one with `?status=all`. */
export default async function DeclaredIncidentsPage({
  params,
  searchParams,
}: DeclaredIncidentsPageProps) {
  const { orgSlug } = await params
  const filter = (await searchParams).status === 'all' ? 'all' : 'active'
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/declared-incidents`)
  if (!ctx.allowed('declared-incident:read')) notFound()
  const t = await getTranslations('declaredIncidents')
  const canCreate = ctx.allowed('declared-incident:create')

  const [result, members] = await Promise.all([
    listDeclaredIncidents(ctx.payload, ctx.org.id, {
      status: filter,
      limit: 100,
      user: ctx.requestUser,
    }),
    canCreate ? memberChoices(ctx) : Promise.resolve([]),
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
        <DeclaredList orgId={ctx.org.id} orgSlug={orgSlug} docs={result.docs} filter={filter} />
      </section>
    </>
  )
}
