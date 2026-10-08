/**
 * Builds the MCP server for one request (#119). The endpoint is stateless: every HTTP request gets
 * a fresh `McpServer` with the tools the authenticating key's scope allows.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { PermissionOverrides } from '@/access/permissions'
import { MARMOT_VERSION } from '@/lib/version'

import type { DispatchContext } from './dispatch'
import { toolsFor } from './tools'

export const MCP_SERVER_NAME = 'marmot'
export const MCP_SERVER_TITLE = 'Marmot'
export const MCP_SERVER_VERSION: string = MARMOT_VERSION

export const MCP_INSTRUCTIONS = [
  'Marmot is a status monitor. This server acts for one organization: the one that owns the API key.',
  'Monitors check websites and services; their status is up, down, degraded, pending, maintenance or paused.',
  'Status pages show components (monitors grouped on the page) and incidents with a timeline of updates.',
  'Start with list_monitors or list_status_pages to find ids. Incident updates and new incidents notify the',
  "status page's subscribers, so confirm wording with the user before posting them.",
].join(' ')

export function createMcpServer(
  ctx: DispatchContext,
  permissionOverrides: PermissionOverrides = {},
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  )
  const org = { id: ctx.principal.apiKey.organization, permissionOverrides }
  for (const tool of toolsFor(ctx.principal, org)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      // The SDK validates `args` against `inputSchema` before calling.
      ((args: never) => tool.run(args, ctx)) as never,
    )
  }
  return server
}
