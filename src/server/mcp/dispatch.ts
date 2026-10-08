/**
 * Runs a management API route handler in-process on behalf of an MCP tool call (#119).
 *
 * MCP tools do not re-implement anything: each one builds a `Request` for the route it maps to
 * (`/api/orgs/:orgId/…`), marks it as delegated by the API key that authenticated the MCP request
 * (`delegateApiKeyRequest`) and calls the route's exported handler. Authentication rules, scope
 * enforcement, permission checks, validation, the write budget and the audit log are therefore
 * exactly those of the REST API.
 */
import type { OrgId } from '@/access/permissions'
import { delegateApiKeyRequest, type ApiKeyPrincipal } from '@/server/auth/request-auth'

/** A Next.js route handler (`GET`/`POST`/… export of a `route.ts`). */
export type RouteHandler = (
  request: Request,
  context: { params: Promise<never> },
) => Promise<Response>

export interface DispatchContext {
  principal: ApiKeyPrincipal
  /** Origin the MCP request arrived on; delegated requests are built against it. */
  origin: string
  /** `Accept-Language` of the MCP request, so route errors use the client's language. */
  acceptLanguage?: string | null
}

export interface RouteCall {
  tool: string
  handler: RouteHandler
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Path below `/api/orgs/:orgId/`, e.g. `monitors/12/pause`. */
  path: string
  /** Route params besides `orgId`. */
  params?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
}

export type RouteResult =
  { ok: true; status: number; data: unknown } | { ok: false; status: number; message: string }

export const orgIdOf = (principal: ApiKeyPrincipal): OrgId => principal.apiKey.organization

/** The first error message of a management API error body (`{ errors: [{ message, data }] }`). */
function errorMessage(data: unknown, status: number): string {
  const errors = (data as { errors?: { message?: unknown; data?: unknown }[] } | null)?.errors
  const first = Array.isArray(errors) ? errors[0] : undefined
  const message =
    typeof first?.message === 'string'
      ? first.message
      : typeof (data as { error?: unknown } | null)?.error === 'string'
        ? (data as { error: string }).error
        : `HTTP ${status}`
  const issues = (first?.data as { issues?: { path?: string; message?: string }[] } | undefined)
    ?.issues
  if (!Array.isArray(issues) || issues.length === 0) return message
  return `${message}\n${issues.map((i) => `- ${i.path || '(body)'}: ${i.message ?? ''}`).join('\n')}`
}

/** Call `call.handler` as the key of `ctx`, with the tool name recorded on audit events. */
export async function callRoute(ctx: DispatchContext, call: RouteCall): Promise<RouteResult> {
  const orgId = String(orgIdOf(ctx.principal))
  const url = new URL(`/api/orgs/${encodeURIComponent(orgId)}/${call.path}`, ctx.origin)
  for (const [name, value] of Object.entries(call.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value))
  }

  const headers = new Headers({ accept: 'application/json' })
  if (ctx.acceptLanguage) headers.set('accept-language', ctx.acceptLanguage)
  if (call.body !== undefined) headers.set('content-type', 'application/json')

  const request = new Request(url, {
    method: call.method,
    headers,
    body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
  })
  const principal: ApiKeyPrincipal = {
    ...ctx.principal,
    apiKey: { ...ctx.principal.apiKey, via: 'mcp', tool: call.tool },
  }
  delegateApiKeyRequest(request, principal)

  const response = await call.handler(request, {
    params: Promise.resolve({ orgId, ...call.params }) as Promise<never>,
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    return { ok: false, status: response.status, message: errorMessage(data, response.status) }
  }
  return { ok: true, status: response.status, data }
}
