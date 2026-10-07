import { handleMcpRequest } from '@/server/mcp/handler'

export const dynamic = 'force-dynamic'

/**
 * `/api/mcp` — Marmot's Model Context Protocol server (stateless Streamable HTTP, #119).
 * Authenticated with an organization API key; see docs/MCP.md and `src/server/mcp`.
 */
export const POST = (request: Request) => handleMcpRequest(request)
export const GET = (request: Request) => handleMcpRequest(request)
export const DELETE = (request: Request) => handleMcpRequest(request)
