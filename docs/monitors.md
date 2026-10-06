# Monitors

A monitor is one thing Marmot checks on a schedule: a URL, a host and port, a DNS name, a database, or a
system that reports in by itself. Each check produces a **heartbeat** (`up`, `down`, `pending` or
`maintenance`, with a message and a response time), the heartbeats feed the uptime statistics and the
status pages, and status changes trigger notifications. Monitors belong to an organization; viewers can
see them, members and above can create, edit, pause and delete them
([organizations-and-members.md](organizations-and-members.md)).

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

HTTP monitors also support request method and body, extra headers, redirects, `ignoreTls`, basic/bearer/
OAuth2 client-credentials/NTLM/mTLS authentication and certificate-expiry alerts. The extended set adds gRPC, WebSocket, MQTT, Kafka, RabbitMQ, SMTP, SNMP, NTP, SFTP, RADIUS, Tailscale
ping, MySQL/MariaDB, PostgreSQL, SQL Server, MongoDB, Redis, Steam and GameDig checks plus a remote-browser
HTTP check; every field of every type is listed in [monitor-types.md](monitor-types.md).

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
monitor is never checked twice at once ([architecture.md](architecture.md#polling-engine)).

## The monitor page

`/{org}/monitors` lists every monitor with its live status, a bar of the last 100 heartbeats and the 24 h
uptime; it updates over the WebSocket connection without reloading. The detail page adds:

- uptime for 24 h and 30 d, average and current response time;
- a response-time chart;
- the list of **important events** (status changes with their message);
- the certificate panel for HTTPS targets (issuer, expiry; filled by the certificate job landing in the
  current release);
- actions: **Pause/Resume**, **Edit**, **Clone**, **Delete**.

Statistics are kept as minutely (24 h), hourly (30 d) and daily (`KEEP_DATA_PERIOD_DAYS`, default one
year) buckets, so a monitor's history survives the pruning of raw heartbeats after 24 hours.

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
in ms; every call records a heartbeat and stamps `lastPushAt`. See [integrations.md](integrations.md) for
the full reference, badges and API keys.

## Pause, resume, clone, delete

- **Pause** sets `active: false`: the scheduler is removed, no checks run, the monitor keeps its history and
  shows as paused in lists and on status pages (paused monitors are dropped from public pages). **Resume**
  re-creates the scheduler and the next check runs immediately.
- **Clone** copies every setting into a new, **paused** monitor named "… (copy)" so you can adjust the
  target before it starts checking. The status cache starts empty and push monitors get a fresh token.
- **Delete** removes the monitor, its heartbeats and its statistics, and detaches child monitors from a
  deleted group.

## Notifications, maintenance and tags

- **Notifications**: the channels attached to the monitor (`monitors.notifications`) are alerted on
  important beats. Channels flagged as default attach to every new monitor and **Apply to all existing
  monitors** attaches a channel to the current ones; a per-monitor picker in the form is landing in the
  current release. See [notifications.md](notifications.md).
- **Maintenance**: a monitor inside an active maintenance window reports MAINTENANCE instead of DOWN and does
  not notify; see [maintenance.md](maintenance.md) _(landing in the current release)_.
- **Tags** (coloured labels with optional values, shown in lists and on status pages) are planned next to
  proxies and the Docker monitor type; the status-page `showTags` switch is already there.

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
| `GET /api/monitors` (Payload REST)               | List with Payload's `where`/`limit`/`sort` syntax |

Requests from outside the browser must send the `payload-token` cookie or a `JWT` `Authorization` header
(`POST /api/users/login` returns one) and an `Origin` matching `NEXT_PUBLIC_SERVER_URL`. Organization API
keys give machine access to badges and metrics ([integrations.md](integrations.md)).
