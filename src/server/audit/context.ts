/**
 * Who performed an audited operation, and from where.
 *
 * Collection hooks only see Payload's `req`. For REST calls through Payload that request carries the
 * client's headers; route handlers under `src/app/api/**` call the Local API instead, whose `req`
 * has empty headers. Those handlers authenticate through `rememberRequestUser`, which binds the
 * client request's headers to the authenticated user object (`bindAuditRequest`). The Local API
 * reuses that very object as `req.user`, so `auditRequestMeta` can still report the client's IP
 * address (honouring `trustProxy`) and user agent.
 *
 * Kept free of `@payload-config` so `src/server/request-locale.ts` can import it.
 */
import type { AuditActorType } from './actions'

export type AuditId = string | number

export interface AuditActor {
  type: AuditActorType
  /** User or API key id as a string; `null` for the system. */
  id: string | null
  /** Snapshot shown in the UI even after the user or key is deleted (email, key name). */
  label: string | null
  /** Set for `type: 'user'`: the `actor` relationship. */
  userId: AuditId | null
}

/**
 * `req.context` key that overrides the actor derived from `req.user`, for code that acts on behalf
 * of an API key, an MCP client or a scheduled job (`context: { [AUDIT_ACTOR_CONTEXT]: actor }`).
 */
export const AUDIT_ACTOR_CONTEXT = 'marmotAuditActor'

/**
 * `req.context` key that turns the collection audit hooks off for an operation, for bulk writes
 * that record one summary event instead (imports) and for internal bookkeeping writes.
 */
export const AUDIT_SKIP_CONTEXT = 'marmotSkipAudit'

/** `req.context` key naming the verb of the next audited write (`cloned`), see `auditCollection`. */
export const AUDIT_VERB_CONTEXT = 'marmotAuditVerb'

/** `req.context` key with extra metadata for the next audited write (`{ sourceId }`). */
export const AUDIT_METADATA_CONTEXT = 'marmotAuditMetadata'

export const SYSTEM_ACTOR: AuditActor = Object.freeze({
  type: 'system',
  id: null,
  label: null,
  userId: null,
}) as AuditActor

const boundHeaders = new WeakMap<object, Headers>()

/** Remembers the client request behind `user` (the object the Local API receives as `user`). */
export function bindAuditRequest(user: unknown, request: { headers: Headers }): void {
  if (user && typeof user === 'object') boundHeaders.set(user, request.headers)
}

type RequestLike = {
  user?: unknown
  headers?: Headers
  context?: Record<string, unknown> | null
}

/** Headers of the client request behind `req`: the bound route request, else `req.headers`. */
export function auditHeaders(req: RequestLike | null | undefined): Headers {
  const user = req?.user
  const bound = user && typeof user === 'object' ? boundHeaders.get(user) : undefined
  return bound ?? req?.headers ?? new Headers()
}

const isActor = (value: unknown): value is AuditActor =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as AuditActor).type === 'string' &&
  'id' in (value as object)

/** Actor of an operation performed with an organization API key. */
export function apiKeyActor(apiKey: {
  id: AuditId
  name?: string | null
  prefix?: string | null
}): AuditActor {
  return {
    type: 'apiKey',
    id: String(apiKey.id),
    label: apiKey.name ?? (apiKey.prefix ? `mk_${apiKey.prefix}` : null),
    userId: null,
  }
}

/**
 * Actor of an operation an AI agent performed through the MCP endpoint (#119) with an API key; the
 * label names the key and the tool.
 */
export function mcpActor(apiKey: {
  id: AuditId
  name?: string | null
  prefix?: string | null
  tool?: string | null
}): AuditActor {
  const key = apiKeyActor(apiKey)
  return {
    ...key,
    type: 'mcp',
    label: apiKey.tool ? `${key.label ?? key.id} · ${apiKey.tool}` : key.label,
  }
}

/** Actor of a signed-in user. */
export function userActor(user: { id: AuditId; email?: string | null }): AuditActor {
  return { type: 'user', id: String(user.id), label: user.email ?? null, userId: user.id }
}

/**
 * The actor of the operation `req` belongs to:
 * 1. an explicit `req.context[AUDIT_ACTOR_CONTEXT]`;
 * 2. an API key principal — `req.user` from the `api-keys` collection, or a user-like object that
 *    carries the key as `apiKey` (how an API-key-authenticated route can present itself); `mcp`
 *    when the key acts through the MCP endpoint (`apiKey.via`);
 * 3. a signed-in user;
 * 4. otherwise the system (worker jobs, scheduled transitions, seeding).
 */
export function actorFromRequest(req: RequestLike | null | undefined): AuditActor {
  const override = req?.context?.[AUDIT_ACTOR_CONTEXT]
  if (isActor(override)) return override

  const user = req?.user as
    | {
        id?: AuditId
        email?: string | null
        name?: string | null
        prefix?: string | null
        collection?: string
        apiKey?: {
          id: AuditId
          name?: string | null
          prefix?: string | null
          via?: string
          tool?: string
        } | null
      }
    | null
    | undefined
  if (!user || user.id === undefined || user.id === null) return SYSTEM_ACTOR
  if (user.apiKey && typeof user.apiKey === 'object') {
    return user.apiKey.via === 'mcp' ? mcpActor(user.apiKey) : apiKeyActor(user.apiKey)
  }
  if (user.collection === 'api-keys') {
    return apiKeyActor({ id: user.id, name: user.name, prefix: user.prefix })
  }
  return userActor({ id: user.id, email: user.email })
}
