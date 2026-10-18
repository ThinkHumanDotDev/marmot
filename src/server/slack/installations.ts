/**
 * Slack installations and linked users (#129): lookups by workspace, the linked member behind a
 * Slack user, and the writes of the OAuth callback, the link page and the settings card. Every
 * write runs with `overrideAccess: true` after the caller checked who may make it.
 */
import type { Payload, PayloadRequest, Where } from 'payload'

import { canInOrg } from '@/access/overrides'
import { getUserOrgIds, isSuperadmin, type Permission, type UserLike } from '@/access/permissions'
import { childLogger } from '@/lib/logger'
import {
  isSlackAppTarget,
  parseSlackAppTarget,
  type SlackInstallationRow,
  type SlackLinkRow,
} from '@/lib/slack-app'
import type { SlackInstallation, SlackUserLink, User } from '@/payload-types'
import type { RequestUser } from '@/server/monitors/http'

import { slackApi } from './api'
import { openBotToken, sealBotToken } from './tokens'

const log = childLogger('slack:installations')

export type Id = string | number

export const relId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

async function findOne(payload: Payload, where: Where): Promise<SlackInstallation | null> {
  const { docs } = await payload.find({
    collection: 'slack-installations',
    where,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    showHiddenFields: true,
  })
  return (docs[0] as SlackInstallation | undefined) ?? null
}

export const findInstallationByTeam = (payload: Payload, teamId: string) =>
  findOne(payload, { teamId: { equals: teamId } })

export const findInstallationByOrg = (payload: Payload, orgId: Id) =>
  findOne(payload, { organization: { equals: orgId } })

/** The bot token of an installation, or `null` when it cannot be opened. */
export const installationToken = (installation: Pick<SlackInstallation, 'botToken'>) =>
  openBotToken(installation.botToken)

export interface InstallInput {
  orgId: Id
  userId: Id
  teamId: string
  teamName: string | null
  enterpriseId: string | null
  appId: string | null
  botUserId: string | null
  botToken: string
  scopes: string[]
  /** The Slack user who clicked "Allow"; linked to the installing member. */
  authedUserId: string | null
  /** The member installing (recorded as the actor in the audit log). */
  actor?: RequestUser | null
}

export type InstallResult =
  { ok: true; installation: SlackInstallation } | { ok: false; error: 'team-taken' }

/**
 * Stores (or refreshes) the organization's installation. A workspace belongs to one organization:
 * installing it from a second one is refused. Installing another workspace replaces the previous
 * one (its links and app subscriptions go).
 */
export async function saveInstallation(
  payload: Payload,
  input: InstallInput,
): Promise<InstallResult> {
  const byTeam = await findInstallationByTeam(payload, input.teamId)
  if (byTeam && String(relId(byTeam.organization)) !== String(input.orgId)) {
    return { ok: false, error: 'team-taken' }
  }
  const byOrg = await findInstallationByOrg(payload, input.orgId)
  if (byOrg && byOrg.teamId !== input.teamId) {
    await removeInstallation(payload, byOrg, { actor: input.actor })
  }
  const actor = input.actor ? { user: input.actor } : {}

  const data = {
    organization: input.orgId as SlackInstallation['organization'],
    teamId: input.teamId,
    teamName: input.teamName,
    enterpriseId: input.enterpriseId,
    appId: input.appId,
    botUserId: input.botUserId,
    botToken: sealBotToken(input.botToken),
    scopes: input.scopes,
    installedBy: input.userId as SlackInstallation['installedBy'],
  }
  const installation = (
    byTeam
      ? await payload.update({
          collection: 'slack-installations',
          id: byTeam.id,
          data,
          depth: 0,
          overrideAccess: true,
          ...actor,
        })
      : await payload.create({
          collection: 'slack-installations',
          data,
          depth: 0,
          overrideAccess: true,
          ...actor,
        })
  ) as SlackInstallation
  if (input.authedUserId) {
    await linkSlackUser(payload, installation, input.authedUserId, input.userId, input.actor)
  }
  return { ok: true, installation }
}

/**
 * Removes an installation: revokes the bot token (best effort), deletes the linked users (the
 * collection hook) and every channel subscription made through it.
 */
export async function removeInstallation(
  payload: Payload,
  installation: SlackInstallation,
  { revoke = true, actor = null }: { revoke?: boolean; actor?: RequestUser | null } = {},
): Promise<void> {
  const token = installationToken(installation)
  if (revoke && token) {
    await slackApi('auth.revoke', token, {}).catch((err: unknown) => {
      log.info({ err: err instanceof Error ? err.message : String(err) }, 'token revoke failed')
    })
  }
  // The collection hook removes the linked users and the channel subscriptions.
  await payload.delete({
    collection: 'slack-installations',
    id: installation.id,
    depth: 0,
    overrideAccess: true,
    ...(actor ? { user: actor } : {}),
  })
}

/** Status-page subscriptions of channels in `teamId` (any organization's pages). */
export async function appSubscriptions(
  payload: Payload,
  teamId: string,
  channelId?: string,
  req?: PayloadRequest,
): Promise<{ id: Id; statusPage: Id | null; target: string }[]> {
  const prefix = channelId ? `slack://${teamId}/${channelId}` : `slack://${teamId}/`
  const { docs } = await payload.find({
    collection: 'status-page-subscribers',
    where: {
      and: [{ channel: { equals: 'slack' } }, { target: { contains: prefix } }],
    },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { statusPage: true, target: true },
    ...(req ? { req } : {}),
  })
  return docs
    .filter((doc) => {
      const parsed = parseSlackAppTarget(doc.target)
      return (
        isSlackAppTarget(doc.target) &&
        parsed?.teamId === teamId &&
        (!channelId || parsed.channelId === channelId)
      )
    })
    .map((doc) => ({ id: doc.id, statusPage: relId(doc.statusPage), target: doc.target }))
}

/** Ends every channel subscription made through the workspace's installation. */
export async function removeAppSubscriptions(
  payload: Payload,
  teamId: string,
  req?: PayloadRequest,
): Promise<void> {
  for (const row of await appSubscriptions(payload, teamId, undefined, req)) {
    await payload.delete({
      collection: 'status-page-subscribers',
      id: row.id,
      overrideAccess: true,
      ...(req ? { req } : {}),
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Linked users

export async function findLink(
  payload: Payload,
  teamId: string,
  slackUserId: string,
): Promise<SlackUserLink | null> {
  const { docs } = await payload.find({
    collection: 'slack-user-links',
    where: { and: [{ teamId: { equals: teamId } }, { slackUserId: { equals: slackUserId } }] },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return (docs[0] as SlackUserLink | undefined) ?? null
}

/** Links `slackUserId` of the installation's workspace to `userId` (replacing an earlier link). */
export async function linkSlackUser(
  payload: Payload,
  installation: SlackInstallation,
  slackUserId: string,
  userId: Id,
  actor: RequestUser | null = null,
): Promise<SlackUserLink> {
  const existing = await findLink(payload, installation.teamId, slackUserId)
  const data = {
    organization: relId(installation.organization) as SlackUserLink['organization'],
    installation: installation.id,
    teamId: installation.teamId,
    slackUserId,
    user: userId as SlackUserLink['user'],
  }
  return (
    existing
      ? await payload.update({
          collection: 'slack-user-links',
          id: existing.id,
          data,
          depth: 0,
          overrideAccess: true,
          ...(actor ? { user: actor } : {}),
        })
      : await payload.create({
          collection: 'slack-user-links',
          data,
          depth: 0,
          overrideAccess: true,
          ...(actor ? { user: actor } : {}),
        })
  ) as SlackUserLink
}

export async function unlinkSlackUser(
  payload: Payload,
  teamId: string,
  slackUserId: string,
): Promise<boolean> {
  const link = await findLink(payload, teamId, slackUserId)
  if (!link) return false
  await payload.delete({ collection: 'slack-user-links', id: link.id, overrideAccess: true })
  return true
}

/** Is `user` a member of `orgId` (any role)? */
export const isOrgMember = (user: UserLike, orgId: Id): boolean =>
  isSuperadmin(user) || getUserOrgIds(user).some((id) => String(id) === String(orgId))

/**
 * The Marmot member behind a Slack user of the installation's workspace, as a Local API user, or
 * `null` when the Slack user is not linked, the account is gone or is no longer a member of the
 * installing organization.
 */
export async function linkedUser(
  payload: Payload,
  installation: SlackInstallation,
  slackUserId: string,
): Promise<RequestUser | null> {
  const link = await findLink(payload, installation.teamId, slackUserId)
  const userId = relId(link?.user)
  if (!link || userId === null) return null
  const user = (await payload
    .findByID({ collection: 'users', id: userId, depth: 0, overrideAccess: true })
    .catch(() => null)) as User | null
  if (!user) return null
  const orgId = relId(installation.organization)
  if (orgId === null || !isOrgMember(user as UserLike, orgId)) return null
  return { ...user, collection: 'users' } as RequestUser
}

/** `linkedUser` plus a permission check in the installing organization. */
export async function linkedUserWith(
  payload: Payload,
  installation: SlackInstallation,
  slackUserId: string,
  permission: Permission,
): Promise<{ user: RequestUser | null; allowed: boolean }> {
  const user = await linkedUser(payload, installation, slackUserId)
  const orgId = relId(installation.organization)
  if (!user || orgId === null) return { user, allowed: false }
  return { user, allowed: await canInOrg(payload, user, orgId, permission) }
}

// ---------------------------------------------------------------------------------------------
// Settings

/** The organization's installation and its linked users as the settings card shows them. */
export async function installationRow(
  payload: Payload,
  orgId: Id,
): Promise<SlackInstallationRow | null> {
  const installation = await findInstallationByOrg(payload, orgId)
  if (!installation) return null
  const { docs } = await payload.find({
    collection: 'slack-user-links',
    where: { installation: { equals: installation.id } },
    depth: 1,
    limit: 500,
    sort: 'createdAt',
    overrideAccess: true,
  })
  const installer =
    installation.installedBy === null || installation.installedBy === undefined
      ? null
      : ((await payload
          .findByID({
            collection: 'users',
            id: relId(installation.installedBy) as Id,
            depth: 0,
            overrideAccess: true,
          })
          .catch(() => null)) as User | null)
  const links: SlackLinkRow[] = (docs as SlackUserLink[]).map((link) => {
    const user = link.user && typeof link.user === 'object' ? (link.user as User) : null
    return {
      id: String(link.id),
      slackUserId: link.slackUserId,
      user: user ? { id: String(user.id), name: user.name || user.email, email: user.email } : null,
      createdAt: link.createdAt,
    }
  })
  return {
    id: String(installation.id),
    teamId: installation.teamId,
    teamName: installation.teamName || installation.teamId,
    scopes: installation.scopes ?? [],
    installedBy: installer
      ? { id: String(installer.id), name: installer.name || installer.email }
      : null,
    createdAt: installation.createdAt,
    links,
  }
}
