import { env } from '@/env'
import { mcpDiscoveryDocument } from '@/server/mcp/discovery'

export const dynamic = 'force-dynamic'

/** GET /.well-known/mcp.json — discovery document of the MCP endpoint (#119, docs/MCP.md). */
export function GET() {
  return Response.json(mcpDiscoveryDocument(env.NEXT_PUBLIC_SERVER_URL), {
    headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
  })
}
