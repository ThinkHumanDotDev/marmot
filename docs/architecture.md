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

## Notifications

`notifications` documents (org-scoped: `name`, `type` = provider slug, `config` validated against the
provider's zod schema, `isDefault`, `active`, `lastSentAt`, `lastError`) are attached to monitors through
`monitors.notifications`. When a beat has `notify = true` the worker's heartbeat listener enqueues one BullMQ
job per active attached channel on `marmot:notifications` (job id `notif:<channel>:<heartbeat>` dedupes, 3
attempts with exponential backoff); the notification worker renders `[name] [🔴 Down] msg`, calls the
provider's `send()` and records the outcome on the channel. Providers self-register in
`src/server/notification-providers/`; see `docs/notifications.md`.

## Maintenance windows

`maintenance` documents (org-scoped) describe when a set of monitors is deliberately offline: `title`,
`description`, `strategy` (`manual`, `single`, `recurring-interval`, `recurring-weekday`,
`recurring-day-of-month`, `cron`), `active`, `dateRange {start, end}` and `timeRange {start, end}` as
wall-clock strings, `intervalDay`, `weekdays`, `daysOfMonth` (`1`–`31`, `lastDay1`–`lastDay4`), `cron`,
`duration` (minutes), `timezone` (IANA zone or `SAME_AS_SERVER` = the organization's `settings.timezone`),
`monitors` and `statusPages` (both restricted to the same organization by a `beforeChange` hook). The field
set and the scheduling rules are a port of Uptime Kuma's `server/model/maintenance.js`.

Everything is a pure function of the document and the clock (`src/server/maintenance/status.ts`):
`computeMaintenanceTimeslots(doc, now)` resolves the timezone, reads the date range in it, and evaluates the
strategy — `croner` (cron patterns generated from the recurring options, evaluated in the maintenance's zone,
DST-aware) or, for "every N days", calendar arithmetic anchored on the start date — to return the status
(`inactive`, `scheduled`, `under-maintenance`, `ended`, `unknown`) plus the current and next window as ISO
instants. There is no in-memory job per maintenance:

- The worker installs `createMaintenanceResolver()` through the engine's `setMaintenanceResolver`, so every
  check asks `isMonitorUnderMaintenance()` (active maintenances listing the monitor, then its parent groups)
  and writes a MAINTENANCE heartbeat instead of running the check.
- The `maintenance-status` BullMQ job scheduler (`src/server/maintenance/job.ts`, every minute on the
  `marmot:maintenance` queue, whose worker also runs `retention` jobs) recomputes every document, persists
  `status` when it changed and publishes `maintenanceList` (`MaintenanceSummary[]`) to the organization
  room. The collection hooks compute `status` on save and publish the list after edits and deletes.
- Public status pages receive running windows and windows starting within seven days
  (`getActiveMaintenanceForStatusPage`) in their `maintenance` array and render them as banners.

Routes: `GET/POST /api/orgs/:orgId/maintenance`, `GET/PATCH/DELETE .../:id`, `POST .../:id/{pause,resume}`
(`maintenance:*` permissions, zod schema shared with the form in `src/lib/validation/maintenance.ts`). UI:
`/[orgSlug]/maintenance` (live list), `/new`, `/[id]/edit`.

## Realtime

The realtime process (`src/realtime.ts` → `createRealtimeServer()` in `src/server/realtime/server.ts`) is
a socket.io server on `REALTIME_PORT` with `@socket.io/redis-adapter`, so several replicas can run. Web and
worker never hold sockets: they publish with `@socket.io/redis-emitter` through the helpers in
`src/server/realtime/emitter.ts` (`emitHeartbeat`, `emitMonitorUpdated`, `emitMonitorDeleted`, `emitUptime`,
`emitAvgPing`, `emitMaintenanceList`, `emitNotificationList`, `emitCertInfo`). The emitter connects to Redis
lazily and swallows (logs) failures, so a Redis outage degrades live updates but never breaks a request or a
check.

**Authentication.** The browser connects with `withCredentials`, so the handshake carries the
`payload-token` cookie. An `io.use` middleware builds WHATWG `Headers` from `socket.handshake.headers` and
calls `payload.auth({ headers })`; sockets without a user are rejected (`connect_error: unauthorized`). The
socket then joins `org:<id>` for every organization in `user.organizations`. Clients may ask for more rooms
with `joinOrg(orgId, ack)` / `leaveOrg(orgId)`; membership is checked again (superadmins may join any
existing organization).

**Initial state.** On every room join the server sends, from the Local API with `overrideAccess: true`
(membership was verified already): `info { version, serverTime }`, `monitorList { organizationId,
monitors[] }` (active and paused monitors), then per monitor `heartbeatList` (last 100 beats, oldest →
newest), `importantHeartbeatList` (last 50 status transitions), `uptime` and `avgPing` for `24h` and `30d`
(`src/server/stats/uptime-calculator.ts`). `loadOrgState()` in `src/server/realtime/state.ts` builds that
state and is reused by server components (with the request user and `overrideAccess: false`).

**Live events.** The worker registers `registerRealtimeListener()` (`src/server/realtime/listener.ts`) after
the stats listener, so each beat publishes `heartbeat { organizationId, monitorId, heartbeat }` followed by
the refreshed `uptime`/`avgPing` for `24h`. The `monitors` collection hooks publish `updateMonitorIntoList
{ organizationId, monitor }` and `deleteMonitorFromList { organizationId, monitorId }` next to the BullMQ
scheduler sync (both skipped when `MARMOT_DISABLE_ENGINE_HOOKS=1`). Event names and payload types live in
`src/server/realtime/events.ts`, which is also imported by the client; every payload carries
`organizationId` and string ids.

**Client.** `src/lib/socket.ts` holds one `socket.io-client` instance (`path: /socket.io`, same origin unless
`NEXT_PUBLIC_REALTIME_URL` is set, `autoConnect: false`). `SocketProvider`
(`src/components/realtime/socket-provider.tsx`, mounted by the `[orgSlug]` layout) connects on mount, emits
`joinOrg` for the current organization and streams the events of that organization into
`useMonitorStore` (`src/stores/monitor-store.ts`: monitors, 100-beat ring buffers, important beats, uptime,
avgPing); events of other organizations the user belongs to are ignored and the store is reset when the
organization changes. Server status strings map to the store's `HeartbeatStatus` enum in
`src/lib/realtime.ts`. Pages load the same state server-side (`/{orgSlug}/monitors` uses `loadOrgState`),
render it, seed the store and let the socket take over.

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
