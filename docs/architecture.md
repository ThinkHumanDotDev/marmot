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
calls `syncMonitor(monitor)` / `removeMonitorSchedule(id)` (`src/server/engine/scheduler.ts`), which upserts
or removes a BullMQ **job scheduler** named `monitor:<id>` with `every = interval * 1000` (`retryInterval`
while the monitor is PENDING). Queues live under the Redis prefix `marmot:` (`marmot:checks`). The worker
consumes the `checks` queue, runs the monitor type's `check()` and feeds the result through the heartbeat
state machine (`src/server/engine/beat.ts`, ported from Uptime Kuma's `Monitor.beat`):

```
maintenance?  → MAINTENANCE
check ok      → UP
check failed  → retries < maxretries ? PENDING (scheduler switched to retryInterval) : DOWN
upsideDown    → flip UP/DOWN
```

Important beats (status transitions) trigger notifications; `resendInterval` re-notifies while down.

After each beat the worker writes a `heartbeats` row, refreshes the monitor's `status` group (`lastStatus`,
`lastCheckAt`, `lastPing`, `lastMsg`, `retries`, `downCount`) and calls every listener registered with
`registerHeartbeatListener()` (`src/server/engine/hooks.ts`); stats, realtime and notifications plug in there.

## Time-series storage

Raw `heartbeats` are kept for 24 hours (important ones for `KEEP_DATA_PERIOD_DAYS`). Every beat is also
folded into three aggregate collections, one row per `(monitor, timestamp)` where `timestamp` is the unix
second of the bucket start (minute / hour / UTC day), guarded by a unique compound index:

| Collection      | Bucket | Kept                    | Serves |
| --------------- | ------ | ----------------------- | ------ |
| `stat-minutely` | 1 min  | 24 hours                | `24h`  |
| `stat-hourly`   | 1 hour | 30 days                 | `30d`  |
| `stat-daily`    | 1 day  | `KEEP_DATA_PERIOD_DAYS` | `1y`   |

Each row stores `up`, `down`, `ping` (average of UP beats), `pingMin`, `pingMax` and an `extras` JSON with
`maintenance` (beats during maintenance, also counted as `up`) and `pingCount` (weight of `ping`). `pending`
beats count as `down`. The maths is a port of Uptime Kuma's `UptimeCalculator`
(`src/server/stats/uptime-calculator.ts`): the worker's heartbeat listener calls
`recordHeartbeat(payload, { monitorId, organizationId, status, ping, time })`, which reads the three current
buckets, applies the beat (running average, min/max) and writes them back through the Local API; an insert
that loses the unique-index race is retried as an update. Reads (`getUptime`, `getAvgPing`, `getBuckets`,
`getStats`) sum the buckets of the window `[now - range, now]`, falling back to the latest bucket when the
window is empty, and are exposed at `GET /api/monitors/:id/stats?range=24h|30d|1y`.

Retention (`src/server/jobs/retention.ts`) runs hourly as the `retention` BullMQ job scheduler on the
`marmot:maintenance` queue: minutely rows older than 24 h, hourly older than 30 d, daily and important
heartbeats older than `KEEP_DATA_PERIOD_DAYS` (long-term pruning is disabled when the value is `< 1`), and
non-important heartbeats older than 24 h.

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
check and are the only users allowed into the Payload admin panel (`users.access.admin`). Anyone may create
an account (`POST /api/users`) while `DISABLE_SIGNUP` is false (`canSignUp` in `src/collections/Users.ts`);
field-level access strips `superadmin` and `organizations` from requests that are not made by a superadmin.

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
(an existing membership keeps its role) and marks the invitation `accepted`. Updating an invitation with
`context.resendInvitation` re-sends the email (`POST /api/orgs/:orgId/invitations/:id/resend` also extends
the expiry); setting `status: 'revoked'` through the REST API withdraws it.

Organizations also carry a shareable **invite link**: `inviteLinkToken` (readable only with
`member:invite`, written only by the server) and `inviteLinkRole`. `POST /api/orgs/:orgId/invite-link`
mints a new token (optionally changing the role), `DELETE` disables it. `/invite/<code>` resolves either an
invitation token or an invite-link token (`src/server/invites.ts`: `resolveInviteCode`, `acceptInviteCode`)
and, for signed-in users, joins through `POST /api/invite/:code/accept`.

### Managing members

Memberships live on `users.organizations`, which only superadmins may write through the Payload API, so the
UI goes through dedicated route handlers backed by `src/server/members.ts` (`listOrgMembers`,
`changeMemberRole`, `removeMember`, `transferOwnership`, `soleOwnerships`). They authorise the actor with
`can()` / `canManageRole()` and then write with `overrideAccess: true`:

| Endpoint                                              | Rule                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `PATCH /api/orgs/:orgId/members/:userId` `{ role }`   | `member:update-role`; target and new role at or below the actor's rank     |
| `DELETE /api/orgs/:orgId/members/:userId`             | own id: leave; otherwise `member:remove` and rank at or above the target   |
| `POST /api/orgs/:orgId/transfer-ownership` `{userId}` | owner only; the target becomes `owner`, the caller `admin`                 |
| `POST /api/account/password`                          | re-authenticates with the current password before writing the new one      |
| `DELETE /api/account` `{ confirm: email }`            | deletes the caller unless they are the sole owner of any organization      |
| `GET /api/orgs/slug-available?slug=`                  | reserved-word, format and uniqueness check used by onboarding and settings |

An organization always keeps at least one owner: the last owner cannot be demoted, removed or leave, and
deleting an organization first removes its invitations and memberships (`beforeDelete` hooks).

## Billing (future)

`organizations.plan` + `src/lib/entitlements.ts` express limits. On self-hosted installs everything is
unlimited and `BILLING_ENABLED=false`. When enabled, `@payloadcms/plugin-stripe` is registered and the Billing
settings tab appears.
