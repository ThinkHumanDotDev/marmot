/**
 * `/.well-known/mcp.json` (#119): where Marmot's MCP endpoint lives, how to authenticate and which
 * tools it offers, so clients and registries can discover it without reading the docs.
 */
import { MCP_INSTRUCTIONS, MCP_SERVER_NAME, MCP_SERVER_TITLE, MCP_SERVER_VERSION } from './server'
import { MCP_TOOLS } from './tools'

export const MCP_PATH = '/api/mcp'

export function mcpDiscoveryDocument(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    serverInfo: { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: MCP_SERVER_VERSION },
    description: MCP_INSTRUCTIONS,
    transport: { type: 'streamable-http', url: `${base}${MCP_PATH}`, stateless: true },
    authentication: {
      required: true,
      schemes: ['bearer'],
      description:
        'An organization API key (Settings → API keys) as Authorization: Bearer mk_…. Keys with the read scope only see read-only tools.',
    },
    capabilities: { tools: {} },
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      scope: tool.scope,
    })),
    documentation: 'https://github.com/ThinkHumanDotDev/marmot/blob/main/docs/MCP.md',
  }
}
