# Architecture

Marmot is a single TypeScript codebase that runs as three processes from one Docker image.

| Role       | Entrypoint        | Responsibilities                                                                                                           |
| ---------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `web`      | `next start`      | Marmot UI, Payload admin, REST/GraphQL, public status pages, badges, push, metrics                                         |
| `worker`   | `src/worker.ts`   | BullMQ job schedulers (one per monitor), check execution, heartbeat state machine, stats rollups, retention, notifications |
| `realtime` | `src/realtime.ts` | socket.io server; authenticates Payload sessions; joins users to `org:<id>` rooms                                          |
| `probe`    | `src/probe.ts`    | Remote probe agent (optional, runs elsewhere): pulls its location's monitors over HTTPS and pushes the results back        |

The `marmot` command-line tool (`src/cli/`, bundled into `dist/cli/marmot.mjs`) is a client of the
management API only; see [CLI and monitors as code](CLI.md).

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
the default of the guard's `location` argument; the workers pass `DEFAULT_LOCATION` and a probe agent (#91)
its own location's id, under which it registers its `ConnectivityMonitor`, so the checks of a
multi-location monitor (#92) are held per location.

**Request timing** (#94): `performHttpCheck` builds its per-check undici agent with an
`HttpTimingCapture` (`src/server/monitor-types/http-timing.ts`). A connector wrapper placed outside the
outbound guard timestamps each new connection and its socket's `lookup`, `connect` and `secureConnect`
events (the guard's own resolution counts as DNS); a dispatch interceptor composed inside the redirect
interceptor timestamps each hop's dispatch, response headers and body end. The final hop's phases
(`dns`, `connect`, `tls`, `ttfb`, `transfer`, ms, null when not applicable) go to `ctx.timing`, the
heartbeat's `timing` group and the stats rollup. The TCP port type records `dns` and `connect`.

**Response log** (#97): `performHttpCheck` hands the response to `captureResponse()`
(`src/server/monitor-types/response-capture.ts`), which keeps the status code, the headers up to
`RESPONSE_HEADERS_LIMIT_BYTES` (8 KB, `Set-Cookie` redacted) and the first `RESPONSE_BODY_LIMIT_BYTES`
(16 KB) of the body, and replaces every credential of the request (`requestSecrets()`) wherever the target
echoes it. `recordBeat` stores `heartbeats.statusCode` and the `response` group, the body only when the
beat is DOWN, PENDING or DEGRADED. The log API (`src/server/monitors/response-log.ts`) pages by cursor
(`time < t OR (time = t AND id NOT IN ids)`), which needs no id ordering and so behaves the same on every
adapter. Heartbeats are readable with `monitor:read` in their organization only (`orgScoped`).

After each beat the worker writes a `heartbeats` row, refreshes the monitor's `status` group (`lastStatus`,
`lastCheckAt`, `lastPing`, `lastMsg`, `retries`, `downCount`, `recoveries`) and calls every listener registered with
`registerHeartbeatListener()` (`src/server/engine/hooks.ts`); stats, realtime and notifications plug in there.

## Probe locations

`locations` (#91, org-scoped: `name`, `slug` unique per organization (`local` reserved), up to 20
`labels`, `tokenHash` + `tokenPrefix`, `status` = `unknown | online | offline`, `statusChangedAt`,
`lastSeenAt`, `agent { version, hostname, platform }`) are self-hosted check locations. Monitors reference
them through `monitors.locations` (up to `MAX_MONITOR_LOCATIONS` = 10; none = the implicit `local` worker
pool, which `includeLocal` adds to probe locations); `src/lib/probe-locations.ts` holds the shared rules
(`monitorLocationKeys`, `checksLocally`, `isRemoteMonitor`, `isMultiLocation`, `quorumNeeded`,
`PROBE_UNSUPPORTED_TYPES`: group, manual, push, steam, globalping, status-page).

- **Token**: `mp_<prefix>_<secret>` (`src/server/probes/tokens.ts`), modelled on API keys: only the SHA-256
  is stored, the plaintext is returned once by `POST /api/orgs/:orgId/locations` and
  `POST …/locations/:id/rotate-token`. Routes are admin-only (`location:create|update|delete`; everyone
  reads with `location:read`) and closed to API keys; create, update, rotation (`location.token_rotated`)
  and delete are audited by the collection hooks (`auditCollection`).
- **Engine**: `syncMonitor` removes the scheduler of a probe-checked monitor instead of upserting it,
  `resyncAll` skips them and `processCheckJob` drops a leftover job (`reason: remote`), so the workers
  never check them. A recorded **Check now** answers 409 (dry runs still run on the server).
- **Agent** (`src/probe.ts` → `ProbeAgent` in `src/probe/agent.ts`, `MARMOT_ROLE=probe`, bundled to
  `dist/server/probe.mjs`): no Payload config, database or Redis in its module graph. It pulls
  `GET /api/probe/v1/config` every `refreshSeconds` (ETag, `304` when unchanged), schedules each monitor
  locally (`interval`, `retryInterval` while PENDING as the server reports back), runs `runCheck()`
  (`src/server/engine/run-check.ts`, the same monitor types; proxies and Docker hosts come with the config
  and are served by a stub `Payload`) through `guardAgainstOfflineChecker`, and posts each result to
  `POST /api/probe/v1/results`. Undelivered results wait in a bounded outbox with backoff; a `401` stops
  every check.
- **Ingest** (`src/server/probes/ingest.ts`, web process): each result is checked against the monitor
  (organization, assignment, active, type), refused when older than ten minutes or not newer than
  `status.lastCheckAt` (so re-sent batches are recorded once), passed through the maintenance resolver and
  recorded with `recordBeat(…, { location })`: the heartbeat carries `location`, and stats, realtime,
  incidents and notifications run through the lazily registered beat pipeline as for push monitors. The
  wire format (`src/server/probes/wire.ts`) is versioned in the path; requests are rate limited per token
  (`PROBE_RATE_LIMIT`).
- **Multi-location quorum** (#92): a monitor with more than one location key (`isMultiLocation`) keeps
  one `monitor-location-states` row per `(monitor, locationKey)` (`lastStatus`, `settledStatus`,
  `retries`, `downCount`, `recoveries`, `lastCheckAt`, `lastPing`, `lastMsg`; unique compound index).
  `recordBeat` then calls `applyQuorum` (`src/server/engine/quorum-store.ts`): the reporting location's
  result goes through `computeNextBeat` on that location's row (retries, degraded, recovery threshold,
  checker-offline holds stay per location), the row is upserted, and the pure quorum layer
  (`src/server/engine/quorum.ts`) tallies the assigned locations (`voteOf`: a recovery streak counts as
  down, a retry as retrying, no row as unknown), derives the monitor status (`quorumStatus`: MAINTENANCE,
  DOWN at `quorumNeeded(quorum, n)` down locations — `any` 1, `half` ⌈n/2⌉ (default), `all` n — PENDING
  while down + retrying reach it or no location succeeded yet, DEGRADED while degraded + failing reach
  it, else UP) and judges the monitor-level transition on `monitors.status` (`computeQuorumBeat`, Uptime
  Kuma's rules; a PENDING monitor settled DOWN counts as DOWN; reminders every
  `resendInterval × n` beats). Announced beats carry `quorumMessage` (`Down at 2 of 3 locations: …`).
  The heartbeat stores the quorum `status` plus `location` and `locationStatus`; listeners get
  `event.location { key, status }`. The local workers' scheduler follows the local row
  (`SchedulableMonitor.localStatus`), probe agents the location's cadence from the ingest response, and
  ingest refuses results not newer than the **location's** `lastCheckAt`. Single-location monitors never
  touch any of this.
- **Quorum safety net**: the `quorum-recompute` job (every minute on `marmot:maintenance`,
  `src/server/jobs/quorum-recompute.ts`) deletes state rows of locations a monitor no longer uses and
  recomputes each active multi-location monitor's quorum (skipping monitors checked in the last 5 s);
  when it differs from `status.lastStatus` (two locations' beats raced, then the locations went quiet) it
  records a repair beat (`trigger: 'quorum'`, `event.repair`, not counted in the stats) through the same
  transition rules, so the notification and incident still happen.
- **Liveness**: every authenticated probe request stamps `lastSeenAt` (at most every 10 s). The
  `probe-health` job (every 15 s on `marmot:maintenance`, whose single consumer makes it the only writer of
  `status`) derives `online`/`offline` from `lastSeenAt` and `PROBE_OFFLINE_AFTER` and emails the
  organization's owners and admins on each change to offline and each recovery
  (`src/server/probes/health.ts`).

## Time-series storage

Raw `heartbeats` are kept for 24 hours (important ones for `KEEP_DATA_PERIOD_DAYS`). Every beat is also
folded into three aggregate collections, one row per `(monitor, timestamp)` where `timestamp` is the unix
second of the bucket start (minute / hour / UTC day), guarded by a unique compound index:

| Collection      | Bucket | Kept                    | Serves             |
| --------------- | ------ | ----------------------- | ------------------ |
| `stat-minutely` | 1 min  | 24 hours                | `24h`, `1d`        |
| `stat-hourly`   | 1 hour | 30 days                 | `7d`, `14d`, `30d` |
| `stat-daily`    | 1 day  | `KEEP_DATA_PERIOD_DAYS` | `90d`, `1y`        |

Multi-location monitors (#92) count the quorum status there (the ping of a location whose own check
failed is left out) and also feed a separate per-location series, `stat-location-hourly` (one row per
`(monitor, location, hour)`, 30 days, same columns; `src/server/stats/location-stats.ts`:
`recordLocationHeartbeat`, `getLocationStats` for `24h` / `30d`), which the monitor page's location table
and latency chart read.

Each row stores `up`, `down`, `ping` (average of UP beats), `pingMin`, `pingMax` and an `extras` JSON with
`maintenance` (beats during maintenance, also counted as `up`), `degraded` (slow successful checks, also
counted as `up`, their ping included), `pingCount` (weight of `ping`) and `timing` (per-phase running
averages of the request timing, `{ dns: { avg, count }, … }`, from successful checks) and `value`
(`{ avg, min, max, count }` of the metric values of Prometheus query monitors, #140, any status), plus
`latencyHistogram`, a JSON number array counting the pings of UP and DEGRADED beats per log-spaced bucket
(four per doubling, from `[0, 1)` ms to an overflow bucket at 2^17 ms;
`src/server/stats/latency-histogram.ts`). `pending`
beats count as `down`. The maths is a port of Uptime Kuma's `UptimeCalculator`
(`src/server/stats/uptime-calculator.ts`): the worker's heartbeat listener calls
`recordHeartbeat(payload, { monitorId, organizationId, status, ping, time })`, which reads the three current
buckets, applies the beat (running average, min/max) and writes them back through the Local API; an insert
that loses the unique-index race is retried as an update. Reads (`getUptime`, `getAvgPing`, `getBuckets`,
`getStats`) sum the buckets of the window `[now - range, now]`, falling back to the latest bucket when the
window is empty, and are exposed at `GET /api/monitors/:id/stats?range=…`.

**Percentiles** (#95, `src/server/stats/range-stats.ts`): histograms merge by element-wise addition, so
`getRangeStats()` derives p50, p75, p90, p95 and p99 of any window by merging the histograms of its buckets
and reading the nearest-rank sample's bucket, interpolated by rank and bounded by the exact `pingMin` /
`pingMax`; the result is always inside the histogram bucket of the true value (about ±19 %). It also folds
the buckets into a fixed number of chart intervals (5 min for 1 d, 1 h for 7 d, 2 h for 14 d, 4 h for 30 d,
1 day for 90 d) with up / degraded / down counts, the average and the percentiles, so the detail page's
chart never reads raw heartbeats. Rows written before the histogram existed have none and contribute no
percentiles.

Status pages keep their own long-term copy (#112): the daily `status-page-uptime-snapshot` job
(`src/server/status-pages/uptime-history.ts`, 00:20 UTC on `marmot:maintenance`) writes one
`status-page-uptime-history` row per page, component and complete UTC day from `stat-daily` and the
important heartbeats (check counts, seconds DOWN, seconds with a known state). Retention never prunes
it; the daily bars and the monthly history read it for the days whose statistics are gone
([Status pages](Status-Pages.md#daily-uptime-bars)).
Public latency charts (#113, `src/server/status-pages/latency-charts.ts`) read `getRangeStats()` and
`stat-location-hourly` for the components whose owner set `showChart`, and expose aggregates only
([Status pages](Status-Pages.md#latency-charts)).
Custom metrics (#155, `src/server/metrics/`) keep no raw points: a push folds its batch into
`metric-stats` rows (one per metric, granularity and minute/hour/day bucket with count, sum, min, max
and latest value), pruned by the retention job with the same cutoffs as the `stat-*` rows. Points older
than 24 hours are backfilled into the hourly and daily rows only (#280), and pushes of one metric are
serialised in the process and across processes by a Redis lock (`marmot:metric-push:<id>`,
`src/server/metrics/lock.ts`; without Redis the push goes ahead unlocked).
Monitor-backed metrics read the value their monitor records in `stat-*` (`extras.value`)
([Status pages](Status-Pages.md#custom-metrics)).

Retention (`src/server/jobs/retention.ts`) runs hourly as the `retention` BullMQ job scheduler on the
`marmot:maintenance` queue: minutely rows older than 24 h, hourly and per-location hourly older than 30 d, daily and important
heartbeats older than the `keepDataPeriodDays` instance setting (default `KEEP_DATA_PERIOD_DAYS`; long-term
pruning is disabled when the value is `< 1`), and
non-important heartbeats older than 24 h. It deletes in batches of 1,000 rows (`deleteInBatches` in
`src/db/delete-in-batches.ts`: fetch one batch of ids, delete them with `id in [...]`, repeat), so a large
backlog never has to fit in the worker's memory. Telemetry and log collections have no delete hooks and
are removed through the database adapter (`payload.db.deleteMany`); unconfirmed subscribers go through
`payload.delete` so their `beforeDelete` cascade still runs.

## SLA targets and reports

`sla-targets` (monitor, `target` %, `period` = `month | quarter | rolling30`, `calculation` =
`duration | checks`, `excludeMaintenance`), `sla-reports` (targets, `schedule` = `none | weekly |
monthly`, recipients, delivery bookkeeping) and `sla-report-shares` (report, `fromDate`/`toDate`,
`tokenHash`, `revokedAt`) are org-scoped (`sla:read` for viewers, `sla:manage` for admins) (#156).
The maths is pure (`src/lib/sla.ts`: periods, `slaUptime`, `slaAttainment` with the error budget
and burn rate, MTTR, the CSV); `src/server/sla/compute.ts` feeds it from the same sources as the
status page uptime of #112 (`loadMonitorDays`: `stat-daily` counts and the replayed important
heartbeats, which also yield the time spent in maintenance) plus the `monitor-incidents` of the
period. Exports: CSV, a dependency-free PDF writer (`src/server/sla/pdf.ts`) and the
server-rendered page.

Scheduling uses the existing queues: the `sla-reports-due` job scheduler (hourly at :40 UTC on
`marmot:maintenance`) enqueues one `sla-report-send` job per report whose previous complete week or
month (`previousSchedulePeriod`) differs from its `lastSentPeriod` (job id
`sla-report-<report>-<period>`); the notification worker renders the report and sends it to each
recipient through the Payload email adapter with the CSV and PDF attached, then records the period.
A new or changed schedule starts with the period that just ended marked as sent.

Share links (`src/server/sla/shares.ts`) carry 32 random bytes; only the SHA-256 is stored, and the
field can only be written by the share route (`req.context` flag) and never read through the API.
`/sla/<token>` and `/api/sla/<token>` resolve the token with `overrideAccess` and render that report
over the stored range only; revoked or unknown tokens get the same 404.

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

### Certificate transparency alerts

Monitors with `ctAlerts` (#143) are looked up in certificate transparency logs by the `ct-alerts` job
(`src/server/jobs/ct-alerts.ts`), a BullMQ job scheduler every 5 minutes on its own `marmot:ct` queue
(concurrency 1, so slow lookups never delay the maintenance jobs). A run takes the monitors whose
`ctState.nextCheckAt` is due (`CT_CHECK_INTERVAL_MINUTES`), asks the source (`CT_SOURCE_URL`, crt.sh JSON
or Cert Spotter issuances; requests spaced by `CT_REQUESTS_PER_MINUTE`, identical URLs fetched once) and
announces the certificates for the hostname (and `*.hostname` with `ctIncludeSubdomains`) logged after the
baseline `ctState.since` through the channels that accept `certificate`. Each one is first claimed in
`notification-sent-history` (`type: 'ct'`, `days: 0`, `fingerprint`; the unique index is
`(type, monitor, days, fingerprint)`, expiry rows store `''`), so re-runs and overlapping runs announce it
once. A failed lookup stops the run and backs off the source (in memory, per worker process) and the
monitor (`ctState.failures`, `nextCheckAt`), exponentially from 5 minutes to a day or by `Retry-After`. A
`beforeChange` hook clears `ctState` when the option is turned off. Runs stop starting lookups after
4.5 minutes so they never overlap.

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

## Declared incidents

`declared-incidents` (#101) is the incident-response record members declare: `title`, `severity`, `status`
(`open → mitigated → resolved → closed`, or `canceled`), `summary`, `commander`, `declaredBy`, `startedAt`,
`mitigatedAt`/`resolvedAt`/`closedAt`/`canceledAt`, `monitorIncident` (the outage it was declared from),
`statusPageIncident`, `postmortem { status: none|draft|approved, content, approvedBy, approvedAt }`,
`postmortemSkipped`, reminder bookkeeping (`lastActivityAt`, `nextReminderAt`, `remindersSent`,
`lastReminderAt`) and an append-only `timeline[] { type, at, by, from, to, message }`.

How the three kinds of incident relate: a monitor incident is the engine's record of one monitor's outage; a
declared incident is the team's response, which may start from a monitor incident (pre-filling `startedAt`)
and may span several monitors or none; the status-page incident is the public communication. Declared
incidents **link** to the other two and never copy them.

## Inbound integrations

`integrations` (#152) receive alerts from Alertmanager, Grafana, generic JSON and email
(`POST /api/inbound/<token>`, `<token>@INBOUND_EMAIL_DOMAIN`): `name`, `format`, `active`, `tokenHash` (SHA-256,
server-only) and `tokenPrefix`, the `generic` JSON paths, `emailResolvedKeyword` and ordered `rules[]` (match,
opt-in `updateComponent` with `statusPage`/`component`/`impact`, `incident: none|draft|publish`, `severity`,
`monitor`). `integration-alerts` holds one row per `(integration, dedupKey)` (unique index) with the alert's
state and the incidents its firing opened, so retries are idempotent; `integration-events` is the redacted
payload log. Parsing and rule matching are pure (`src/lib/inbound-alerts.ts`); `src/server/integrations/ingest.ts`
applies alerts through the existing collections (a status-page incident carries the component impact, a
declared incident is the draft) and never duplicates them. See [Integrations](Integrations.md#inbound-alerts).

Unlike monitor incidents, members write declared incidents through the collection with
`overrideAccess: false` (`orgScoped('declared-incident:*')`); the rules live in the collection's
`beforeChange` hook (`src/server/declared-incidents/hooks.ts`) so the route handlers, the REST API and the
worker share them: the status transitions (`DECLARED_STATUS_TRANSITIONS` in `src/lib/declared-incidents.ts`),
read-only closed/canceled incidents, commander membership, same-organization links, the postmortem gate on
closing (skipping needs `declared-incident:skip-postmortem`), and the timeline, rebuilt as the stored rows plus
one row per change (a note arrives in `req.context.declaredIncidentNote`), so it cannot be rewritten. Every
write re-arms `nextReminderAt`. The `afterChange` hook (after the commit) publishes the realtime
`declaredIncident` event and enqueues `declared-incident-notify` jobs on `marmot:notifications`. The
`declared-incident-reminders` job (every five minutes on `marmot:maintenance`) reminds commanders of due
incidents with `overrideAccess: true` and `req.context.declaredIncidentReminder`, which only touches the
bookkeeping. Changes are audited by the collection audit hooks (`declared_incident.*`). Routes:
`/api/orgs/:orgId/declared-incidents/**`; UI: `/[orgSlug]/declared-incidents`.

## On-call and escalation

`on-call-schedules` and `escalation-policies` (#145) decide who is paged when a monitor goes down, and in which
order.

**Schedules** have layers. A layer rotates through its ordered `members`: a shift lasts a day (`daily`), a week
(`weekly`) or `customLength` hours or days, and hands off at `handoffTime` wall-clock time in the layer's
`timezone` (the schedule's when empty), starting on `startDate`. Day-based shifts follow the calendar, so a
weekly Monday 09:00 handoff stays at 09:00 local time across DST changes (that week is an hour shorter or
longer); hour-based shifts are exact durations. A handoff inside the hour skipped by a DST change happens one
hour later. `restrictions` limit a layer to windows of the week (e.g. weekdays 09:00–17:00, windows may wrap
past midnight). Later layers take precedence over earlier ones where they have somebody on call, and
`overrides` (one member for a time range) take precedence over every layer, the last matching one winning.
The maths is pure and lives in `src/lib/on-call.ts` (`onCallAt`, `shiftsBetween`, unit-tested around DST
changes), so the dashboard, the API and the worker agree.

**Escalation policies** have ordered `steps`; each step pages its `targets` (the member on call in a schedule, a
member, or any notification channel) and waits `escalateAfterMinutes` for an acknowledgement before the next
step. After the last step the policy starts over `repeat` times. Monitors reference a policy
(`monitors.escalationPolicy`). The escalation runs as BullMQ jobs on `marmot:escalations`
(`src/server/on-call/escalation.ts`):

```
monitor incident opened ─▶ startEscalation ─▶ escalation-step (step 0, no delay)
escalation-step ─▶ resolve targets ─▶ escalation-page per target (email, or the channel's provider)
                └▶ timeline row `escalated` ─▶ next escalation-step, delayed by escalateAfterMinutes
acknowledge / resolve ─▶ escalation.status = stopped ─▶ the pending step job is removed
```

Delayed jobs live in Redis, so pending steps survive worker restarts; job ids are derived from (incident,
round, step), so a step is never queued twice. The incident keeps the state in `escalationPolicy` and
`escalation { status: active | stopped | exhausted, step, round, nextAt }`, and every job re-checks it first:
a step or page that slips past an acknowledgement pages nobody. Pages carry the signed acknowledge link
(`/ack/<token>`). Phone calls (#146) and other channels plug in as notification channel types.

Access: `on-call:read` (viewer) and `on-call:manage` (member) for schedules and overrides,
`escalation-policy:read` (viewer) and `escalation-policy:manage` (admin) for policies. Members write through
`/api/orgs/:orgId/on-call/**` with `overrideAccess: false`; the collection hooks require every person on call
to be a member and every schedule and channel of a policy to belong to the organization. Changes are audited
(`on_call_schedule.*`, `escalation_policy.*`) and announced with the `onCall` realtime event. Routes:
`GET /api/orgs/:orgId/on-call` (who is on call now or `?at=`), `…/on-call/shifts` (upcoming shifts, the
member's own by default), `…/on-call/schedules/**`, `…/on-call/escalation-policies/**`; UI: `/[orgSlug]/on-call`.

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

**Audience pages** (#151, access mode `audience`) show each visitor only the components of their
audiences (`status-page-audiences`). The scope is attached to the page object itself
(`src/server/status-pages/audiences.ts`): `findPublishedStatusPage` returns such a page without groups,
the access check's grant (`decision.audience`) feeds `scopePageForVisitor`, which puts back only the
visitor's rows, and the incident and maintenance loaders (`findActiveIncidents`, `findRecentIncidents`,
`findFeedIncidents`, `getActiveMaintenanceForStatusPage`, `listMaintenanceEvents`, the history index)
take that page and drop what names only invisible components. Subscriber fan-out applies the same rule
per subscriber through its `audiences` (`recipientFilter`, `namesForSubscriber`).

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

### OpenTelemetry export

`registerOtelListener()` (`src/server/otel/listener.ts`, #99) is a heartbeat listener of the worker and of
the web process's beat pipeline (push monitors, probe results). For each beat that ran a check it resolves
the monitor's collector (`otel-collectors`, org-scoped: the monitor's `otlpCollector`, else the
organization's active `default` one; `monitors.otlpExport = false` opts out; cached for 30 s per process,
`resolve.ts`), turns the beat into data points (`metrics.ts`: duration, timing phases, status, a cumulative
error counter kept per monitor and location in the process, ping packet loss) and queues them on the
collector's `OtelExporter` (`exporter.ts`), one per collector and process. The exporter batches for
`OTLP_EXPORT_INTERVAL_MS` or `OTLP_EXPORT_MAX_BATCH` points and POSTs the OTLP/HTTP JSON encoding
(`encode.ts`, no OpenTelemetry SDK) through `guardedFetch`, retrying 408/429/502/503/504 and network
errors; the outcome is written to the collector's `lastExportAt` / `lastError` at most once a minute
unless it changes. Collector headers are sealed with `encryptSecret` (`headers.ts`) and written only by the
management routes (`manage.ts`).

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
monitors[] }` (active and paused monitors, with what the list searches and filters on: type, target,
description, resolved tags, channel and location ids), then per monitor `heartbeatList` (last 100 beats, oldest →
newest), `importantHeartbeatList` (last 50 status transitions), `uptime` and `avgPing` for `24h` and `30d`
(`src/server/stats/uptime-calculator.ts`) and `lastIncident` (the newest monitor incident, for
the monitor table; later changes arrive as `monitorIncident`). `loadOrgState()` in `src/server/realtime/state.ts` builds that
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

Four org-scoped collections hold resources that monitors reference (managed under
`/{orgSlug}/settings/tags|proxies|docker-hosts|ssh-tunnels`):

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
- **`ssh-tunnels`** (#160: `name`, `host`, `port`, `username`, `authMethod` = `password | privateKey`,
  `password` / `privateKey` / `passphrase`, `knownHostFingerprint`, `hasPassword` / `hasPrivateKey` /
  `hasPassphrase`). The credentials are sealed in `beforeChange` (`src/server/ssh-tunnels/secrets.ts`,
  AES-256-GCM keyed from `PAYLOAD_SECRET`, purpose `marmot:ssh-tunnel-secret`) and have field read access
  `() => false`, so only server code reading with `overrideAccess` ever sees them; an empty value on update
  keeps the stored one. `monitor.sshTunnel` is allowed for `SSH_TUNNEL_MONITOR_TYPES`
  (`src/lib/ssh-tunnels.ts`), never together with a proxy or probe locations. `runCheck()` opens the
  tunnel before the type's `check()` (`openCheckTunnel()`, `src/server/ssh-tunnels`): the worker's pool
  holds one ssh2 connection per tunnel (host key verified against the SHA-256 fingerprint before
  authenticating, keepalive 15 s × 3, dropped from the pool on close, re-opened by the next check, closed
  after 5 idle minutes, replaced when the tunnel's settings change), and a per-check `TunnelSession`
  exposes `ctx.tunnel`: `endpoint(host, port)` returns a `127.0.0.1` listener whose connections are
  forwarded with `forwardOut`, `probe(host, port)` opens and closes one channel (TCP port type). Types
  point their driver at the endpoint in place of the outbound guard's hooks (undici connector, pg/mysql2
  `stream`, tedious `connector`, rewritten Redis URL and SMTP host, keeping the TLS server name). A tunnel
  that cannot be opened fails the check with `SSH tunnel <name> unreachable: <reason>`; a refused
  `forwardOut` is appended to the driver's error. `POST /api/orgs/:orgId/ssh-tunnels/test`
  (`ssh-tunnel:update`) connects once without the pool (`{ sshTunnelId }`, unsaved values, or
  `fetchFingerprint` to read the presented host key). Deleting a tunnel clears `monitor.sshTunnel`.

A `monitors` `beforeChange` hook rejects tags, proxies, Docker hosts and SSH tunnels of another
organization, so a member cannot borrow another tenant's proxy credentials, Docker daemon or bastion
through the API.

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

Monitor data written by the worker (`heartbeats`, `stat-minutely`/`-hourly`/`-daily`, `stat-location-hourly`,
`monitor-location-states`, `push-events`, `notification-sent-history`) is read through `orgScoped('monitor:read')` on its own `organization` field and
is never writable through the API. Server code that has already authorised the monitor (route handlers,
pages, `loadOrgState`) reads these rows with `overrideAccess: true`.

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
| `declared-incident:read`                                            |   ✓    |   ✓    |   ✓   |   ✓   |
| `declared-incident:create`, `declared-incident:update`              |        |   ✓    |   ✓   |   ✓   |
| `declared-incident:delete`, `declared-incident:skip-postmortem`     |        |        |   ✓   |   ✓   |
| `on-call:read`, `escalation-policy:read`                            |   ✓    |   ✓    |   ✓   |   ✓   |
| `on-call:manage` (schedules and overrides)                          |        |   ✓    |   ✓   |   ✓   |
| `escalation-policy:manage`                                          |        |        |   ✓   |   ✓   |
| `notification:read`                                                 |        |   ✓    |   ✓   |   ✓   |
| `notification:create`, `notification:update`, `notification:delete` |        |        |   ✓   |   ✓   |
| `status-page:read`                                                  |   ✓    |   ✓    |   ✓   |   ✓   |
| `status-page:create`, `status-page:update`, `status-page:delete`    |        |   ✓    |   ✓   |   ✓   |
| `status-page:history` (monthly uptime history and CSV export)       |        |        |   ✓   |   ✓   |
| `sla:read` (SLA targets and reports)                                |   ✓    |   ✓    |   ✓   |   ✓   |
| `sla:manage` (targets, scheduled reports, share links)              |        |        |   ✓   |   ✓   |
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
| `location:read`                                                     |   ✓    |   ✓    |   ✓   |   ✓   |
| `location:create`, `location:update`, `location:delete`             |        |        |   ✓   |   ✓   |
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

### API keys and the MCP server

Route handlers authenticate through `authenticateRequest` (`src/server/auth/request-auth.ts`): a session,
or on `/api/orgs/:orgId/**` an organization API key that becomes a synthetic `viewer`/`member` principal
([Integrations](Integrations.md#management-api)). The MCP endpoint (`/api/mcp`, `src/server/mcp`) adds no
business logic of its own: it verifies the key once per request, then each tool builds an in-process
`Request` for the matching route handler and marks it with `delegateApiKeyRequest` (a `WeakMap`, so no
client header can forge it). The handler runs its usual permission checks and validation; the delegated
path skips the key lookup and request budget already spent, and the audit hooks record changes with
actor type `mcp` (`apiKey.via`, `mcpActor` in `src/server/audit/context.ts`)
([MCP](MCP.md)).

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

## Account security: email verification

Optional (#177, `requireEmailVerification` instance setting, default `REQUIRE_EMAIL_VERIFICATION`),
implemented in `src/server/auth/email-verification.ts` on top of reusable email-token plumbing:

- **Tokens** (`src/server/auth/email-tokens.ts`, meant to be shared with passwordless sign-in links):
  256-bit random tokens, only the SHA-256 digest stored in Redis (`marmot:auth-token:<purpose>:<digest>`
  with the user id and the normalized address, expiring by TTL). A token is bound to its `purpose`,
  redeemed at most once (`GET` + `DEL` in one `MULTI`, so no database transaction is needed), and
  issuing a new one for the same user and purpose revokes the previous one.
- **State** (`users.emailVerified`, default `true`, so existing rows and every server-side creation are
  verified; `emailVerifiedAt`). Both are writable by superadmins only. A `users.beforeOperation` hook notes
  whether a create or update comes from a client (`overrideAccess` off, not a superadmin); `beforeChange`
  then stores `false` for such a sign-up, or an address change, while verification is required, and
  `afterChange` mails the link (`/verify-email?token=…`, 24 hours) and audits
  `auth.email_verification_sent`.
- **Gate**: `requireVerifiedEmail` (`beforeOperation`, create) on `organizations`, `invitations` and
  `notifications` throws `emailNotVerified` (403) for a pending, non-superadmin user while the setting is
  on; `requireUser()` sends such a user to `/verify-email`. Logins are not blocked.
- **Confirmation**: `POST /api/auth/verify-email` redeems a link when the address still matches;
  `acceptInvitation()` confirms an account whose address the invitation was sent to; the SSO
  `afterLogin` hook confirms one whose identity asserts the address, and `mapNewUser` provisions SSO
  accounts unverified only when the provider does not vouch for the address. Each records
  `auth.email_verified { method }`. `POST /api/auth/verify-email/resend` is limited per account like
  password reset mail (5 per 15 minutes).

## Account security: sign-in links

Passwordless sign-in (#164, `magicLinkEnabled` instance setting, default `MAGIC_LINK_ENABLED`, off) lives in
`src/server/auth/magic-link.ts` on the same token plumbing (purposes `magic-link` for an existing account and
`magic-link-signup` for an address without one, keyed by `addressTokenSubject(email)`; 15 minutes):

- **Request** (`POST /api/auth/magic-link`): rate limited per client IP (`magic-link-ip`, or the shared
  `magic-link-instance` bucket without a trusted address) and per address digest (`magic-link-email`, 5 per
  15 minutes), then answered `202 { sent: true }` before the account lookup, which runs in the background
  (`deliver`, `settleMagicLinkDeliveries` in tests), so neither the body nor the timing reveals whether the
  address has an account. The mail links to `/login/magic-link?token=…`, a confirm page.
- **Redeem** (`POST /api/auth/magic-link/verify`): consumes the token, checks the account still has the
  address (or creates the account: `allowSignup`, or a pending invitation that is then accepted;
  `authProvider: 'magic-link'`, random password, verified), applies the password policy
  (`passwordDecision(…, { local: false })`) and confirms the address (`markEmailVerified`, method
  `magic-link`). Accounts with 2FA get the usual challenge (`issueTwoFactorChallenge(id, 'magic-link')`; the
  challenge remembers the first factor so `/api/auth/2fa` audits `auth.login { method: 'magic-link' }`);
  others get a session from `createPayloadSessionCookie`.
- **Policy**: links count as a local login. `isMagicLinkEnabled` is false in the SSO-only mode (no
  break-glass through links); organization enforcement suppresses the mail and refuses redemption for
  members on verified domains, while owners and superadmins pass with an `auth.break_glass` row.

## Billing (future)

`organizations.plan` + `src/lib/entitlements.ts` express limits. On self-hosted installs everything is
unlimited and `BILLING_ENABLED=false`. When enabled, `@payloadcms/plugin-stripe` is registered and the Billing
settings tab appears.

## Demo mode

`DEMO_MODE` (#159, `src/server/demo/`) turns an instance into a self-resetting demo
([Demo mode](Demo-Mode.md)). The `demo-reset` job scheduler on `marmot:maintenance` (plus a boot job)
wipes every collection in batches (`deleteInBatches`, in an order that never leaves a required reference
dangling) and reseeds `dataset.ts` through the Local API, then back-fills heartbeats and stat roll-ups
through `payload.db.create`. `runCheck` returns `simulateCheck()` instead of running the type's check, and
the `demo-probes` job feeds the seeded probe locations' results through `ingestProbeResults`. Guard rails
are collection hooks added by `withDemoGuards` in the collection registry, route refusals
(`demoRefusal`), the sink (notifications, email adapter, webhooks) and a deny-all outbound address policy.
Payload's `onInit` refuses to start against a database with non-demo accounts.
