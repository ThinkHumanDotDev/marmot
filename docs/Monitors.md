# Monitors

A monitor is one thing Marmot checks on a schedule: a URL, a host and port, a DNS name, a database, or a
system that reports in by itself. Each check produces a **heartbeat** (`up`, `down`, `pending` or
`maintenance`, with a message and a response time), the heartbeats feed the uptime statistics and the
status pages, and status changes trigger notifications. Monitors belong to an organization; viewers can
see them, members and above can create, edit, pause and delete them
([Organizations and members](Organizations-and-Members.md)).

## Types

The type decides what a check does and which fields the form shows. The built-in set on `main`:

| Group   | Type                 | UP when                                                                      |
| ------- | -------------------- | ---------------------------------------------------------------------------- |
| General | HTTP(s)              | the response status is in `acceptedStatusCodes` (default `200-299`)          |
| General | HTTP(s) - Keyword    | the response body contains the keyword (or lacks it with `invertKeyword`)    |
| General | HTTP(s) - Json Query | a JSONata expression over the JSON response compares as expected             |
| General | TCP Port             | a TCP connection to `hostname:port` succeeds                                 |
| General | Ping                 | the host answers ICMP echo requests                                          |
| General | DNS                  | the resolver returns a record of `dnsResolveType` for `hostname`             |
| Passive | Push                 | your system called `/api/push/<token>` within the interval (plus 10 % grace) |
| Passive | Manual               | you set the status by hand; nothing is checked                               |
| Special | Group                | every child monitor is UP                                                    |
| Special | Docker Container     | the container is running (and healthy, when it has a health check)           |

HTTP monitors also support request method and body, extra headers, redirects, `ignoreTls`, basic/bearer/
OAuth2 client-credentials/NTLM/mTLS authentication and certificate-expiry alerts. The extended set adds gRPC, WebSocket, MQTT, Kafka, RabbitMQ, SMTP, SNMP, NTP, SFTP, RADIUS, Tailscale
ping, MySQL/MariaDB, PostgreSQL, SQL Server, MongoDB, Redis, Steam and GameDig checks plus a remote-browser
HTTP check; every field of every type is listed in [Monitor types](Monitor-Types.md).

Marmot's type set follows Uptime Kuma's, so a monitor you know from there behaves the same here (the check
code is in many cases a direct port, see `THIRD_PARTY_NOTICES.md`).

## Intervals, retries and timeouts

| Field            | Default | Meaning                                                                                                              |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `interval`       | 60 s    | Seconds between checks. The UI minimum is 20 s.                                                                      |
| `maxRetries`     | 0       | Failed checks tolerated before the monitor goes DOWN. While retrying the monitor is PENDING.                         |
| `retryInterval`  | 60 s    | Seconds between checks while PENDING (usually shorter than `interval` to confirm an outage quickly).                 |
| `resendInterval` | 0       | Re-send the DOWN notification every N consecutive DOWN beats. `0` notifies once per transition.                      |
| `timeout`        | 48 s    | Seconds before a check is aborted. `0` means 80 % of the interval.                                                   |
| `upsideDown`     | off     | Invert the result: a failed check counts as UP and a successful one as DOWN (useful for "this port must be closed"). |

The state machine (a port of Uptime Kuma's) is:

```
maintenance window active  → MAINTENANCE (no notifications)
check ok                   → UP
check failed, retries left → PENDING, next check after retryInterval
check failed, no retries   → DOWN
```

Only **important** beats (a change between UP, DOWN and MAINTENANCE, or the first beat when it is DOWN)
notify. PENDING never notifies, so `maxRetries: 2` with `retryInterval: 20` gives a flaky endpoint 40 seconds
to recover before anyone is paged.

Scheduling is handled by the worker process through BullMQ job schedulers (one per active monitor); the
web process only writes the monitor and nudges the scheduler. Several worker replicas share the load and a
monitor is never checked twice at once ([Architecture](Architecture.md#polling-engine)).

## The monitor page

`/{org}/monitors` lists every monitor with its live status, a bar of the last 100 heartbeats and the 24 h
uptime; it updates over the WebSocket connection without reloading. The detail page adds:

- uptime for 24 h and 30 d, average and current response time;
- a response-time chart;
- the list of **important events** (status changes with their message);
- the certificate panel for HTTPS targets (issuer, expiry; filled by the certificate job landing in the
  current release);
- the notification channels the monitor alerts through;
- its **recent incidents** (see below);
- actions: **Pause/Resume**, **Edit**, **Clone**, **Delete**.

Statistics are kept as minutely (24 h), hourly (30 d) and daily (`KEEP_DATA_PERIOD_DAYS`, default one
year) buckets, so a monitor's history survives the pruning of raw heartbeats after 24 hours.

## Incidents

An outage is recorded as an **incident** (`monitor-incidents`), so a team can see who is on it and how long it
took. This is the internal, on-call side of an outage; the public side is the status-page incident
([Status pages](Status-Pages.md)), and one can be created from the other.

- **Opened** by the engine on the transition to DOWN (from UP, PENDING, MAINTENANCE or a first DOWN beat), with
  the message of that beat as its **cause**. A monitor has at most one unresolved incident.
- **Acknowledged** by a member: from the incident page, the API or the signed link at the end of DOWN
  messages. While an incident is acknowledged, `resendInterval` reminders stop; the acknowledgement is sent to
  the monitor's channels (`[name] [👀 Acknowledged] Acknowledged by Ada.`).
- **Resolved** automatically when the monitor recovers (UP), with the duration shown. A member can also
  resolve it by hand (the channels are told); it then stays resolved until the monitor recovers and fails
  again. Entering MAINTENANCE adds a note and keeps it open.
- Every step is on the incident's **timeline**, with who did it and an optional note.

`/{org}/incidents` lists incidents with filters (status, monitor, period), each one's duration and who
acknowledged or resolved it, and a summary of the period: count, unresolved, **MTTA** (mean time to
acknowledge) and **MTTR** (mean time to resolve). The list and the incident page update live. **Publish to
status page** creates a public status-page incident (status "investigating", the page's components that show
the monitor marked as major outage) and links it; resolving the monitor incident does not post to the status
page, so public updates stay deliberate.

Viewers see incidents (`monitor-incident:read`); members acknowledge and resolve them
(`monitor-incident:acknowledge`, `monitor-incident:resolve`); publishing also needs `status-page:update`.
Incidents go with their monitor when it is deleted. A monitor that is already DOWN when this feature is
deployed gets its incident on its next transition to DOWN.

The acknowledge link (`/ack/<token>`) is signed with a key derived from `PAYLOAD_SECRET`, names one incident and
expires after seven days. It opens a page with an **Acknowledge** button, so link previews in chat apps cannot
acknowledge. Anyone holding the message can use it: a signed-in member is recorded by name, anyone else as
"from a notification link".

## Groups

A **Group** monitor has no target of its own; set `parent` on other monitors to put them inside it. The
group is UP when all children are UP, DOWN as soon as one child is DOWN, and PENDING while a child is
retrying. Groups nest, show as a tree in the monitor list and can be placed on status pages like any other
monitor, which is the easy way to publish "API: operational" over a dozen internal checks. Deleting a group
detaches its children instead of deleting them.

## Push monitors

A push monitor is checked by **your** system: cron jobs, backup scripts, IoT devices, anything that can make
an HTTP request. Create a monitor of type _Push_; Marmot generates a `pushToken` and shows the URL to call.
The worker's periodic check only verifies that a push arrived within `interval` plus a 10 % grace period and
marks the monitor DOWN otherwise; `maxRetries` and `upsideDown` apply as usual.

```bash
# at the end of your job
curl -fsS "https://status.example.com/api/push/<token>?status=up&msg=OK&ping=12"
```

The endpoint accepts `GET` or any other method, `status=up|down`, a free-text `msg` and an optional `ping`
in ms; every call records a heartbeat and stamps `lastPushAt`. See [Integrations](Integrations.md) for
the full reference, badges and API keys.

## Public name

The optional **Public name** (`publicName`) is what status pages show instead of the monitor's friendly
name, so `prod-api-eu-west-1 /healthz` can appear as "API". A status page component can override it again
with its own name (see [Status pages → Components](Status-Pages.md#components)).

## Pause, resume, clone, delete

- **Pause** sets `active: false`: the scheduler is removed, no checks run, the monitor keeps its history and
  shows as paused in lists and on status pages (paused monitors are dropped from public pages). **Resume**
  re-creates the scheduler and the next check runs immediately.
- **Clone** copies every setting, tags and notification channels included, into a new, **paused**
  monitor named "… (copy)" so you can adjust the target before it starts checking. The status cache starts empty and push monitors get a fresh token.
- **Delete** removes the monitor, its heartbeats and its statistics, and detaches child monitors from a
  deleted group.

## Notifications, maintenance and tags

- **Notifications**: the channels attached to the monitor (`monitors.notifications`) are alerted on
  important beats. Pick them in the **Notifications** card of the monitor form: it lists the organization's
  active channels, with the channels flagged as default already switched on for a new monitor. A change
  takes effect from the next status change. The detail page lists the attached channels (read-only for
  viewers) with a **Test** button for admins. From the channel side, **Monitors** in a channel's menu on
  the Notifications page attaches or detaches it in bulk, and **Apply to all existing monitors** attaches
  a channel to every current monitor. Clone keeps the channels and export/import carries them. The API
  takes `notifications: [id, …]` on `POST`/`PATCH /api/orgs/:orgId/monitors`; a create without the key
  gets the default channels. See [Notifications](Notifications.md).
- **Maintenance**: a monitor inside an active maintenance window reports MAINTENANCE instead of DOWN and does
  not notify; see [Maintenance](Maintenance.md) _(landing in the current release)_.
- **Tags**: coloured labels with optional values (`env: prod`), managed under Settings → Tags, shown in the
  monitor list, on the detail page and on status pages with `showTags` on.
- **Proxies**: HTTP-type monitors can send their requests through an HTTP(S) or SOCKS proxy (Settings →
  Proxies); the organization's default proxy is preselected for new monitors.
- **Docker**: the `docker` type checks a container's state on a Docker host (Settings → Docker hosts; local
  socket or `tcp://`/`https://`). `DOCKER_SOCKET_ENABLED=false` forbids socket hosts on shared instances.
  Details in [Architecture](Architecture.md#tags-proxies-and-docker-hosts).

## API

Monitors are managed through org-scoped route handlers that authenticate the Payload session and apply the
same permissions as the UI (`monitor:read` for viewers, `monitor:create|update|delete` for members):

| Method & path                                    | Purpose                                           |
| ------------------------------------------------ | ------------------------------------------------- |
| `POST /api/orgs/:orgId/monitors`                 | Create (body validated by `monitorFormSchema`)    |
| `PATCH` / `DELETE /api/orgs/:orgId/monitors/:id` | Update / delete                                   |
| `POST /api/orgs/:orgId/monitors/:id/pause`       | Pause                                             |
| `POST /api/orgs/:orgId/monitors/:id/resume`      | Resume                                            |
| `POST /api/orgs/:orgId/monitors/:id/clone`       | Clone (returns the new, paused monitor)           |
| `GET /api/monitors/:id/stats?range=24h\|30d\|1y` | Uptime, average ping and buckets for a range      |
| `GET /api/orgs/:orgId/monitor-incidents`         | Incidents + MTTA/MTTR (see below)                 |
| `GET /api/monitors` (Payload REST)               | List with Payload's `where`/`limit`/`sort` syntax |

Incident routes (`monitor-incident:*` permissions; ids are strings on MongoDB and numbers on Postgres):

| Method & path                                             | Purpose                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/orgs/:orgId/monitor-incidents`                  | `?status=active\|all\|open\|acknowledged\|resolved`, `monitor`, `range=24h\|7d\|30d\|90d\|all` (by start, default `30d`), `page`, `limit` → `{ docs, page, totalPages, totalDocs, stats }` |
| `GET /api/orgs/:orgId/monitor-incidents/:id`              | One incident with its timeline                                                                                                                                                             |
| `POST /api/orgs/:orgId/monitor-incidents/:id/acknowledge` | `{ note? }`; 409 unless open                                                                                                                                                               |
| `POST /api/orgs/:orgId/monitor-incidents/:id/resolve`     | `{ note? }`; 409 when already resolved                                                                                                                                                     |
| `POST /api/orgs/:orgId/monitor-incidents/:id/publish`     | `{ statusPageId, title?, message?, status?, impact? }` → `{ incident, statusPageIncident }` (201); 409 when already published                                                              |
| `POST /api/incident-ack`                                  | `{ token }` from the signed link; no session needed                                                                                                                                        |
| `GET /api/monitor-incidents` (Payload REST, read only)    | Payload's `where`/`limit`/`sort` syntax                                                                                                                                                    |

`stats` holds `total`, `open`, `acknowledged`, `resolved`, `mtta` and `mttr` (seconds, `null` without data)
over the monitor and period filters. An incident reads `{ id, monitor { id, name }, status, cause, startedAt,
acknowledgedAt, acknowledgedBy { id, name }, acknowledgedVia (dashboard | api | link), resolvedAt,
resolvedBy, autoResolved, remindersSent, lastReminderAt, statusPageIncident, timeline[] { type, at, by, via,
message } }`; the realtime `monitorIncident` event carries the same object.

Requests from outside the browser must send the `payload-token` cookie or a `JWT` `Authorization` header
(`POST /api/users/login` returns one) and an `Origin` matching `NEXT_PUBLIC_SERVER_URL`. Organization API
keys give machine access to badges and metrics ([Integrations](Integrations.md)).
