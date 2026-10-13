import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { OnCallView } from '@/components/on-call/on-call-view'
import { PageHeader } from '@/components/page-header'
import { listOrgMembers } from '@/server/members'
import { getOrgPageContext } from '@/server/monitors/page-data'
import {
  listPolicies,
  listSchedules,
  serializePolicies,
  serializeSchedules,
  SHIFT_HORIZON_DAYS,
  shiftsOf,
} from '@/server/on-call/store'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('onCall')
  return { title: t('metaTitle') }
}

export const dynamic = 'force-dynamic'

/** On-call (#145): who is on call, the member's shifts, schedules and escalation policies. */
export default async function OnCallPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/on-call`)
  if (!ctx.allowed('on-call:read')) notFound()
  const t = await getTranslations('onCall')
  const canManage = ctx.allowed('on-call:manage')
  const canReadPolicies = ctx.allowed('escalation-policy:read')
  const canManagePolicies = ctx.allowed('escalation-policy:manage')
  const now = new Date()

  const [scheduleDocs, members] = await Promise.all([
    listSchedules(ctx.payload, ctx.org.id, ctx.requestUser),
    listOrgMembers(ctx.payload, ctx.org.id),
  ])
  const [schedules, shifts, policyDocs] = await Promise.all([
    serializeSchedules(ctx.payload, scheduleDocs, now),
    shiftsOf(
      ctx.payload,
      scheduleDocs,
      now,
      new Date(now.getTime() + SHIFT_HORIZON_DAYS * 86_400_000),
    ),
    canReadPolicies
      ? listPolicies(ctx.payload, ctx.org.id, ctx.requestUser)
      : Promise.resolve(null),
  ])
  const policies = policyDocs ? await serializePolicies(ctx.payload, policyDocs) : null

  const memberChoices = members.map((member) => ({
    id: String(member.id),
    name: member.name?.trim() || member.email,
  }))
  const [channels, monitors] = canManagePolicies
    ? await Promise.all([
        ctx.payload.find({
          collection: 'notifications',
          where: { organization: { equals: ctx.org.id } },
          sort: 'name',
          limit: 200,
          depth: 0,
          user: ctx.requestUser,
          overrideAccess: false,
          select: { name: true },
        }),
        ctx.payload.find({
          collection: 'monitors',
          where: { organization: { equals: ctx.org.id } },
          sort: 'name',
          limit: 1000,
          depth: 0,
          user: ctx.requestUser,
          overrideAccess: false,
          select: { name: true },
        }),
      ])
    : [{ docs: [] }, { docs: [] }]
  const choice = (doc: { id: string | number; name?: string | null }) => ({
    id: String(doc.id),
    name: doc.name ?? '',
  })

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <section className="p-4 sm:p-6 md:p-8">
        <OnCallView
          orgId={ctx.org.id}
          schedules={schedules}
          shifts={shifts}
          userId={String(ctx.user.id)}
          policies={policies}
          members={memberChoices}
          choices={{
            schedule: schedules.map((schedule) => ({ id: schedule.id, name: schedule.name })),
            user: memberChoices,
            channel: channels.docs.map(choice),
          }}
          monitors={monitors.docs.map(choice)}
          canManage={canManage}
          canManagePolicies={canManagePolicies}
        />
      </section>
    </>
  )
}
