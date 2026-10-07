import { z } from 'zod'

/**
 * Identity-provider groups (single sign-on): parsing of the `OIDC_*` group settings and the pure
 * part of the allow-list and the group → role mapping, shared by the instance-wide OIDC provider
 * and the organizations' SSO connections (`src/server/sso/group-mapping.ts` applies the result).
 *
 * Kept free of server imports so `src/env.ts` can validate `OIDC_ROLE_MAPPING` at startup.
 */

/** Organization roles a group can map to (same order and names as `src/access/permissions.ts`). */
export const GROUP_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type GroupRole = (typeof GROUP_ROLES)[number]

const RANK: Record<GroupRole, number> = { owner: 400, admin: 300, member: 200, viewer: 100 }

/** Groups are compared case-insensitively, without surrounding whitespace. */
export const normalizeGroup = (value: string): string => value.trim().toLowerCase()

/** `"marmot-users, SRE"` → `['marmot-users', 'sre']` (empty entries dropped, duplicates removed). */
export function parseGroupList(value: string | null | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split(',').map(normalizeGroup).filter(Boolean))]
}

/** Where a group puts its members: an organization (by slug or id) with a role, or superadmin. */
export type GroupRule =
  | { group: string; org: { slug: string } | { id: string | number }; role: GroupRole }
  | { group: string; superadmin: true }

const orgRuleSchema = z.object({
  org: z.string().trim().min(1, 'org must be an organization slug'),
  role: z.enum(GROUP_ROLES),
})
const superadminRuleSchema = z.object({ role: z.literal('superadmin') })
const ruleSchema = z.union([orgRuleSchema.strict(), superadminRuleSchema.strict()])

/**
 * `OIDC_ROLE_MAPPING`: a JSON object from group name to one rule or a list of rules.
 *
 * ```json
 * { "platform-admins": { "org": "acme", "role": "admin" },
 *   "sre": [{ "org": "acme", "role": "member" }, { "org": "ops", "role": "viewer" }],
 *   "marmot-admins": { "role": "superadmin" } }
 * ```
 */
export const roleMappingSchema = z
  .string()
  .default('')
  .transform((value, ctx): GroupRule[] => {
    if (!value.trim()) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON object' })
      return z.NEVER
    }
    const shape = z.record(z.string(), z.union([ruleSchema, z.array(ruleSchema)])).safeParse(parsed)
    if (!shape.success) {
      const issue = shape.error.issues[0]
      ctx.addIssue({
        code: 'custom',
        message: `${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'invalid mapping'} (expected {"<group>": {"org": "<slug>", "role": "owner|admin|member|viewer"} or {"role": "superadmin"}})`,
      })
      return z.NEVER
    }
    const rules: GroupRule[] = []
    for (const [group, value] of Object.entries(shape.data)) {
      const name = normalizeGroup(group)
      if (!name) continue
      for (const rule of Array.isArray(value) ? value : [value]) {
        rules.push(
          'org' in rule
            ? { group: name, org: { slug: rule.org.toLowerCase() }, role: rule.role }
            : { group: name, superadmin: true },
        )
      }
    }
    return rules
  })

/**
 * The groups an identity provider asserted, normalised; `null` when the claim / attribute is
 * absent (as opposed to present and empty). `claim` may be a dotted path into nested claims
 * (Keycloak's `realm_access.roles`); a key that literally contains dots wins. Values may be a list,
 * a single string, or a comma-separated string.
 */
export function extractGroups(raw: Record<string, unknown>, claim: string): string[] | null {
  let value: unknown = Object.prototype.hasOwnProperty.call(raw, claim) ? raw[claim] : undefined
  if (value === undefined && claim.includes('.')) {
    value = claim.split('.').reduce<unknown>((node, key) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
      return Object.prototype.hasOwnProperty.call(node, key)
        ? (node as Record<string, unknown>)[key]
        : undefined
    }, raw)
  }
  if (value === undefined || value === null) return null
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value]
  return [
    ...new Set(
      items
        .filter(
          (item): item is string | number => typeof item === 'string' || typeof item === 'number',
        )
        .map((item) => normalizeGroup(String(item)))
        .filter(Boolean),
    ),
  ]
}

export type GroupAccess = { ok: true } | { ok: false; code: 'groups_missing' | 'group_not_allowed' }

/**
 * The allow-list decision. An empty allow-list lets everybody in. A non-empty one needs at least
 * one of its groups among the asserted ones; an identity without the claim at all is refused with
 * its own code so administrators can tell a missing claim from a missing membership.
 */
export function checkGroupAccess(allowed: string[], groups: string[] | null): GroupAccess {
  if (allowed.length === 0) return { ok: true }
  if (groups === null) return { ok: false, code: 'groups_missing' }
  const set = new Set(groups)
  return allowed.some((group) => set.has(group))
    ? { ok: true }
    : { ok: false, code: 'group_not_allowed' }
}

/** Key of a rule's organization: `slug:<slug>` or `id:<id>`. */
export const orgKey = (org: { slug: string } | { id: string | number }): string =>
  'slug' in org ? `slug:${org.slug}` : `id:${String(org.id)}`

export interface DesiredRoles {
  /** Highest role per organization (`orgKey`) among the rules whose group the user is in. */
  roles: Map<string, GroupRole>
  /** Every organization some rule names (the ones the mapping manages). */
  managed: Set<string>
  /** `true` when a superadmin rule matched; `null` when no rule maps superadmin at all. */
  superadmin: boolean | null
}

/** What the mapping wants for a user in `groups`: the highest role wins per organization. */
export function desiredRoles(rules: GroupRule[], groups: string[]): DesiredRoles {
  const set = new Set(groups)
  const roles = new Map<string, GroupRole>()
  const managed = new Set<string>()
  let superadmin: boolean | null = null
  for (const rule of rules) {
    if ('superadmin' in rule) {
      superadmin = superadmin === true || set.has(rule.group)
      continue
    }
    const key = orgKey(rule.org)
    managed.add(key)
    if (!set.has(rule.group)) continue
    const current = roles.get(key)
    if (!current || RANK[rule.role] > RANK[current]) roles.set(key, rule.role)
  }
  return { roles, managed, superadmin }
}
