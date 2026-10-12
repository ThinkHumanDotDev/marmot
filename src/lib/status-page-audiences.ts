/**
 * Audiences of a status page (#151): named groups of viewers ("Acme Corp", "EU customers") who see
 * only some of the page's components, and only the incidents and maintenance that affect those.
 * Pure rules shared by the collection, the server-side filtering and the builder UI.
 *
 * Visibility rules (documented in docs/Status-Pages.md → Audiences):
 * - an audience lists component ids (group row ids of its page) and members (addresses and email
 *   domains); a viewer belongs to every audience that lists their address or its domain, and sees
 *   the union of those audiences' components;
 * - an incident is visible when it names (in any update, or in its current state) at least one
 *   visible component; an incident that names no component at all is page-wide and visible to every
 *   audience;
 * - a maintenance is visible when it covers at least one monitor of a visible component; one that
 *   covers no monitor is page-wide.
 */
import { isEmailInDomains } from './status-page-access'

/** Upper bounds, validated by the collection hook. */
export const MAX_AUDIENCES_PER_PAGE = 100
export const MAX_AUDIENCE_EMAILS = 500
export const MAX_AUDIENCE_DOMAINS = 50
export const MAX_AUDIENCE_NAME_LENGTH = 100

/** The parts of an audience the rules read. */
export interface AudienceRules {
  id: string | number
  components?: readonly (string | null | undefined)[] | null
  emails?: readonly (string | null | undefined)[] | null
  emailDomains?: readonly (string | null | undefined)[] | null
}

/** True when `email` (normalized) is a member of `audience`, by address or by domain. */
export function isAudienceMember(audience: AudienceRules, email: string): boolean {
  const address = email.trim().toLowerCase()
  if ((audience.emails ?? []).some((e) => typeof e === 'string' && e.toLowerCase() === address)) {
    return true
  }
  return isEmailInDomains(address, audience.emailDomains ?? [])
}

/** Union of the component ids of `audiences`. */
export function audienceComponents(audiences: readonly AudienceRules[]): Set<string> {
  const out = new Set<string>()
  for (const audience of audiences) {
    for (const id of audience.components ?? []) if (id) out.add(String(id))
  }
  return out
}

/** The parts of an incident the rules read. */
export interface IncidentComponentRefs {
  affectedComponents?: readonly ({ component?: string | null } | null | undefined)[] | null
  updates?:
    | readonly (
        | { components?: readonly ({ component?: string | null } | null | undefined)[] | null }
        | null
        | undefined
      )[]
    | null
}

/** Every component id an incident names, in its current state or in any update. */
export function incidentComponentIds(incident: IncidentComponentRefs): Set<string> {
  const ids = new Set<string>()
  for (const row of incident.affectedComponents ?? []) {
    if (row?.component) ids.add(String(row.component))
  }
  for (const update of incident.updates ?? []) {
    for (const row of update?.components ?? []) if (row?.component) ids.add(String(row.component))
  }
  return ids
}

/** True when an incident naming `named` components may be shown to viewers of `visible`. */
export function isVisibleToComponents(
  named: ReadonlySet<string>,
  visible: ReadonlySet<string>,
): boolean {
  if (named.size === 0) return true
  for (const id of named) if (visible.has(id)) return true
  return false
}

/**
 * Does an announcement about `affected` components reach a subscriber of an audience page?
 * `allowed` is the union of the subscriber's audiences' components; a subscriber without an
 * audience receives nothing. Page-wide announcements (no component) reach every audience; the
 * subscriber's own component choice applies within what their audiences may see.
 */
export function audienceSubscriberWants(
  subscribed: readonly string[] | null | undefined,
  allowed: ReadonlySet<string> | null,
  affected: readonly string[] | null | undefined,
): boolean {
  if (!allowed) return false
  const all = (affected ?? []).map(String)
  if (all.length === 0) return true
  const visible = all.filter((id) => allowed.has(id))
  if (visible.length === 0) return false
  if (!subscribed || subscribed.length === 0) return true
  const wanted = new Set(subscribed.map(String))
  return visible.some((id) => wanted.has(id))
}
