import type { Payload } from 'payload'

import { toMembershipData } from '@/access/memberships'
import { isRole, type OrgId, type Role } from '@/access/permissions'
import { childLogger } from '@/lib/logger'
import { desiredRoles, orgKey, type GroupRule } from '@/lib/sso-groups'
import type { User } from '@/payload-types'
import type { AuditAction } from '@/server/audit/actions'
import { hasMemberSeat } from '@/server/billing/entitlements'
import { countOwners, listOrgMembers } from '@/server/members'
import { auditTarget, recordRequestAuditEvent } from '@/server/security/audit'

const log = childLogger('sso')

/**
 * How one sign-in method treats identity-provider groups: the instance-wide OIDC provider takes
 * it from `OIDC_GROUP_CLAIM` / `OIDC_ALLOWED_GROUPS` / `OIDC_ROLE_MAPPING` / `OIDC_ROLE_MAPPING_REMOVE`,
 * an organization's SSO connection from its `groupClaim` / `allowedGroups` / `groupRoles` (rules
 * for its own organization only, never superadmin, never removal).
 */
export interface GroupPolicy {
  claim: string
  /** Normalised allow-list; empty lets everybody in. */
  allowed: string[]
  rules: GroupRule[]
  /** Remove memberships of managed organizations (and superadmin) the groups no longer grant. */
  remove: boolean
}

export interface GroupMappingInput {
  payload: Payload
  /** The sign-in request (IP address and user agent of the audit rows). */
  request: { headers: Headers }
  userId: OrgId
  provider: { id: string; name: string }
  policy: GroupPolicy
  /** Normalised groups the identity provider asserted. */
  groups: string[]
}

export interface GroupMappingResult {
  /** Role per organization id the mapping assigned or confirmed. */
  roles: Map<string, Role>
  changed: boolean
}

type Change =
  | { kind: 'added'; orgId: OrgId; role: Role }
  | { kind: 'role_changed'; orgId: OrgId; from: Role; role: Role }
  | { kind: 'removed'; orgId: OrgId; from: Role }
  | { kind: 'skipped'; orgId: OrgId; from: Role; wanted: Role | null }
  | { kind: 'seat_skipped'; orgId: OrgId; wanted: Role }
  | { kind: 'superadmin'; granted: boolean }
  | { kind: 'superadmin_skipped' }

/** Organization ids for the rules' keys; unknown slugs are logged and left out. */
async function resolveOrganizations(
  payload: Payload,
  rules: GroupRule[],
): Promise<Map<string, OrgId>> {
  const resolved = new Map<string, OrgId>()
  const slugs = new Set<string>()
  for (const rule of rules) {
    if ('superadmin' in rule) continue
    if ('id' in rule.org) resolved.set(orgKey(rule.org), rule.org.id)
    else slugs.add(rule.org.slug)
  }
  if (slugs.size > 0) {
    const { docs } = await payload.find({
      collection: 'organizations',
      where: { slug: { in: [...slugs] } },
      limit: slugs.size,
      depth: 0,
      overrideAccess: true,
    })
    for (const org of docs) resolved.set(`slug:${org.slug}`, org.id)
    const missing = [...slugs].filter((slug) => !resolved.has(`slug:${slug}`))
    if (missing.length > 0) {
      log.warn({ organizations: missing }, 'role mapping names organizations that do not exist')
    }
  }
  return resolved
}

const isLastOwner = async (payload: Payload, orgId: OrgId) =>
  countOwners(await listOrgMembers(payload, orgId)) <= 1

async function isLastSuperadmin(payload: Payload): Promise<boolean> {
  const { totalDocs } = await payload.count({
    collection: 'users',
    where: { superadmin: { equals: true } },
    overrideAccess: true,
  })
  return totalDocs <= 1
}

/**
 * Applies the group → role mapping to a user who just signed in (every login, not only the
 * first). Rules:
 *
 * - per organization the highest role among the user's matching groups wins; a user who is not a
 *   member yet is added with it, a member whose role differs is moved to it (up or down);
 * - with `remove`, a membership in an organization some rule names is removed when none of the
 *   user's groups maps to it any more; organizations no rule names are never touched;
 * - a user who is not a member yet is not added to an organization whose plan has no free seat
 *   (`maxMembers`, with billing on): the change is skipped and audited as `member.sync_skipped`
 *   with reason `plan_limit`, and the sign-in goes on;
 * - the last owner of an organization is never demoted or removed (the change is skipped and
 *   audited as `member.sync_skipped`), so a mapping can never orphan an organization;
 * - superadmin is granted by a matching `{"role": "superadmin"}` rule and, with `remove`, revoked
 *   when no such group matches any more, except from the last superadmin of the instance.
 *
 * Every decision that changes something (or is skipped for the owner rules) is written to the
 * audit log with the provider as the actor.
 */
export async function applyGroupMapping(input: GroupMappingInput): Promise<GroupMappingResult> {
  const { payload, policy, groups, userId } = input
  const roles = new Map<string, Role>()
  if (policy.rules.length === 0) return { roles, changed: false }

  const desired = desiredRoles(policy.rules, groups)
  const orgIds = await resolveOrganizations(payload, policy.rules)
  const user = await payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    overrideAccess: true,
  })

  let rows = toMembershipData(user.organizations)
  const changes: Change[] = []
  const same = (a: unknown, b: unknown) => String(a) === String(b)
  const roleIn = (orgId: OrgId): Role | null => {
    const row = rows.find((r) => same(r.organization, orgId))
    return row && isRole(row.role) ? row.role : null
  }

  for (const [key, orgId] of orgIds) {
    const wanted = desired.roles.get(key) ?? null
    const current = roleIn(orgId)
    if (wanted && !current) {
      // A new membership takes a seat (#161): an organization whose plan is full is skipped (and
      // audited) instead of failing the sign-in. No-op without billing.
      if (!(await hasMemberSeat(payload, orgId))) {
        changes.push({ kind: 'seat_skipped', orgId, wanted })
        continue
      }
      roles.set(String(orgId), wanted)
      rows = [...rows, { id: undefined, organization: orgId, role: wanted }]
      changes.push({ kind: 'added', orgId, role: wanted })
      continue
    }
    if (wanted) roles.set(String(orgId), wanted)
    if (wanted && current && wanted !== current) {
      if (current === 'owner' && (await isLastOwner(payload, orgId))) {
        roles.set(String(orgId), current)
        changes.push({ kind: 'skipped', orgId, from: current, wanted })
        continue
      }
      rows = rows.map((r) => (same(r.organization, orgId) ? { ...r, role: wanted } : r))
      changes.push({ kind: 'role_changed', orgId, from: current, role: wanted })
    } else if (!wanted && current && policy.remove) {
      if (current === 'owner' && (await isLastOwner(payload, orgId))) {
        changes.push({ kind: 'skipped', orgId, from: current, wanted: null })
        continue
      }
      rows = rows.filter((r) => !same(r.organization, orgId))
      changes.push({ kind: 'removed', orgId, from: current })
    }
  }

  let superadmin: boolean | undefined
  if (desired.superadmin === true && user.superadmin !== true) {
    superadmin = true
    changes.push({ kind: 'superadmin', granted: true })
  } else if (desired.superadmin === false && user.superadmin === true && policy.remove) {
    if (await isLastSuperadmin(payload)) {
      changes.push({ kind: 'superadmin_skipped' })
    } else {
      superadmin = false
      changes.push({ kind: 'superadmin', granted: false })
    }
  }

  const writes = changes.filter(
    (c) => c.kind !== 'skipped' && c.kind !== 'seat_skipped' && c.kind !== 'superadmin_skipped',
  )
  if (writes.length > 0) {
    await payload.update({
      collection: 'users',
      id: user.id,
      data: {
        organizations: rows as User['organizations'],
        ...(superadmin === undefined ? {} : { superadmin }),
      },
      depth: 0,
      overrideAccess: true,
      context: { skipOwnerMembership: true },
    })
    log.info(
      { user: user.id, provider: input.provider.id, changes: writes.map((c) => c.kind) },
      'applied identity-provider group mapping',
    )
  }

  for (const change of changes) await auditChange(input, user, change)
  return { roles, changed: writes.length > 0 }
}

async function auditChange(input: GroupMappingInput, user: User, change: Change): Promise<void> {
  const base = {
    actorType: 'system' as const,
    actorId: `sso:${input.provider.id}`,
    actorLabel: input.provider.name,
    target: auditTarget('users', user.id),
    entityId: user.id,
    entityLabel: user.email,
  }
  const metadata = {
    source: 'sso_group_mapping',
    provider: input.provider.id,
    groups: input.groups.slice(0, 50),
  }
  let event: {
    action: AuditAction
    organization: OrgId | null
    entityType: 'member' | 'user'
    before: Record<string, string | boolean | null> | null
    after: Record<string, string | boolean | null> | null
    changedFields: string[] | null
    metadata: Record<string, unknown>
  }
  switch (change.kind) {
    case 'added':
      event = {
        action: 'member.added',
        organization: change.orgId,
        entityType: 'member',
        before: null,
        after: { role: change.role },
        changedFields: null,
        metadata,
      }
      break
    case 'role_changed':
      event = {
        action: 'member.role_changed',
        organization: change.orgId,
        entityType: 'member',
        before: { role: change.from },
        after: { role: change.role },
        changedFields: ['role'],
        metadata: { ...metadata, role: change.role },
      }
      break
    case 'removed':
      event = {
        action: 'member.removed',
        organization: change.orgId,
        entityType: 'member',
        before: { role: change.from },
        after: null,
        changedFields: null,
        metadata,
      }
      break
    case 'skipped':
      event = {
        action: 'member.sync_skipped',
        organization: change.orgId,
        entityType: 'member',
        before: { role: change.from },
        after: { role: change.wanted },
        changedFields: null,
        metadata: { ...metadata, reason: 'last_owner' },
      }
      break
    case 'seat_skipped':
      event = {
        action: 'member.sync_skipped',
        organization: change.orgId,
        entityType: 'member',
        before: null,
        after: { role: change.wanted },
        changedFields: null,
        metadata: { ...metadata, reason: 'plan_limit' },
      }
      break
    case 'superadmin':
      event = {
        action: change.granted ? 'user.superadmin_granted' : 'user.superadmin_revoked',
        organization: null,
        entityType: 'user',
        before: { superadmin: !change.granted },
        after: { superadmin: change.granted },
        changedFields: ['superadmin'],
        metadata,
      }
      break
    case 'superadmin_skipped':
      event = {
        action: 'user.sync_skipped',
        organization: null,
        entityType: 'user',
        before: { superadmin: true },
        after: { superadmin: false },
        changedFields: null,
        metadata: { ...metadata, reason: 'last_superadmin' },
      }
      break
  }
  await recordRequestAuditEvent(input.payload, input.request, { ...base, ...event })
}
