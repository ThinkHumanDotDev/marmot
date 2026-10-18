/**
 * Settings → Integrations side of the Slack app (#129) and the link confirmation: what the settings
 * card shows, uninstalling, removing a linked user, and linking the signed-in member to the Slack
 * user of a `/marmot link` token.
 */
import type { Payload } from 'payload'

import type { SlackSettings } from '@/lib/slack-app'
import type { Organization, SlackInstallation, SlackUserLink } from '@/payload-types'
import type { RequestUser } from '@/server/monitors/http'

import { isSlackAppEnabled } from './config'
import {
  findInstallationByOrg,
  findInstallationByTeam,
  installationRow,
  isOrgMember,
  linkSlackUser,
  relId,
  removeInstallation,
  type Id,
} from './installations'
import { verifyLinkToken } from './tokens'
import type { UserLike } from '@/access/permissions'

export async function slackSettings(payload: Payload, orgId: Id): Promise<SlackSettings> {
  if (!isSlackAppEnabled()) return { enabled: false, installation: null }
  return { enabled: true, installation: await installationRow(payload, orgId) }
}

/** Removes the organization's installation; `false` when there is none. */
export async function uninstall(payload: Payload, orgId: Id, actor: RequestUser): Promise<boolean> {
  const installation = await findInstallationByOrg(payload, orgId)
  if (!installation) return false
  await removeInstallation(payload, installation, { actor })
  return true
}

/** Removes one linked Slack user of the organization; `false` when it is not one of its links. */
export async function removeLink(
  payload: Payload,
  orgId: Id,
  linkId: Id,
  actor: RequestUser,
): Promise<boolean> {
  const link = (await payload
    .findByID({ collection: 'slack-user-links', id: linkId, depth: 0, overrideAccess: true })
    .catch(() => null)) as SlackUserLink | null
  if (!link || String(relId(link.organization)) !== String(orgId)) return false
  await payload.delete({
    collection: 'slack-user-links',
    id: link.id,
    overrideAccess: true,
    user: actor,
  })
  return true
}

export type LinkTarget =
  | { ok: true; installation: SlackInstallation; organization: Organization; slackUserId: string }
  | { ok: false; error: 'invalid' }

/** What a `/slack/link/<token>` link would link (for the confirmation page and the POST). */
export async function resolveLinkToken(payload: Payload, token: string): Promise<LinkTarget> {
  if (!isSlackAppEnabled()) return { ok: false, error: 'invalid' }
  const claim = verifyLinkToken(token)
  if (!claim) return { ok: false, error: 'invalid' }
  const installation = await findInstallationByTeam(payload, claim.teamId)
  const orgId = installation ? relId(installation.organization) : null
  if (!installation || orgId === null) return { ok: false, error: 'invalid' }
  const organization = (await payload
    .findByID({ collection: 'organizations', id: orgId, depth: 0, overrideAccess: true })
    .catch(() => null)) as Organization | null
  if (!organization) return { ok: false, error: 'invalid' }
  return { ok: true, installation, organization, slackUserId: claim.slackUserId }
}

export type ConfirmLinkResult =
  { ok: true; link: SlackUserLink } | { ok: false; error: 'invalid' | 'not-member' }

/** Links the Slack user of `token` to `user`, a member of the installing organization. */
export async function confirmLink(
  payload: Payload,
  token: string,
  user: RequestUser,
): Promise<ConfirmLinkResult> {
  const target = await resolveLinkToken(payload, token)
  if (!target.ok) return target
  if (!isOrgMember(user as UserLike, target.organization.id)) {
    return { ok: false, error: 'not-member' }
  }
  const link = await linkSlackUser(payload, target.installation, target.slackUserId, user.id, user)
  return { ok: true, link }
}
