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

`organizations` is the tenant collection (`@payloadcms/plugin-multi-tenant`, configured in
`src/plugins/index.ts` with `tenantsSlug: 'organizations'`). The plugin adds an `organizations` array to
`users`; each row is a membership `{ organization, role }` with `role` one of `owner`, `admin`, `member`,
`viewer`. Only superadmins may edit that array through the API: everyone else joins by creating an
organization (the creator becomes `owner`) or by accepting an invitation.

Org-scoped collections carry an `organization` relationship (the plugin adds it, named `organization`,
to every collection that opts in; collections outside the plugin such as `invitations` declare it
themselves). Their access functions come from `src/access/org-scoped.ts`:

- `orgScoped(permission, { field = 'organization' })` returns a Payload `Access`: `true` for
  superadmins; otherwise `{ [field]: { in: <organizations where the user's role satisfies the
permission> } }`, or `false` when there are none. When the request carries `data[field]` (create, or an
  update that moves a document) the user must hold the permission in that organization.
- `superadminOnly`, `authenticated`, `selfOrSuperadmin` cover the non-tenant cases.

Permissions are `resource:action` strings mapped to the **minimum** role in `src/access/permissions.ts`
(`PERMISSIONS`). Roles are ordered `owner > admin > member > viewer`; a role satisfies a permission when it
ranks at or above the minimum. Helpers: `can(user, orgId, permission)`, `hasOrgRole(user, orgId,
minRole)`, `getUserRole(user, orgId)`, `getUserOrgIds(user)`, `getOrgIdsWithPermission(user, permission)`,
`isSuperadmin(user)`, `canManageRole(managerRole, targetRole)`. Instance `superadmin` users bypass every
check and are the only users allowed into the Payload admin panel (`users.access.admin`).

| Permission                                                          | viewer | member | admin | owner |
| ------------------------------------------------------------------- | :----: | :----: | :---: | :---: |
| `organization:read`                                                 |   ✓    |   ✓    |   ✓   |   ✓   |
| `organization:update`                                               |        |        |   ✓   |   ✓   |
| `organization:delete`                                               |        |        |       |   ✓   |
| `member:read`                                                       |   ✓    |   ✓    |   ✓   |   ✓   |
| `member:invite`, `member:remove`, `member:update-role`              |        |        |   ✓   |   ✓   |
| `monitor:read`                                                      |   ✓    |   ✓    |   ✓   |   ✓   |
| `monitor:create`, `monitor:update`, `monitor:delete`                |        |   ✓    |   ✓   |   ✓   |
| `notification:read`                                                 |        |   ✓    |   ✓   |   ✓   |
| `notification:create`, `notification:update`, `notification:delete` |        |        |   ✓   |   ✓   |
| `status-page:read`                                                  |   ✓    |   ✓    |   ✓   |   ✓   |
| `status-page:create`, `status-page:update`, `status-page:delete`    |        |   ✓    |   ✓   |   ✓   |
| `maintenance:read`                                                  |   ✓    |   ✓    |   ✓   |   ✓   |
| `maintenance:create`, `maintenance:update`, `maintenance:delete`    |        |   ✓    |   ✓   |   ✓   |
| `api-key:read`, `api-key:create`, `api-key:delete`                  |        |        |   ✓   |   ✓   |

Nobody may invite or assign a role above their own (`canManageRole`); superadmins may.

### Invitations

`invitations` rows (`organization`, `email`, `role`, `token`, `status`, `expiresAt`, `invitedBy`) are
created by members with `member:invite`. A `beforeChange` hook mints a 24-byte `base64url` token, sets
`expiresAt` to seven days ahead and records the inviter; an `afterChange` hook emails
`${NEXT_PUBLIC_SERVER_URL}/invite/<token>` through the Payload email adapter (console when SMTP is not
configured). `POST /api/invitations/:token/accept` (authenticated) calls `acceptInvitation()` from
`src/collections/Invitations.ts`, which validates status and expiry, appends the membership to the user
(an existing membership keeps its role) and marks the invitation `accepted`.

## Billing (future)

`organizations.plan` + `src/lib/entitlements.ts` express limits. On self-hosted installs everything is
unlimited and `BILLING_ENABLED=false`. When enabled, `@payloadcms/plugin-stripe` is registered and the Billing
settings tab appears.
