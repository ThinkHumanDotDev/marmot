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
while the monitor is PENDING; every 60 s for push monitors on a cron schedule). Both run, together with the `updateMonitorIntoList` / `deleteMonitorFromList` realtime emits,
only **after the operation's transaction commits** (`afterCommit()` in `src/db/after-commit.ts`, which hooks
the adapter's `commitTransaction` / `rollbackTransaction`; without a transaction they run at once). Otherwise an
idle worker could run the new scheduler's first job before the monitor row is visible, take the "monitor not
found" path and delete the scheduler; a rolled-back change now leaves the scheduler untouched. Queues live
under the Redis prefix `marmot:` (`marmot:checks`). The worker
consumes the `checks` queue, runs the monitor type's `check()` and feeds the result through the heartbeat
state machine (`src/server/engine/beat.ts`, ported from Uptime Kuma's `Monitor.beat`):

```
maintenance?  → MAINTENANCE
check ok      → ping > degradedAfter ? DEGRADED : UP
check failed  → retries < maxretries ? PENDING (scheduler switched to retryInterval) : DOWN
upsideDown    → flip UP/DOWN (the degraded threshold does not apply)
was DOWN, ok  → successThreshold reached ? UP : PENDING "Recovering n/N" (applyRecoveryThreshold)
```

Important beats (status transitions) trigger notifications; `resendInterval` re-notifies while down. Each
notifying beat carries a `notificationEvent` (`down`, `up`, `degraded`, `reminder`) that the dispatcher
filters channels on. `status.settledStatus` remembers the last non-PENDING status so that leaving a retry
streak (DEGRADED → PENDING → UP) is still recognised as a transition.

Reminders are spaced by the reminder policy (`reminderBackoff`, `maxReminders`). The recovery threshold
(#147) is applied after the ported rules: during a recovery streak the previous status counts as DOWN, so its
PENDING beats are silent, a failure returns to DOWN without notifying, and the beat that completes it is DOWN → UP.

On-demand checks (`src/server/engine/on-demand.ts`, worker side in `on-demand-jobs.ts`) use the same queue:
`POST /api/orgs/:orgId/monitors/:id/check` adds a `manual-check` job (LIFO, deduplicated per monitor while
one is pending) and `POST /api/orgs/:orgId/checks` an `adhoc-check` job carrying unsaved form values. The
web process waits for the job's return value through BullMQ `QueueEvents`, so it never connects to a
target itself; the worker runs `runCheck()` (timeout, proxy, outbound guard) and either records the beat
through the state machine with `heartbeats.trigger = 'manual'` or, for dry runs and ad-hoc checks, only
returns the result. Jobs carry a deadline and are dropped when the worker picks them up after nobody waits
any more. A per-organization limiter (`ON_DEMAND_CHECKS_PER_MINUTE`) bounds both routes.

**Self connectivity check** (`src/server/engine/connectivity.ts`, opt-in with `CONNECTIVITY_CHECK_ENABLED`).
The worker keeps a cached verdict per location (`ConnectivityMonitor`, probed every
`CONNECTIVITY_CHECK_INTERVAL` seconds by a timer and again when a check fails on a verdict older than 10 s).
`processCheckJob` runs the check through `guardAgainstOfflineChecker`: while offline, monitors that need the
internet (`monitorNeedsInternet`) get a `checkerOffline` result, which the state machine turns into a silent
PENDING `checker offline` beat (`holdBeatWhileCheckerOffline` in `beat.ts`); `recordBeat` keeps the cached
`lastStatus`, and listeners see `event.checkerOffline` (the stats listener skips it). The worker wiring
(`connectivity-runtime.ts`) publishes each verdict to Redis (`marmot:connectivity:status:<location>:<worker>`,
read by `/api/health`, `/api/metrics` and the UI banner through `connectivity-state.ts`), broadcasts the
`checkerStatus` realtime event, sends one offline / back-online notice per outage (claimed in Redis so one
replica sends it) and re-enqueues the held monitors when connectivity returns. `connectivityLocationOf()` is
the hook for multi-location checks (#92): every location will run its own monitor.

After each beat the worker writes a `heartbeats` row, refreshes the monitor's `status` group (`lastStatus`,
`lastCheckAt`, `lastPing`, `lastMsg`, `retries`, `downCount`, `recoveries`) and calls every listener registered with
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
`maintenance` (beats during maintenance, also counted as `up`), `degraded` (slow successful checks, also
counted as `up`, their ping included) and `pingCount` (weight of `ping`). `pending`
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
provider's zod schema, `events` filter, `isDefault`, `active`, `lastSentAt`, `lastError`) are attached to monitors through
`monitors.notifications`. When a beat has `notify = true` the worker's heartbeat listener enqueues one BullMQ
job per active attached channel that selected the beat's event on `marmot:notifications` (job id `notif:<channel>:<heartbeat>` dedupes, 3
attempts with exponential backoff); the notification worker renders `[name] [🔴 Down] msg`, calls the
provider's `send()` and records the outcome on the channel. Providers self-register in
`src/server/notification-providers/`; see [Notifications](Notifications.md).

### Certificate and domain expiry

HTTPS checks go through a per-check undici agent whose connector records the peer certificate of every TLS
socket it opens (`src/server/monitor-types/http-request.ts` → `captureFromSocket` in
`src/server/engine/tls.ts`: issuer, subject, validity window, `daysRemaining`, SHA-256 fingerprint, SANs and
the chain up to the root, plus `valid` = `socket.authorized`). When the handshake itself is rejected
(expired, self-signed, hostname mismatch) the certificate is fetched again without verification so it can
still be shown. The worker stores the result in `monitors.certInfo`, publishes it as the realtime
`certInfo` event and hands it to the heartbeat listeners as `event.tlsInfo` / `event.certChanged`.

`registerExpiryNotificationListener()` (`src/server/jobs/expiry-notifications.ts`) runs after every beat:

- **Certificates** (`monitors.expiryNotification`, ignored with `ignoreTls`): for each threshold in the
  instance setting `tlsExpiryNotifyDays` (default 7, 14, 21, ascending) every certificate of the chain with
  `daysRemaining <= threshold` sends `[name][url] <type> certificate <CN> will expire in N days` through the
  monitor's active channels (`sendNotification`, no queue). Certificates of the system trust store are
  skipped.
- **Domains** (`monitors.domainExpiryNotification`): the registrable domain of the URL/hostname is looked up
  through RDAP (`https://rdap.org/domain/<domain>`, retrying with one label less on 404), cached in
  `monitors.domainExpiry` (`expiresAt`, `checkedAt`, `error`) and refreshed at most daily (hourly after a
  failure). Thresholds come from `domainExpiryNotifyDays`; the message is
  `[name][target] Domain name <domain> will expire in N days`.

Delivered warnings are recorded in `notification-sent-history` (`type`, `monitor`, `days`, `organization`,
compound unique index), looked up as `days <= threshold` so a certificate already inside several thresholds
produces one message. The certificate history is cleared when a different leaf certificate appears, the domain
history when the expiry date moves later (renewal); both go with the monitor when it is deleted.

## Maintenance windows

`maintenance` documents (org-scoped) describe when a set of monitors is deliberately offline: `title`,
`description`, `strategy` (`manual`, `single`, `recurring-interval`, `recurring-weekday`,
`recurring-day-of-month`, `cron`), `active`, `dateRange {start, end}` and `timeRange {start, end}` as
wall-clock strings, `intervalDay`, `weekdays`, `daysOfMonth` (`1`–`31`, `lastDay1`–`lastDay4`), `cron`,
`duration` (minutes), `timezone` (IANA zone or `SAME_AS_SERVER` = the organization's `settings.timezone`),
`monitors` and `statusPages` (both restricted to the same organization by a `beforeChange` hook). The field
set and the scheduling rules are a port of Uptime Kuma's `server/model/maintenance.js`.

The **planned** windows are a pure function of the document and the clock (`src/server/maintenance/status.ts`):
`computeMaintenanceTimeslots(doc, now)` resolves the timezone, reads the date range in it, and evaluates the
strategy — `croner` (cron patterns generated from the recurring options, evaluated in the maintenance's zone,
DST-aware) or, for "every N days", calendar arithmetic anchored on the start date — to return the status
(`inactive`, `scheduled`, `under-maintenance`, `ended`, `unknown`) plus the current and next window as ISO
instants.

What **actually** happens is persisted per occurrence (#154): `maintenance-occurrences` documents (`maintenance`,
`start`/`end` of the planned window, `state` = `scheduled | in-progress | verifying | completed | cancelled`,
`startedAt`/`completedAt`/`cancelledAt`, `remindersSent`, and an `updates[] { status, message, postedAt }`
timeline). `syncMaintenance(payload, doc, { now })` in `src/server/maintenance/occurrences.ts` is the only
writer besides admin updates: it plans an occurrence for the current and the next window, applies the due
transitions (`autoStart`, `autoComplete`), handles due reminders once per occurrence, and persists the
**effective** `maintenance.status` (`under-maintenance` exactly while an occurrence is open). It runs

- in the `maintenance` `afterChange` hook, inside the save's transaction (the response already carries the
  effective status),
- from delayed `maintenance-wakeup` BullMQ jobs (`src/server/maintenance/queue.ts`) at each planned start,
  end and reminder instant, enqueued after the commit with a job id per instant (idempotent re-planning;
  stale jobs find nothing to do),
- and from the `maintenance-status` job scheduler (`src/server/maintenance/job.ts`, every minute on the
  `marmot:maintenance` queue, whose concurrency-1 worker also runs `retention` and the wake-ups) as a
  reconciler; the worker re-plans every wake-up at boot.

Changes publish `maintenanceList` (`MaintenanceSummary[]`) to the organization room and hand
`MaintenanceEvent`s (`scheduled`, `reminder`, `started`, `updated`, `completed`, `cancelled`) to the listeners
registered with `registerMaintenanceEventListener()` after the commit: the hook point for subscriber
notifications (#104). Admins post updates or transitions through
`POST /api/orgs/:orgId/maintenance/:id/occurrences/:occurrenceId/updates` (`postOccurrenceUpdate()`).

Reads never recompute state:

- The worker installs `createMaintenanceResolver()` through the engine's `setMaintenanceResolver`, so every
  check asks `isMonitorUnderMaintenance()` (active maintenances listing the monitor whose persisted status is
  `under-maintenance`, then its parent groups) and writes a MAINTENANCE heartbeat instead of running the check.
- Public status pages receive the running occurrences, the next one of each maintenance starting within seven
  days and those finished within the page's `maintenanceVisibilityHours`
  (`getActiveMaintenanceForStatusPage`) in their `maintenance` array, each with its timeline.

Routes: `GET/POST /api/orgs/:orgId/maintenance`, `GET/PATCH/DELETE .../:id`, `POST .../:id/{pause,resume}`,
`GET .../:id/occurrences`, `POST .../:id/occurrences/:occurrenceId/updates`
(`maintenance:*` permissions, zod schema shared with the form in `src/lib/validation/maintenance.ts`). UI:
`/[orgSlug]/maintenance` (live list), `/new`, `/[id]/edit`.

## Monitor incidents

`monitor-incidents` (#100) is the on-call record of an outage, separate from the public status-page
`incidents` below: `monitor`, `status` (`open → acknowledged → resolved`), `cause` (first DOWN message),
`startedAt`, `acknowledgedAt`/`acknowledgedBy`/`acknowledgedVia`, `resolvedAt`/`resolvedBy`/`autoResolved`,
`remindersSent`/`lastReminderAt`, `statusPageIncident` (link to a published status-page incident) and a
`timeline[] { type, at, by, via, message }` array, written atomically with the state like the status-page
timeline. Only the server writes it (Local API with `overrideAccess`; collection create/update/delete are
superadmin-only); members act through the route handlers. A unique `openKey` (`open:<monitor>` while
unresolved, `resolved:<uuid>` afterwards, set by a `beforeChange` hook) allows one unresolved incident per
monitor on both databases, so two racing DOWN beats cannot open two.

The engine side lives in one place, `registerIncidentListener()` (`src/server/incidents/listener.ts`),
registered by the worker and the push pipeline **before** the notification listener. Its heartbeat listener
applies `incidentActionForBeat()` (`src/lib/monitor-incidents.ts`) to important beats: DOWN opens, MAINTENANCE
adds a note, a working status (UP, and DEGRADED once #93 lands) resolves automatically. Its notification gate
runs the pluggable reminder policy on resend-interval reminders (default: none while acknowledged). Every
change is published as the realtime `monitorIncident` event (`MonitorIncidentSummary`). Acknowledge and manual
resolve enqueue `incident-notify` jobs on `marmot:notifications` (events `acknowledged`, `resolved`), and the
notification worker appends a signed acknowledge link (`src/server/incidents/ack-link.ts`) to DOWN messages of
an unacknowledged incident. See [Monitors](Monitors.md#incidents) and [Notifications](Notifications.md).

## Status page incidents

An incident (`src/collections/Incidents.ts`) is a title plus a **timeline** of updates stored as an array
on the document (`updates[] { status, message, postedAt, editedAt, components[] { component, impact } }`),
so posting an update and deriving the incident's state is one atomic write on Postgres and MongoDB. The
rules live in one pure module, `src/lib/incident-timeline.ts`, shared by the collection hook, the public
payload, the RSS feed and the editor:

- updates apply oldest first; an update sets the impact (`operational`, `degraded_performance`,
  `partial_outage`, `major_outage`) of the components it names, others keep their last impact, and a
  `resolved` update resets them all to `operational`;
- `status`, `impact` (worst current component impact, or a declared impact when no component is
  named), `active`, `resolvedAt` and `affectedComponents` are derived by the `beforeChange` hook and stored,
  so queries (`active`, `status`) stay cheap;
- posted updates are history: only `message` may change afterwards (stamping `editedAt`);
- incidents stored before the timeline (only `content`/`style`) are migrated lazily: read paths treat them
  as one update (`legacyUpdate`, style mapped to an impact) and the next write stores it. No data migration
  runs, so the same code works on both databases.

Components are the rows of the page's groups (monitor or static, `src/lib/status-page-components.ts`),
referenced by their row id (`components[].component`, `affectedComponents[].component`).
`affectedComponents` is the current state the public page reads; writing it directly posts an update so it
never diverges from the timeline.

After every write the `afterChange` hook calls `emitIncidentUpdatePosted()`
(`src/server/status-pages/incident-events.ts`) once per new update, with `kind` `opened`, `updated`,
`resolved` or `reopened`. That is the extension point for subscriber notifications (#104): listeners register with
`onIncidentUpdatePosted(listener)` and get the write's `req` to defer work until the commit. Lazily
migrated updates are not announced.

### Status page subscribers

`registerSubscriberListeners()` (`src/server/status-pages/subscribers/events.ts`) runs from Payload's
`onInit`, so every process listens: incident updates (`onIncidentUpdatePosted`, deferred with
`afterCommit`) and maintenance events (`registerMaintenanceEventListener`) become
`subscriber-notifications` documents through `createNotificationBatch()`, deduplicated by a unique
`dedupeKey` (`incident:<page>:<incident>:<update>`, `maintenance:<page>:<occurrence>:<type>:<update|reminder>`).
In `review` mode they wait as `pending_review`; sending (or `auto` mode) enqueues a `subscriber-fanout` job
on `marmot:notifications`, which the notification worker routes by job name: the fan-out creates one
`subscriber-deliveries` row per matching confirmed subscriber and one `subscriber-delivery` job each
(job ids `spn-<notification>-<round>`, `spd-<delivery>-<round>`; five attempts, jittered exponential
backoff). Deliveries render per channel (`content.ts`, emails in `src/server/email/subscriber-emails.ts`)
and send through the Payload email adapter, the Twilio provider, or a signed webhook
(`src/server/webhooks/signature.ts`); the last delivery to finish sets the notification's final state.
Retention deletes delivery rows after 90 days and unconfirmed self sign-ups after 72 hours.

The public payload (`buildPublicStatusPageData`) maps each monitor to the worst impact of the active
incidents naming it and computes `overall` from both: a `major_outage` component counts as down, a
partial one as not fully up, a degraded one (incident impact or degraded monitor, `effectiveImpact()`) as
degraded, and incidents without components raise the page to `degraded`, `partial` or `down`. See [Status pages](Status-Pages.md) for the routes and payload.

### Outbound webhooks

`registerWebhookListeners()` (`src/server/webhooks/events.ts`) also runs from `onInit` and turns four
sources into organization events: the audit bus (`onAuditEvent`, published after the audited write
committed, so resource events reuse the audit log's redacted before/after values), notifying heartbeats
(`monitor.down|up|degraded`), posted incident updates (deferred with `afterCommit`) and maintenance events.
`emitWebhookEvent()` writes one `webhook-deliveries` row per active `webhook-endpoints` document of the
organization whose `events` match (exact type, `<group>.*` or `*`) and enqueues a `webhook-delivery` job
(`whd-<delivery>`) on `marmot:notifications`; the notification worker routes it to
`processWebhookDeliveryJob()` (`deliver.ts`): a signed POST through `guardedFetch`, twelve attempts with
exponential backoff from 40 s, the outcome recorded on the row, and the endpoint disabled (admins emailed)
after `WEBHOOK_DISABLE_AFTER_FAILURES` deliveries in a row failed for good. Test events and redeliveries are
sent synchronously from the web process (`deliverNow`). Retention prunes the log after
`WEBHOOK_DELIVERY_RETENTION_DAYS`. See [Integrations](Integrations.md#outbound-webhooks).

## Realtime

The realtime process (`src/realtime.ts` → `createRealtimeServer()` in `src/server/realtime/server.ts`) is
a socket.io server on `REALTIME_PORT` with `@socket.io/redis-adapter`, so several replicas can run. Web and
worker never hold sockets: they publish with `@socket.io/redis-emitter` through the helpers in
`src/server/realtime/emitter.ts` (`emitHeartbeat`, `emitMonitorUpdated`, `emitMonitorDeleted`, `emitUptime`,
`emitAvgPing`, `emitMaintenanceList`, `emitNotificationList`, `emitCertInfo`, `emitMonitorIncident`). The emitter connects to Redis
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

## Tags, proxies and Docker hosts

Three org-scoped collections hold resources that monitors reference (managed under
`/{orgSlug}/settings/tags|proxies|docker-hosts`):

- **`tags`** (`name`, unique per organization; `color`, hex). Monitors carry a `tags` array of
  `{ tag, value }` rows (`env: prod`). Chips appear in the monitor list (the realtime `monitorList` /
  `updateMonitorIntoList` payloads carry resolved `tags[] { id, name, color, value }`, filled by
  `populateMonitorTags()` in `src/server/realtime/serialize.ts`), on the detail page and on status pages
  whose `showTags` option is on (name, colour and value only). Deleting a tag removes its rows from every
  monitor first (`beforeDelete`).
- **`proxies`** (`protocol` = `http | https | socks | socks5 | socks5h | socks4`, `host`, `port`, `auth`,
  `username`, `password`, `active`, `default`). HTTP-type monitors (`http`, `keyword`, `json-query`) send
  their request through `monitor.proxy` when it is set and active (`loadMonitorProxy()` +
  `createProxyDispatcher()` in `src/server/proxies/dispatcher.ts`): undici's `ProxyAgent` for HTTP(S)
  proxies (CONNECT for https targets, absolute-form forwarding for http), and a custom undici connector
  over the `socks` client for SOCKS (`socks4`/`socks5` resolve the target locally, `socks5h`/`socks` let
  the proxy resolve it; TLS to https targets is negotiated through the tunnel). `password` has
  field-level read access: only users with `proxy:update` (and the worker, which reads with
  `overrideAccess`) receive it. One proxy per organization can be the `default`; it is preselected for new
  monitors in the form. Deleting a proxy clears `monitor.proxy` (monitors connect directly again).
- **`docker-hosts`** (`name`, `connectionType` = `socket | tcp`, `socketPath` or `url`). The `docker`
  monitor type (`src/server/monitor-types/docker.ts`, ported from Uptime Kuma) calls
  `GET /containers/<dockerContainer>/json` on the host (`src/server/docker/client.ts`, undici over the unix
  socket or `tcp://` rewritten to `http://`; `https://` uses TLS) and maps `State`: not running, paused or
  unhealthy → DOWN, restarting or a health check that is still `starting` → PENDING, healthy or running
  without a health check → UP. `POST /api/orgs/:orgId/docker-hosts/test` (`docker-host:update`) lists the
  daemon's containers for a saved host (`{ dockerHostId }`) or unsaved settings and answers
  `{ ok, containers }`. Socket paths are resolved on the worker; `DOCKER_SOCKET_ENABLED=false` rejects socket
  hosts on shared instances. Deleting a host clears `monitor.dockerHost`.

A `monitors` `beforeChange` hook rejects tags, proxies and Docker hosts of another organization, so a
member cannot borrow another tenant's proxy credentials or Docker daemon through the API.

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

### Permission overrides

An organization may raise or lower the minimum role of any permission except `organization:delete`
(`LOCKED_PERMISSIONS`) through `organizations.permissionOverrides`, a JSON diff from `PERMISSIONS` such as
`{ "monitor:create": "admin", "notification:create": "member" }`. Owners edit it in **Settings →
Permissions** (`GET/PUT /api/orgs/:orgId/permissions`); the field's own access only lets owners and
superadmins write it, and `validatePermissionOverrides` refuses unknown permissions, roles and locked keys.

Resolution: `minRoleFor(permission, overrides)` → `canWithOverrides(user, org, permission)` when the
organization document is at hand (settings pages, `getOrgPageContext`), `canInOrg(payload, user, orgId,
permission)` (`src/access/overrides.ts`) in route handlers that only know the id (one lookup, used by
`resolveOrgRequest`, the monitors `authorize` helper, members and invite helpers). `orgScoped` loads the
overrides of the user's organizations once per request (`req.context`) so collection access and the route
checks agree; the plain `can(user, orgId, permission)` keeps the defaults and remains for code that cannot
afford a lookup (`toClientNotification` secret masking, field-level access on `inviteLinkToken`).

| Permission                                                          | viewer | member | admin | owner |
| ------------------------------------------------------------------- | :----: | :----: | :---: | :---: |
| `organization:read`                                                 |   ✓    |   ✓    |   ✓   |   ✓   |
| `organization:update`                                               |        |        |   ✓   |   ✓   |
| `organization:delete`                                               |        |        |       |   ✓   |
| `member:read`                                                       |   ✓    |   ✓    |   ✓   |   ✓   |
| `member:invite`, `member:remove`, `member:update-role`              |        |        |   ✓   |   ✓   |
| `monitor:read`                                                      |   ✓    |   ✓    |   ✓   |   ✓   |
| `monitor:create`, `monitor:update`, `monitor:delete`                |        |   ✓    |   ✓   |   ✓   |
| `monitor-incident:read`                                             |   ✓    |   ✓    |   ✓   |   ✓   |
| `monitor-incident:acknowledge`, `monitor-incident:resolve`          |        |   ✓    |   ✓   |   ✓   |
| `notification:read`                                                 |        |   ✓    |   ✓   |   ✓   |
| `notification:create`, `notification:update`, `notification:delete` |        |        |   ✓   |   ✓   |
| `status-page:read`                                                  |   ✓    |   ✓    |   ✓   |   ✓   |
| `status-page:create`, `status-page:update`, `status-page:delete`    |        |   ✓    |   ✓   |   ✓   |
| `subscriber:read`, `subscriber:manage`                              |        |   ✓    |   ✓   |   ✓   |
| `subscriber:send`                                                   |        |        |   ✓   |   ✓   |
| `maintenance:read`                                                  |   ✓    |   ✓    |   ✓   |   ✓   |
| `maintenance:create`, `maintenance:update`, `maintenance:delete`    |        |   ✓    |   ✓   |   ✓   |
| `template:read`                                                     |   ✓    |   ✓    |   ✓   |   ✓   |
| `template:create`, `template:update`, `template:delete`             |        |   ✓    |   ✓   |   ✓   |
| `tag:read`                                                          |   ✓    |   ✓    |   ✓   |   ✓   |
| `tag:create`, `tag:update`, `tag:delete`                            |        |   ✓    |   ✓   |   ✓   |
| `proxy:read` (password only with `proxy:update`)                    |        |   ✓    |   ✓   |   ✓   |
| `proxy:create`, `proxy:update`, `proxy:delete`                      |        |        |   ✓   |   ✓   |
| `docker-host:read`                                                  |        |   ✓    |   ✓   |   ✓   |
| `docker-host:create`, `docker-host:update`, `docker-host:delete`    |        |        |   ✓   |   ✓   |
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

## Account security: two-factor authentication

`src/auth/two-factor/` implements TOTP (RFC 6238, `otplib`) after Uptime Kuma's `login` / `prepare2FA` /
`save2FA` / `disable2FA` handlers: a one-step tolerance window and a replay check (the matched time step must
be after the last accepted one, `users.twoFactorLastUsedStep`).

- **Storage** (`src/collections/Users.ts`): `twoFactorEnabled` and `twoFactorVerifiedAt` are readable;
  `twoFactorSecret`, `twoFactorPendingSecret` (AES-256-GCM, key derived from `PAYLOAD_SECRET`, `crypto.ts`),
  `twoFactorBackupCodes` (HMAC digests of ten single-use codes, `backup-codes.ts`) and
  `twoFactorLastUsedStep` are `hidden` with read access `false`: only `loadTwoFactorUser` (Local API with
  `showHiddenFields`) sees them and every write happens server-side with `overrideAccess: true`.
- **Enrolment** (`service.ts`, routes `/api/account/2fa/{setup,verify,disable,backup-codes}`): `setup`
  (password re-check for local accounts via `verifyPassword`, `src/auth/password.ts`) stores a pending
  secret and returns the otpauth URL, a QR data URL and the base32 key; `verify` confirms a code, enables
  2FA and returns the backup codes once; `backup-codes` regenerates them after a TOTP code; `disable`
  needs password + a current code. UI: `TwoFactorCard` on Settings → Account.
- **Login** (`handlers.ts`, routes `POST /api/auth/login` and `POST /api/auth/2fa`): the wrapper calls
  `payload.login` with the `twoFactorGate` context flag; for a protected account it revokes the session
  Payload just created and answers `{ requiresTwoFactor: true, challenge }` plus an encrypted
  `marmot-2fa` challenge cookie (`challenge.ts`, 5 minutes, 5 attempts, path `/api/auth`). `/api/auth/2fa`
  verifies a TOTP or backup code against the challenge and creates the session with
  `createPayloadSessionCookie`. A `beforeLogin` hook on `users` rejects `POST /api/users/login` and
  `payload.login` without the gate flag for protected accounts, so the Payload REST login (and the admin
  panel's login form) cannot bypass the second step; a superadmin with 2FA signs in through the Marmot
  login page and then opens `/admin` with the shared cookie.
- **Single sign-on**: the SSO callback (`src/auth/sso`, on `@thinkhuman/payload-plugin-auth`) issues the
  same challenge (redirect to `/login?two_factor=1`) when a linked account enabled 2FA; accounts that did
  not are signed in by the identity provider alone. SSO
  accounts have no Marmot password, so their setup/disable steps rely on the session plus a code.
- **Known gap**: Payload's `reset-password` endpoint signs the user in as part of a successful reset without
  offering a hook, so a password reset through the email link bypasses the second step for that session.

## Billing (future)

`organizations.plan` + `src/lib/entitlements.ts` express limits. On self-hosted installs everything is
unlimited and `BILLING_ENABLED=false`. When enabled, `@payloadcms/plugin-stripe` is registered and the Billing
settings tab appears.
