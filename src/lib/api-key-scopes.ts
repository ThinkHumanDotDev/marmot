/**
 * Scopes of organization API keys (#115). Kept dependency-free so the collection, the server and the
 * settings UI share one list.
 *
 * - `read`: `GET` requests only; the key acts as an organization `viewer`.
 * - `write`: every request a `member` may make (create, update and delete monitors, status pages,
 *   incidents and maintenance). Never member, key, SSO, billing or ownership management.
 */
export const API_KEY_SCOPES = ['read', 'write'] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

/** The organization role a key of `scope` acts with. */
export const API_KEY_SCOPE_ROLES = { read: 'viewer', write: 'member' } as const satisfies Record<
  ApiKeyScope,
  'viewer' | 'member'
>
