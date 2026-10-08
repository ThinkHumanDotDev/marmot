/**
 * The MCP endpoint (`/api/mcp`, #119): stateless Streamable HTTP, authenticated with an
 * organization API key (`Authorization: Bearer mk_…` or `X-API-Key`).
 *
 * Each `POST` authenticates the key, spends one request of its budget (`API_KEY_RATE_LIMIT`) and is
 * answered by a fresh MCP server whose tools call the management API in-process
 * (`src/server/mcp/dispatch.ts`); mutations additionally spend the write budget and are audited
 * with `actorType: mcp`. No session is kept, so `GET` (server-sent event stream) and `DELETE`
 * (session end) answer `405`.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { loadOrgPermissionOverrides } from '@/access/overrides'
import { childLogger } from '@/lib/logger'
import { authenticateApiKeyValue, extractApiKey } from '@/server/api-keys'
import { apiKeyPrincipal, consumeApiKeyBudget } from '@/server/auth/request-auth'
import type { ErrorKey } from '@/server/errors'
import { errorText, rememberRequestUser } from '@/server/request-locale'

import { createMcpServer } from './server'

const log = childLogger('mcp')

/** JSON-RPC error codes the SDK uses for transport-level failures. */
const UNAUTHORIZED = -32001
const SERVER_ERROR = -32603

function rpcError(
  request: Request,
  status: number,
  key: ErrorKey,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: {
        code: status === 401 ? UNAUTHORIZED : SERVER_ERROR,
        message: errorText(request, key),
      },
      id: null,
    },
    { status, headers },
  )
}

const unauthorized = (request: Request, key: ErrorKey) =>
  rpcError(request, 401, key, {
    'WWW-Authenticate': 'Bearer realm="marmot", error="invalid_token"',
  })

/** Rebuild a `429` from the shared limiter as a JSON-RPC error, keeping its rate limit headers. */
async function asRpcError(response: Response): Promise<Response> {
  const body = (await response.json().catch(() => null)) as {
    errors?: { message?: string }[]
  } | null
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: SERVER_ERROR, message: body?.errors?.[0]?.message ?? 'Too many requests' },
      id: null,
    },
    { status: response.status, headers: response.headers },
  )
}

export async function handleMcpRequest(
  request: Request,
  options: { payload?: Payload } = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return rpcError(request, 405, 'mcpMethodNotAllowed', { Allow: 'POST' })
  }

  const key = extractApiKey(request.headers)
  if (!key) return unauthorized(request, 'mcpApiKeyRequired')

  const payload = options.payload ?? (await getPayload({ config }))
  const auth = await authenticateApiKeyValue(payload, key)
  if (!auth) return unauthorized(request, 'apiKeyInvalid')

  const principal = apiKeyPrincipal(auth)
  rememberRequestUser(request, principal)
  const limited = await consumeApiKeyBudget(request, principal.apiKey.id, false)
  if (limited) return asRpcError(limited)

  const server = createMcpServer(
    {
      principal,
      origin: new URL(request.url).origin,
      acceptLanguage: request.headers.get('accept-language'),
    },
    await loadOrgPermissionOverrides(payload, principal.apiKey.organization),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request, {
      authInfo: {
        token: key,
        clientId: `api-key:${principal.apiKey.id}`,
        scopes: [principal.apiKey.scope],
      },
    })
  } catch (err) {
    log.error({ err, apiKeyId: principal.apiKey.id }, 'MCP request failed')
    return rpcError(request, 500, 'unexpected')
  } finally {
    await server.close().catch(() => undefined)
  }
}
