/** Choices the declared-incident pages offer: members as commanders, status-page incidents to link. */
import type { MemberChoice } from '@/components/declared-incidents/declare-dialog'
import type { LinkChoice } from '@/components/declared-incidents/declared-detail'
import { listOrgMembers } from '@/server/members'
import type { OrgPageContext } from '@/server/monitors/page-data'

export async function memberChoices(ctx: OrgPageContext): Promise<MemberChoice[]> {
  const members = await listOrgMembers(ctx.payload, ctx.org.id)
  return members.map((member) => ({
    id: String(member.id),
    name: member.name?.trim() || member.email,
  }))
}

/** The organization's most recent status-page incidents, as the user may read them. */
export async function statusPageIncidentChoices(ctx: OrgPageContext): Promise<LinkChoice[]> {
  if (!ctx.allowed('status-page:read')) return []
  const { docs } = await ctx.payload.find({
    collection: 'incidents',
    where: { organization: { equals: ctx.org.id } },
    sort: '-createdAt',
    limit: 50,
    depth: 0,
    user: ctx.requestUser,
    overrideAccess: false,
    select: { title: true },
  })
  return docs.map((doc) => ({ id: String(doc.id), title: doc.title }))
}
