# Architecture

Marmot is a single TypeScript codebase that runs as three processes from one Docker image.

| Role       | Entrypoint        | Responsibilities                                                                                                           |
| ---------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `web`      | `next start`      | Marmot UI, Payload admin, REST/GraphQL, public status pages, badges, push, metrics                                         |
| `worker`   | `src/worker.ts`   | BullMQ job schedulers (one per monitor), check execution, heartbeat state machine, stats rollups, retention, notifications |
| `realtime` | `src/realtime.ts` | socket.io server; authenticates Payload sessions; joins users to `org:<id>` rooms                                          |

Shared infrastructure: the Payload database (Postgres by default, MongoDB supported, SQLite for dev) and Redis
(BullMQ queues + socket.io pub/sub). Caddy terminates TLS and routes `/socket.io/*` to `realtime`.

## Polling engine

Payload does not poll anything by itself. On `monitors` `afterChange`/`afterDelete` hooks the web process
calls `engine.sync(monitor)`, which upserts or removes a BullMQ **job scheduler** named `monitor:<id>` with
`every = interval * 1000`. The worker consumes the `checks` queue, runs the monitor type's `check()` and
feeds the result through the heartbeat state machine (ported from Uptime Kuma's `Monitor.beat`):

```
maintenance?  → MAINTENANCE
check ok      → UP
check failed  → retries < maxretries ? PENDING (scheduler switched to retryInterval) : DOWN
upsideDown    → flip UP/DOWN
```

Important beats (status transitions) trigger notifications; `resendInterval` re-notifies while down.

## Time-series storage

Raw `heartbeats` are kept for 24 hours (important ones for the retention period). Each beat also upserts
`stat-minutely` (24h), `stat-hourly` (30d) and `stat-daily` (`KEEP_DATA_PERIOD_DAYS`) rows keyed by
`(monitor, timestamp)` with `up`, `down`, `ping`, `pingMin`, `pingMax`. An hourly job prunes expired rows.
Uptime percentages and average pings for 24h / 30d / 1y are computed from these aggregates.

## Realtime

Web and worker publish events with `@socket.io/redis-emitter`; the realtime process uses
`@socket.io/redis-adapter` so several realtime instances can run. Clients open one socket, authenticate with
the Payload cookie, and receive `heartbeat`, `heartbeatList`, `uptime`, `avgPing`, `monitorList`,
`maintenanceList`, … into Zustand stores with bounded ring buffers.

## Organizations and RBAC

`organizations` is the tenant collection (`@payloadcms/plugin-multi-tenant`). Users carry an
`organizations` array with a `role` per membership (`owner`, `admin`, `member`, `viewer`). Collection access
functions return `Where` filters scoped to the user's organizations and check `resource:action` permissions
(`src/access/permissions.ts`). Instance `superadmin` users may use the Payload admin panel.

## Billing (future)

`organizations.plan` + `src/lib/entitlements.ts` express limits. On self-hosted installs everything is
unlimited and `BILLING_ENABLED=false`. When enabled, `@payloadcms/plugin-stripe` is registered and the Billing
settings tab appears.
