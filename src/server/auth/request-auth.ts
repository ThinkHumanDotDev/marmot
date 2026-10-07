/**
 * The one place Marmot's route handlers authenticate a request (#115).
 *
 * Every helper the `/api/orgs/:orgId/**` handlers use (`resolveOrgRequest`, the `authenticate`
 * functions of `src/server/monitors/http.ts` and `src/server/status-pages/http.ts`,
 * `getRequestContext`, `billingContext`, and through them `resolveCheckActor`, `ownerContext`, …)
 * calls `authenticateRequest`. It accepts:
 *
 * - a Payload session (cookie, or `Authorization: JWT …`), exactly as before; Payload's CSRF
 *   allowlist still applies to cookies;
 * - on organization routes (`/api/orgs/:orgId/…`) only, an organization API key
 *   (`Authorization: Bearer mk_…` or `X-API-Key: mk_…`). The key becomes a synthetic principal with
 *   a single membership — `viewer` for `read` keys, `member` for `write` keys — so the permission
 *   checks and collection access that already guard every route apply unchanged. No cookie is
 *   involved, so no Origin check applies either.
 *
 * Keys are further limited here, before any handler code runs:
 * - the key must belong to the organization in the URL;
 * - `read` keys may only send `GET`/`HEAD`/`OPTIONS`;
 * - member, invitation, key, SSO, billing, permission and ownership routes are refused outright
 *   (`API_KEY_FORBIDDEN_SECTIONS`), and `API_KEY_DENIED_PERMISSIONS` keeps collection access in line;
 * - requests are rate limited per key (`API_KEY_RATE_LIMIT`, `API_KEY_WRITE_RATE_LIMIT`), `429` with
 *   `Retry-After`;
 * - write requests are recorded in the audit log (`api_key.write_request`, `actorType: apiKey`).
 *
 * The MCP endpoint (`/api/mcp`, #119) authenticates the key itself and then calls these very route
 * handlers in-process with a *delegated* request (`delegateApiKeyRequest`): the key lookup and the
 * request budget are skipped (the MCP request already paid them), every other rule above applies,
 * and audit events carry `actorType: mcp` and the tool name.
 */
import type { Payload } from 'payload'

import type { OrgId } from '@/access/permissions'
import { API_KEY_SCOPE_ROLES, type ApiKeyScope } from '@/lib/api-key-scopes'
import type { User } from '@/payload-types'
import { authenticateApiKeyValue, extractApiKey, type ApiKeyAuth } from '@/server/api-keys'
import { errorText, rememberRequestUser } from '@/server/request-locale'
import { auditActorFields, recordRequestAuditEvent } from '@/server/security/audit'
import { apiKeyLimiter, apiKeyWriteLimiter } from '@/server/security/limiters'
import { tooManyRequests, type RateLimiter } from '@/server/security/rate-limit'

export type RequestUser = User & { collection: 'users' }

/** What an API key principal carries about its key (`user.apiKey`). */
export interface ApiKeyPrincipalInfo {
  id: string
  prefix: string
  name: string
  scope: ApiKeyScope
  organization: OrgId
  /** Set when the key acts through the MCP endpoint (`src/server/mcp`). */
  via?: 'mcp'
  /** The MCP tool a delegated request runs for (audit metadata). */
  tool?: string
}

/**
 * The synthetic user an API key authenticates as. Its `id` (`api-key:<keyId>`) is not a user row:
 * code that stores "who did it" must use `auditActorFields` / `apiKeyOf` instead of `user.id`.
 */
export type ApiKeyPrincipal = RequestUser & { apiKey: ApiKeyPrincipalInfo }

export type RequestAuth =
  { user: RequestUser | null; response?: undefined } | { user?: undefined; response: Response }

/** Sections below `/api/orgs/:orgId/` that API keys may never call, whatever their scope. */
export const API_KEY_FORBIDDEN_SECTIONS: readonly string[] = [
  'api-keys',
  'billing',
  'invitations',
  'invite-link',
  'members',
  'permissions',
  'sso',
  'transfer-ownership',
]

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** `true` for methods that change state (and need a `write` key). */
export const isWriteMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase())

const ORG_PATH = /^\/api\/orgs\/([^/]+)(?:\/([^/]+))?/

/** `{ orgId, section }` of an `/api/orgs/:orgId/<section>/…` URL, or `null` for other paths. */
export function orgRouteOf(request: Request): { orgId: string; section: string | null } | null {
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return null
  }
  const match = ORG_PATH.exec(pathname)
  if (!match || match[1] === 'slug-available') return null
  return { orgId: decodeURIComponent(match[1]), section: match[2] ?? null }
}

/** The key behind an API key principal, or `null` for users and anonymous requests. */
export function apiKeyOf(user: unknown): ApiKeyPrincipalInfo | null {
  const info = (user as { apiKey?: ApiKeyPrincipalInfo } | null | undefined)?.apiKey
  return info ?? null
}

/** Builds the synthetic principal for a verified key. */
export function apiKeyPrincipal(auth: ApiKeyAuth): ApiKeyPrincipal {
  const { apiKey, organizationId, scope } = auth
  const info: ApiKeyPrincipalInfo = {
    id: String(apiKey.id),
    prefix: apiKey.prefix,
    name: apiKey.name,
    scope,
    organization: organizationId,
  }
  return {
    id: `api-key:${String(apiKey.id)}`,
    collection: 'users',
    email: `api-key-${apiKey.prefix.toLowerCase()}@api-keys.invalid`,
    name: apiKey.name,
    superadmin: false,
    organizations: [{ organization: organizationId, role: API_KEY_SCOPE_ROLES[scope] }],
    createdAt: apiKey.createdAt,
    updatedAt: apiKey.updatedAt,
    apiKey: info,
  } as unknown as ApiKeyPrincipal
}

const keyError = (request: Request, status: number, key: Parameters<typeof errorText>[1]) =>
  Response.json(
    { errors: [{ message: errorText(request, key) }] },
    {
      status,
      headers:
        status === 401 ? { 'WWW-Authenticate': 'Bearer realm="marmot", charset="UTF-8"' } : {},
    },
  )

export interface ApiKeyLimiters {
  all: RateLimiter | null
  write: RateLimiter | null
}

const defaultLimiters: ApiKeyLimiters = { all: apiKeyLimiter, write: apiKeyWriteLimiter }

/** Spend the key's request (and, for writes, write) budget; a `429` response when it is used up. */
export async function consumeApiKeyBudget(
  request: Request,
  keyId: string,
  write: boolean,
  limiters: ApiKeyLimiters = defaultLimiters,
): Promise<Response | null> {
  if (limiters.all) {
    const decision = await limiters.all.consume(keyId)
    if (!decision.allowed) return tooManyRequests(decision, request)
  }
  if (write && limiters.write) {
    const decision = await limiters.write.consume(keyId)
    if (!decision.allowed) return tooManyRequests(decision, request)
  }
  return null
}

async function authenticateWithApiKey(
  payload: Payload,
  request: Request,
  key: string,
  route: { orgId: string; section: string | null },
): Promise<RequestAuth> {
  const auth = await authenticateApiKeyValue(payload, key)
  if (!auth) return { response: keyError(request, 401, 'apiKeyInvalid') }

  const principal = apiKeyPrincipal(auth)
  rememberRequestUser(request, principal)

  const limited = await consumeApiKeyBudget(
    request,
    principal.apiKey.id,
    isWriteMethod(request.method),
  )
  if (limited) return { response: limited }

  return authorizeApiKeyRoute(payload, request, principal, route)
}

/** The org/section/scope rules of the module comment, and the audit event of a write. */
async function authorizeApiKeyRoute(
  payload: Payload,
  request: Request,
  principal: ApiKeyPrincipal,
  route: { orgId: string; section: string | null },
): Promise<RequestAuth> {
  const { apiKey } = principal
  const write = isWriteMethod(request.method)

  if (String(apiKey.organization) !== route.orgId) {
    return { response: keyError(request, 403, 'apiKeyWrongOrganization') }
  }
  if (route.section === null || API_KEY_FORBIDDEN_SECTIONS.includes(route.section)) {
    return { response: keyError(request, 403, 'apiKeyRouteForbidden') }
  }
  if (write && apiKey.scope !== 'write') {
    return { response: keyError(request, 403, 'apiKeyReadOnly') }
  }

  if (write) {
    const who = auditActorFields(principal)
    await recordRequestAuditEvent(payload, request, {
      action: 'api_key.write_request',
      organization: apiKey.organization,
      actor: who.actor,
      target: `api-keys:${apiKey.id}`,
      metadata: {
        ...who.metadata,
        method: request.method.toUpperCase(),
        path: new URL(request.url).pathname,
      },
    })
  }

  return { user: principal }
}

/**
 * In-process requests that act for an already authenticated API key (the MCP endpoint). A
 * `WeakMap` keyed by the `Request` object: only server code holding the very object can mark it, so
 * no header a client sends can claim to be delegated.
 */
const delegatedRequests = new WeakMap<Request, ApiKeyPrincipal>()

/**
 * Mark `request` (built in-process, aimed at an `/api/orgs/:orgId/…` route handler) as sent by
 * `principal`. `authenticateRequest` then skips the key lookup and the request budget, which the
 * caller already spent, but still applies the organization, section and scope rules, spends the
 * write budget for mutations and records writes in the audit log.
 */
export function delegateApiKeyRequest(request: Request, principal: ApiKeyPrincipal): Request {
  delegatedRequests.set(request, principal)
  return request
}

async function authenticateDelegated(
  payload: Payload,
  request: Request,
  principal: ApiKeyPrincipal,
  route: { orgId: string; section: string | null } | null,
): Promise<RequestAuth> {
  rememberRequestUser(request, principal)
  if (!route) return { response: keyError(request, 403, 'apiKeyRouteForbidden') }
  if (isWriteMethod(request.method)) {
    const limited = await consumeApiKeyBudget(request, principal.apiKey.id, true, {
      all: null,
      write: apiKeyWriteLimiter,
    })
    if (limited) return { response: limited }
  }
  return authorizeApiKeyRoute(payload, request, principal, route)
}

/**
 * Authenticate `request` (see the module comment). Returns the user — a real user, an API key
 * principal, or `null` when the request carries neither — or a ready `Response` (401, 403, 429) when
 * an API key was sent but may not make this request. Callers keep answering `401` for `null`.
 */
export async function authenticateRequest(
  payload: Payload,
  request: Request,
): Promise<RequestAuth> {
  const route = orgRouteOf(request)
  const delegated = delegatedRequests.get(request)
  if (delegated) return authenticateDelegated(payload, request, delegated, route)

  const key = route ? extractApiKey(request.headers) : null
  if (route && key) return authenticateWithApiKey(payload, request, key, route)

  const { user } = await payload.auth({ headers: request.headers })
  if (!user || user.collection !== 'users') return { user: null }
  rememberRequestUser(request, user as RequestUser)
  return { user: user as RequestUser }
}

/**
 * The id to store in a `users` relationship (`createdBy`, `approvedBy`, …) for the request
 * principal: the user's id, or `null` for API keys, which are not user rows.
 */
export function principalUserId(user: { id: unknown } | null | undefined): OrgId | null {
  if (!user || apiKeyOf(user)) return null
  return user.id as OrgId
}
