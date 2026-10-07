# MCP server for AI agents

Marmot speaks the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), so AI assistants such as
Claude, Cursor or VS Code Copilot can answer "is the API down?", read uptime figures, post an incident
update or schedule a maintenance window for you.

| What           | Value                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| Endpoint       | `https://<your Marmot>/api/mcp`                                                        |
| Transport      | Streamable HTTP, **stateless** (JSON responses, no session id; `GET`/`DELETE` → `405`) |
| Authentication | an organization API key: `Authorization: Bearer mk_…` (or `X-API-Key: mk_…`)           |
| Discovery      | `GET /.well-known/mcp.json` (endpoint, auth scheme, tool list)                         |

The server acts for exactly one organization: the one that owns the key. There are no organization ids to
pass around.

## Create a key

Admins and owners create keys under **Settings → API keys** ([Integrations](Integrations.md#api-keys)).
Pick the scope deliberately:

- **read** — the agent can look but not touch. Mutation tools are not even listed. Read keys act as an
  organization `viewer`, so notification channels (a `member` permission) are hidden too.
- **write** — the agent can also pause and resume monitors, run checks, open, update and resolve status
  page incidents, acknowledge and resolve monitor incidents and schedule maintenance (it acts as a
  `member`). It can never manage members, keys, SSO, webhooks or billing.

Tools whose permission the key's role does not hold, after the organization's
[permission overrides](Organizations-and-Members.md), are not listed either.

## Connect a client

Replace the URL and the key with yours. Keep keys out of shared config files; most clients read
environment variables.

### Claude Code

```sh
claude mcp add --transport http marmot https://marmot.example.com/api/mcp \
  --header "Authorization: Bearer $MARMOT_API_KEY"
```

Or in `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "marmot": {
      "type": "http",
      "url": "https://marmot.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${MARMOT_API_KEY}" }
    }
  }
}
```

### Claude Desktop

Claude Desktop's config file starts local (stdio) servers, so bridge to the remote endpoint with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "marmot": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://marmot.example.com/api/mcp",
        "--header",
        "Authorization:${MARMOT_AUTH}"
      ],
      "env": { "MARMOT_AUTH": "Bearer mk_…" }
    }
  }
}
```

(The header value is passed through an environment variable because some platforms mangle spaces in
arguments.) Custom connectors added in the Claude apps' settings need OAuth, which Marmot does not offer
yet.

### Cursor, VS Code and others

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "marmot": {
      "url": "https://marmot.example.com/api/mcp",
      "headers": { "Authorization": "Bearer mk_…" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "marmot": {
      "type": "http",
      "url": "https://marmot.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${input:marmot-key}" }
    }
  },
  "inputs": [
    {
      "id": "marmot-key",
      "type": "promptString",
      "description": "Marmot API key",
      "password": true
    }
  ]
}
```

Any other client that supports Streamable HTTP with custom headers works the same way. To try the server
by hand, run `npx @modelcontextprotocol/inspector`, choose _Streamable HTTP_, enter the URL and add the
`Authorization` header.

## Tools

| Tool                           | Scope | What it does                                                                                               |
| ------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------- |
| `list_monitors`                | read  | Monitors with status, last check and response time; filter by `type`, `active`; paginated                  |
| `get_monitor`                  | read  | Full configuration and status cache of one monitor                                                         |
| `get_monitor_status`           | read  | Current status (up, down, degraded, pending, maintenance, paused), last check, message                     |
| `get_monitor_stats`            | read  | Uptime (0..1), average response time and degraded checks over `24h`, `30d` or `1y`                         |
| `list_heartbeats`              | read  | Latest check results, newest first; `status`, `importantOnly` (status changes) and `limit`                 |
| `list_status_pages`            | read  | Status pages, drafts included                                                                              |
| `list_components`              | read  | Components of a status page by group, with the `componentId` that incident tools take                      |
| `list_incidents`               | read  | Status page incidents of one page or of all pages, newest first; `activeOnly`                              |
| `list_maintenance`             | read  | Maintenance windows with status and upcoming windows                                                       |
| `list_notification_channels`   | read  | Notification channels (name, type, default, active; never secrets); needs the `member` role                |
| `list_monitor_incidents`       | read  | Outages detected by monitors (open, acknowledged, resolved) with MTTA/MTTR; `status`, `monitorId`, `range` |
| `get_monitor_incident`         | read  | One monitor incident with its timeline                                                                     |
| `check_monitor_now`            | write | Run a check now and return its result (`wait: false` only queues it); paused and push monitors refuse      |
| `pause_monitor`                | write | Stop checking a monitor                                                                                    |
| `resume_monitor`               | write | Start checking it again                                                                                    |
| `create_incident`              | write | Open an incident with a first update (status, message, affected components and their impact)               |
| `add_incident_update`          | write | Post an update (`investigating`, `identified`, `monitoring`, `resolved`); subscribers are notified         |
| `resolve_incident`             | write | Post a `resolved` update; affected components return to operational                                        |
| `acknowledge_monitor_incident` | write | Acknowledge an open monitor incident (optional `note`): reminders stop, channels are told                  |
| `resolve_monitor_incident`     | write | Resolve a monitor incident by hand (optional `note`)                                                       |
| `create_maintenance`           | write | Schedule maintenance; takes the same fields as the maintenance form                                        |

Tool input schemas are the management API's own zod validators (for example `create_maintenance` uses
`maintenanceFormSchema`), so an agent gets the same validation messages as the REST API. Read-only tools
carry `readOnlyHint`; write tools carry `destructiveHint: false`.

## How it works

`src/app/api/mcp/route.ts` hands every request to `handleMcpRequest` (`src/server/mcp/handler.ts`):

1. The API key is verified (`401` with `WWW-Authenticate: Bearer` when it is missing, unknown, disabled or
   expired) and one request of its `API_KEY_RATE_LIMIT` budget is spent (`429` with `Retry-After` when it
   is used up, [Configuration](Configuration.md#authentication)).
2. A fresh `McpServer` (official TypeScript SDK) is built with the tools the key may use and answers the
   JSON-RPC message over the SDK's web-standard Streamable HTTP transport.
3. Each tool call runs the matching [management API](Integrations.md#management-api) route handler
   in-process (`src/server/mcp/dispatch.ts`). The request is marked as delegated by the key, so
   `authenticateRequest` applies the very same organization, scope and permission rules and spends the
   write budget (`API_KEY_WRITE_RATE_LIMIT`) for mutations. Other limits of the route apply too (for
   example `ON_DEMAND_CHECKS_PER_MINUTE` for `check_monitor_now`). Every change is recorded in the
   [audit log](Security.md#audit-log) with actor type `mcp`, the key as actor and a label naming the key
   and the tool (`ci-agent · pause_monitor`). There is no MCP-specific business logic to drift from the
   REST API.

Because authentication is a bearer key and never a cookie, browser-borne attacks such as DNS rebinding
cannot borrow a signed-in session; there is no Origin allow-list.

## Limitations

- No OAuth 2.1 authorization yet, so clients that only support OAuth (custom connectors in the Claude
  apps) cannot connect directly; use `mcp-remote` or a client that sends headers.
- No resources, prompts or server-sent notifications: the endpoint is stateless request/response.
- The audit log is not exposed: API keys cannot read it ([Integrations](Integrations.md#management-api)).
