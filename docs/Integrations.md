# Integrations: badges, push monitors, Prometheus, API keys, webhooks

Marmot's machine-facing endpoints live under `src/app/api/` and mirror Uptime Kuma's, so existing
README badges, cron jobs and Grafana dashboards keep working after a switch.

| Endpoint                                     | Auth                                               | Purpose                                           |
| -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `GET /api/badge/:monitorId/<type>[/<range>]` | public status page **or** API key of the org       | shields.io-style SVG badges                       |
| `ALL /api/push/:token[/<signal>]`            | the monitor's push token                           | heartbeat for push monitors                       |
| `GET /api/metrics`                           | API key                                            | Prometheus exposition                             |
| `/api/orgs/:orgId/**`                        | session **or** API key of the org (scoped)         | management API                                    |
| `GET /api/openapi.json`, `GET /api/docs`     | public                                             | management API reference                          |
| `POST /api/mcp`, `GET /.well-known/mcp.json` | API key of the org (scoped) / public               | [MCP server for AI agents](MCP.md)                |
| `GET/POST /api/orgs/:orgId/api-keys`         | session, `api-key:read` / `api-key:create` (admin) | manage keys                                       |
| `PATCH/DELETE /api/orgs/:orgId/api-keys/:id` | session, `api-key:delete` (admin)                  | disable / re-enable / revoke                      |
| `GET /api/orgs/:orgId/audit-logs[/export]`   | session, `audit-log:read` (admin)                  | [audit log](Security.md#audit-log) as JSON or CSV |
| `GET/POST /api/orgs/:orgId/webhooks[/:id/…]` | session, `webhook:read` / `webhook:manage` (admin) | [outbound webhooks](#outbound-webhooks)           |

## API keys

API keys belong to an **organization**, not a user, and are managed by admins and owners under
**Settings → API keys** (`/{orgSlug}/settings/api-keys`). A key looks like

```
mk_<prefix>_<secret>
```

`mk_` marks a Marmot key, the 8-character `prefix` is the public identifier shown in the list, and the
secret is 32 random bytes. Only the SHA-256 of the full key is stored (`api-keys.keyHash`); the plaintext is
returned exactly once by `POST /api/orgs/:orgId/api-keys` (`{ doc, key }`) and shown once in the UI with a
copy button. Keys can carry an expiry (`expiresAt`, or `expiresInDays` on create), be disabled
(`PATCH { active: false }`) and revoked (`DELETE`). `lastUsedAt` is stamped on use, at most once a minute.

Send the key in any of these ways:

```
Authorization: Bearer mk_…
X-API-Key: mk_…
Authorization: Basic base64(<anything>:mk_…)   # Prometheus basic_auth
```

Server side, `authenticateApiKey(payload, request)` (`src/server/api-keys`) resolves a request to
`{ organizationId, apiKey, scope }` or `null` (missing, unknown, disabled, expired). Endpoints then scope
their queries to that organization. Keys are deliberately **not** a Payload auth strategy: they never grant
access to Payload's REST/GraphQL API (`/api/<collection>`) or the UI.

### Scopes

Every key has a `scope`, chosen on creation and fixed afterwards (keys created before scopes existed are
`read`):

| Scope   | Methods                  | Acts as  | Typical use                                                                    |
| ------- | ------------------------ | -------- | ------------------------------------------------------------------------------ |
| `read`  | `GET`, `HEAD`            | `viewer` | Prometheus, badges, dashboards, reporting                                      |
| `write` | all (`POST`, `PATCH`, …) | `member` | CI/CD, Terraform, the CLI, MCP: monitors, status pages, incidents, maintenance |

## Management API

The route handlers under `/api/orgs/:orgId/**` that the UI uses are the management API. They accept a
signed-in session or an API key of the organization in the URL. A key is turned into a synthetic principal
with a single membership (`viewer` for `read`, `member` for `write`), so the same permission checks,
per-organization overrides and collection access apply as for a person with that role
(`src/server/auth/request-auth.ts`). On top of that:

- a key of another organization gets `403`; an unknown, disabled or expired key `401`;
- `read` keys get `403` on anything but `GET`/`HEAD`/`OPTIONS`;
- keys never reach member, invitation, invite-link, API key, audit log, SSO, billing, permission or ownership routes
  (`403`), whatever the organization's permission overrides say;
- each key may send `API_KEY_RATE_LIMIT` requests per minute (default 600), of which
  `API_KEY_WRITE_RATE_LIMIT` (default 60) may be writes; above that the API answers `429` with
  `Retry-After` ([Configuration](Configuration.md#authentication));
- changes made with a key appear in the [audit log](Security.md#audit-log) like any other
  (`monitor.created`, `incident.updated`, …) with actor type `apiKey` and the key's name (actor type `mcp`
  and the key's name plus the tool when the change came through the [MCP server](MCP.md)), so automation
  is told apart from people; the key's own life cycle is `api_key.created`, `api_key.enabled`,
  `api_key.disabled` and `api_key.revoked`;
- keys are not password logins: SSO-only mode (`OIDC_DISABLE_LOCAL_LOGIN`) and organizations'
  `enforceSso` do not affect them (revoke or disable keys to cut automation off);
- outbound webhooks (`/api/orgs/:orgId/webhooks/**`) follow the permissions like any other resource:
  `webhook:read` and `webhook:manage` are admin-only by default, so keys reach them only where the
  organization lowered them to `viewer` (read keys) or `member` (write keys); signing secrets are only
  ever returned by create and rotate. Changes made with a key reach webhooks with `actor.type: apiKey`;
- on-demand checks (`POST …/monitors/:id/check`, `POST …/checks`) need a `write` key and share the
  organization's `ON_DEMAND_CHECKS_PER_MINUTE` budget; monitor-incident acknowledgements and resolutions
  made with a key are recorded with source `api`.

The API is described by an OpenAPI 3.1 document at `/api/openapi.json` (request bodies are generated from
the same zod schemas the handlers validate with) and browsable at `/api/docs`. Each operation carries
`x-marmot-api-key-scope` (`read`, `write`, or `null` for session-only routes) and
`x-marmot-permission`.

```sh
curl -H "Authorization: Bearer $MARMOT_KEY" https://marmot.example.com/api/orgs/1/monitors
curl -H "Authorization: Bearer $MARMOT_KEY" 'https://marmot.example.com/api/orgs/1/monitors/7/stats?range=30d'
curl -H "Authorization: Bearer $MARMOT_KEY" 'https://marmot.example.com/api/orgs/1/monitors/7/heartbeats?limit=20'
curl -X POST -H "Authorization: Bearer $MARMOT_KEY" -H 'content-type: application/json' \
  -d '{"name":"API","type":"http","url":"https://api.example.com/health","interval":60}' \
  https://marmot.example.com/api/orgs/1/monitors
```

## Badges

```
/api/badge/:monitorId/status
/api/badge/:monitorId/uptime[/24h|30d|1y]        (also 24, 720, 8760 hours)
/api/badge/:monitorId/ping[/24h|30d|1y]
/api/badge/:monitorId/avg-response[/24h|30d|1y]
/api/badge/:monitorId/cert-exp
/api/badge/:monitorId/response
```

For one badge with the overall state of a whole status page, see
[Status pages → Status badge](Status-Pages.md#status-badge).

Badges are rendered with [`badge-maker`](https://www.npmjs.com/package/badge-maker) (the shields.io
renderer) and answered with `Content-Type: image/svg+xml`, `Cache-Control: public, max-age=300` and
`Access-Control-Allow-Origin: *`.

**Who can see a badge.** A badge is served when the monitor appears in a group of a **published status
page**, or when the request carries an API key of the monitor's organization (for private dashboards:
`<img src="https://marmot.example.com/api/badge/42/uptime/30d">` cannot send headers, so use a status page
for README badges). Everything else — unknown ids, monitors of other organizations, unpublished pages — is a
`404`, so badge URLs do not reveal which ids exist.

**Query parameters** (all optional, same names as Uptime Kuma):

| Parameter                                                                   | Badges                                         | Default                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `style`                                                                     | all                                            | `flat` (`plastic`, `flat-square`, `for-the-badge`, `social`)                                |
| `label`                                                                     | all                                            | `Status`, `Uptime (24h)`, `Avg. Ping (24h)`, `Avg. Response (24h)`, `Cert Exp.`, `Response` |
| `labelPrefix`, `labelSuffix`                                                | uptime, ping, avg-response, cert-exp, response | —                                                                                           |
| `prefix`, `suffix`                                                          | uptime, ping, avg-response, cert-exp, response | suffix `%`, `ms`, ` days`                                                                   |
| `color`, `labelColor`                                                       | uptime, ping, avg-response, response           | uptime: red→green by ratio; others `blue`                                                   |
| `upLabel`, `downLabel`, `pendingLabel`, `maintenanceLabel`, `degradedLabel` | status                                         | `Up`, `Down`, `Pending`, `Maintenance`, `Degraded`                                          |
| `upColor`, `downColor`, `pendingColor`, `maintenanceColor`, `degradedColor` | status (`upColor`/`downColor` also cert-exp)   | `#66c20a`, `#c2290a`, `#f8a306`, `#1747f5`, `#eed202`                                       |
| `warnColor`, `warnDays`, `downDays`                                         | cert-exp                                       | `#eed202`, `14`, `7`                                                                        |
| `date`                                                                      | cert-exp                                       | show the expiry date instead of remaining days                                              |

Uptime and ping figures come from the stats rollups (`getUptime` / `getAvgPing`, see
[Architecture](Architecture.md)), `status` and `response` from the monitor's cached last heartbeat, `cert-exp`
from `monitors.certInfo` once the certificate-expiry job (#24) stores it ("No/Bad Cert" until then).
The pure builder is `buildBadge()` in `src/server/badges/badge.ts`.

## Push monitors

Create a monitor of type **Push**; Marmot mints a `pushToken`. Call the URL from the system you monitor, by
any HTTP method:

```
curl "https://marmot.example.com/api/push/<token>?status=up&msg=OK&ping=12"
```

| Path                       | Signal                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| `/api/push/:token`         | success (`status=down` reports a failure, as in Uptime Kuma)                   |
| `/api/push/:token/start`   | a run started: it must finish within the grace period                          |
| `/api/push/:token/fail`    | explicit failure                                                               |
| `/api/push/:token/log`     | record an event (message and body) without changing the status                 |
| `/api/push/:token/<0-255>` | exit code: `0` is a success, anything else a failure (message `Exit code <n>`) |

| Query    | Values                                                | Default                                   |
| -------- | ----------------------------------------------------- | ----------------------------------------- |
| `status` | `up`, `down` (bare token URL only)                    | `up`                                      |
| `msg`    | free text (250 chars)                                 | `OK` (`Failure reported` for `/fail`)     |
| `ping`   | milliseconds, 0…10^11                                 | the duration of the paired run, if any    |
| `rid`    | run id (UUID or up to 64 letters, digits, `-` or `_`) | none: pairs with the latest anonymous run |

The response is `{ "ok": true }` with a `Ping-Body-Limit: 10000` header; unknown or paused tokens and
unknown signals return `404 { ok: false, msg }`, an invalid ping or `rid` `400`. The first 10 000 bytes of a
request body (POST, PUT, …) are stored with the signal, so a job can send its output:

```bash
# report start, exit code, duration and the last 10 000 bytes of output
url="https://marmot.example.com/api/push/<token>"
curl -fsS -m 10 --retry 5 -o /dev/null "$url/start"
output="$(/usr/local/bin/backup.sh 2>&1)"; code=$?
printf '%s' "$output" | tail -c 10000 | curl -fsS -m 10 --retry 5 -o /dev/null --data-binary @- "$url/$code"
```

The monitor page shows the same as copy-ready curl, bash-wrapper and crontab snippets, the schedule in
plain language ("Every day at 02:00 · Europe/Berlin"), the next expected ping and the **Ping log** (the
newest 100 signals with their output).

**What a signal does.** Successes and failures record a heartbeat through the engine (`recordExternalBeat`
in `src/server/engine/worker.ts`): maintenance windows, retries (`maxRetries` → PENDING) and `upsideDown`
apply exactly as for polled checks, the monitor's `status.lastPushAt` is stamped, and the stats, realtime
and notification listeners fire, so dashboards update live and channels are notified on transitions. A
`start` opens a run (`status.pushRuns`); the success or failure that closes it (same `rid`, otherwise the
latest run) stores the run's duration as the heartbeat's `ping`, so the response-time chart shows job
durations. A run longer than `pushMaxDuration` is reported DOWN. `log` only adds to the ping log.

**When a ping is late.** The periodic push check in the worker turns the monitor DOWN when the next ping is
overdue: `interval + grace` after the last success or failure, or, for cron schedules, the next occurrence
of the cron expression (in the schedule's time zone, DST-aware) plus grace. A started run that does not
finish within the grace period, or a reported failure, keeps it DOWN until the next success. Without a
configured grace the window is `interval + 10 %`, as before. See
[Monitor types](Monitor-Types.md#push-schedules-and-signals) for the fields and the exact rules.

## Prometheus metrics

`GET /api/metrics` with an API key returns the organization's monitors in Prometheus text format. The
registry is built per scrape from the database (`src/server/metrics/prometheus.ts`,
[`prom-client`](https://www.npmjs.com/package/prom-client)); nothing is kept in the web process.

```yaml
scrape_configs:
  - job_name: marmot
    scrape_interval: 60s
    metrics_path: /api/metrics
    scheme: https
    static_configs:
      - targets: ['marmot.example.com']
    authorization:
      type: Bearer
      credentials: mk_… # or basic_auth: { username: marmot, password: mk_… }
```

| Metric                        | Labels            | Value                                                                                                            |
| ----------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `monitor_status`              | common            | `1` up, `0` down, `2` pending, `3` maintenance, `4` degraded                                                     |
| `monitor_response_time`       | common            | last ping in ms (`-1` when the beat had no ping)                                                                 |
| `monitor_uptime_ratio`        | common + `window` | `0.0…1.0` over `24h` and `30d`                                                                                   |
| `monitor_cert_days_remaining` | common            | from `monitors.certInfo` (only when present)                                                                     |
| `monitor_cert_is_valid`       | common            | `1` / `0`, from `monitors.certInfo`                                                                              |
| `marmot_checker_online`       | `location`        | `1` online, `0` offline ([self connectivity check](Configuration.md#self-connectivity-check), only when enabled) |

Common labels: `monitor_id`, `monitor_name`, `monitor_type`, `monitor_url`, `monitor_hostname`,
`monitor_port` (empty string when a monitor has no such field). Names and labels match Uptime Kuma's
`server/prometheus.js`; `4` (degraded: a successful check slower than the monitor's `degradedAfter`) is a
Marmot addition, so alert rules written for Kuma that test `monitor_status == 1` should use
`monitor_status == 1 or monitor_status == 4` to keep treating slow checks as up. Monitors without a heartbeat
yet have no `monitor_status` sample. Without a valid
key the endpoint answers `401` with a `WWW-Authenticate` header.

## Outbound webhooks

Organizations can send **every event** that happens in them to their own HTTP endpoints: monitor state
changes, incidents, maintenance windows and every change the [audit log](Security.md#audit-log) records
(monitors, status pages, subscribers, members, …). Admins and owners manage endpoints under
**Settings → Webhooks** (`/{orgSlug}/settings/webhooks`; permissions `webhook:read` and `webhook:manage`,
both admin by default and adjustable under Settings → Permissions). Viewers and members see neither the
endpoints nor their delivery log, and nobody can read a secret back after it was shown.

An endpoint has a URL (`http://` or `https://`), an optional description, a list of **events** and a signing
**secret** (`whsec_…`), generated by Marmot and shown **once**, when the endpoint is created or its secret
rotated. Rotating keeps the previous secret signing next to the new one for 24 hours, so receivers can switch
without dropping deliveries.

### Events

Subscribe to exact types, to a whole group with a wildcard (`incident.*`, `monitor.*`) or to everything
(`*`, which also covers event types added later).

| Group           | Types                                                                                                                                                                                                                          | Source                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `monitor`       | `monitor.down`, `monitor.up`, `monitor.degraded`                                                                                                                                                                               | the engine's state machine (notifying beats) |
| `monitor`       | `monitor.created`, `updated`, `deleted`, `paused`, `resumed`, `cloned`                                                                                                                                                         | audit log                                    |
| `incident`      | `incident.opened`, `incident.update_posted`, `incident.resolved`, `incident.reopened`                                                                                                                                          | incident timeline                            |
| `incident`      | `incident.created`, `updated`, `deleted`                                                                                                                                                                                       | audit log                                    |
| `maintenance`   | `maintenance.scheduled`, `reminder`, `started`, `update_posted`, `completed`, `cancelled`                                                                                                                                      | maintenance windows                          |
| `maintenance`   | `maintenance.created`, `updated`, `deleted`, `paused`, `resumed`                                                                                                                                                               | audit log                                    |
| `member`        | `member.role_changed`, `member.removed`, `member.ownership_transferred`; `invitation.created`, `accepted`, `deleted`                                                                                                           | audit log                                    |
| everything else | `<entity>.created/updated/deleted` (and `enabled`/`disabled`/`revoked`) of status pages, subscribers, channels, tags, proxies, Docker hosts, templates, API keys, SSO, the organization, webhook endpoints; `import.completed` | audit log                                    |

The settings dialog lists every type; `WEBHOOK_EVENT_TYPES` in `src/lib/webhook-events.ts` is the
catalogue. `monitor.up` is sent when a monitor recovers from DOWN (to UP or DEGRADED) and when it goes back
from DEGRADED to UP; `monitor.degraded` when a successful check is slower than `degradedAfter`. Reminders
(`resendInterval`) are not webhook events. Opening an incident sends `incident.opened` **and**
`incident.update_posted` (its first timeline entry). Sign-ins and instance settings are never sent.

### Payload

Each delivery is a `POST` with a JSON body:

```jsonc
{
  "id": "evt_5c0e…", // event id: the same in every delivery and redelivery of this event
  "type": "incident.opened",
  "createdAt": "2026-10-07T12:00:00.000Z",
  "orgId": "1",
  "data": {
    // depends on the type, e.g. for incidents:
    "incident": {
      "id": "7",
      "publicId": "k3x9q2ab",
      "title": "API errors",
      "status": "investigating",
      "impact": "major_outage",
      "statusPage": "3",
      "resolvedAt": null,
    },
    "update": {
      "id": "66f1…",
      "status": "investigating",
      "message": "Markdown",
      "postedAt": "…",
      "components": [],
    },
    "previousStatus": null,
  },
}
```

- **monitor state** (`monitor.down|up|degraded`): `data.monitor { id, name, type, url, hostname }` (URL
  without credentials or query), `status`, `previousStatus`, `heartbeat { id, time, msg, ping }`.
- **maintenance windows**: `data.maintenance { id, title, description, strategy, statusPages, monitors }`,
  `data.occurrence { id, publicId, state, start, end, startedAt, completedAt, cancelledAt, … }`,
  `data.update` (the posted entry or `null`) and `data.reminderMinutes`.
- **audit events**: `data.object { type, id, label }`, `data.actor { type, id, label }` (user, API key,
  MCP or system), `data.changedFields`, `data.previous` / `data.current` (the audit log's redacted values:
  passwords, tokens and secrets never leave Marmot) and `data.metadata`, `data.auditLogId`.
- `webhook.test` (Send test event): `data { endpoint { id, url }, test: true }`; sent whatever the
  endpoint subscribes to.

Headers:

| Header                     | Value                                                                        |
| -------------------------- | ---------------------------------------------------------------------------- |
| `Content-Type`             | `application/json`                                                           |
| `User-Agent`               | `Marmot-Webhooks/1`                                                          |
| `X-Marmot-Webhook-Version` | `1`; bumped only for incompatible envelope changes                           |
| `X-Marmot-Event`           | the event type                                                               |
| `X-Marmot-Delivery`        | delivery id: stable across the retries of one delivery, new for redeliveries |
| `X-Marmot-Signature`       | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`            |

Use the event `id` to ignore duplicates (a retry after a timeout, a manual redelivery).

### Verifying signatures

Compute HMAC-SHA256 with the endpoint's secret over `<t>.<raw request body>` (the exact bytes received,
before any JSON parsing), compare it in constant time with each `v1=` value of the header (there are two
during a secret rotation; any match is valid), and reject timestamps older than five minutes to stop
replays. The same scheme signs [status page subscriber webhooks](Status-Pages.md);
`verifyWebhookSignature` in `src/server/webhooks/signature.ts` is the reference implementation.

Node.js (Express):

```js
import crypto from 'node:crypto'
import express from 'express'

const SECRET = process.env.MARMOT_WEBHOOK_SECRET // whsec_…
const TOLERANCE_SECONDS = 5 * 60

function verify(rawBody, header) {
  if (!header) return false
  const parts = header.split(',').map((part) => part.trim().split('='))
  const t = Number(parts.find(([key]) => key === 't')?.[1])
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value)
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false
  const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest()
  return signatures.some((value) => {
    const given = Buffer.from(value, 'hex')
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  })
}

const app = express()
app.post('/hooks/marmot', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req.body.toString('utf8'), req.get('X-Marmot-Signature'))) return res.sendStatus(401)
  const event = JSON.parse(req.body)
  console.log(event.type, event.data)
  res.sendStatus(204)
})
app.listen(8080)
```

Python (Flask):

```python
import hashlib, hmac, os, time
from flask import Flask, abort, request

SECRET = os.environ["MARMOT_WEBHOOK_SECRET"].encode()  # whsec_…
TOLERANCE_SECONDS = 5 * 60

def verify(raw_body: bytes, header: str | None) -> bool:
    if not header:
        return False
    pairs = [part.strip().split("=", 1) for part in header.split(",")]
    timestamps = [value for key, value in pairs if key == "t"]
    signatures = [value for key, value in pairs if key == "v1"]
    if not timestamps or not timestamps[0].isdigit():
        return False
    t = int(timestamps[0])
    if abs(time.time() - t) > TOLERANCE_SECONDS:
        return False
    expected = hmac.new(SECRET, f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, value) for value in signatures)

app = Flask(__name__)

@app.post("/hooks/marmot")
def marmot_webhook():
    if not verify(request.get_data(), request.headers.get("X-Marmot-Signature")):
        abort(401)
    event = request.get_json()
    print(event["type"], event["data"])
    return "", 204
```

### Delivery, retries and the delivery log

Events are queued after the change is committed (`src/server/webhooks/events.ts`); the worker sends them
from the notifications queue (`webhook-delivery` jobs, `src/server/webhooks/deliver.ts`):

- **Timeout** 10 seconds; redirects are not followed (a `3xx` counts as a failure).
- **Success** is any `2xx` answer.
- **Retries**: network errors, timeouts, `5xx`, `408` and `429` are retried with exponential backoff
  (40 s, 80 s, 160 s, … twelve attempts over about 23 hours, ±20 % jitter). Other answers fail at once.
- **Outbound guard**: requests go through the same address guard as monitors and notification channels.
  With `MONITOR_DENY_PRIVATE_ADDRESSES=true` (or `MONITOR_DENY_CIDRS`), URLs that resolve to a private
  address are refused when saved (literal addresses) and at delivery (every resolved address); such
  deliveries are not retried.
- **Automatic disable**: after `WEBHOOK_DISABLE_AFTER_FAILURES` (default 5) deliveries in a row failed for
  good, the endpoint is disabled (`webhook_endpoint.disabled` in the audit log, "Disabled after failures" in
  the list) and the organization's owners and admins get an email. Pending retries of a disabled endpoint are
  cancelled. Any successful delivery resets the streak; re-enabling the endpoint does too.

**Delivery log.** Every delivery is logged per endpoint (**Delivery log** in the endpoint's menu,
`/{orgSlug}/settings/webhooks/:id`): event type, result (`pending`, `retrying`, `succeeded`, `failed`,
`cancelled`), attempts, response status, duration, and on expanding a row the request headers (signature
values redacted) and body and the response headers (cookies and tokens redacted) and the first 2 KB of the
response body. Admins can **redeliver** any logged event and **send a test event**; both are sent at once,
a single attempt, also to a disabled endpoint (to check a fix before re-enabling it), and do not count
towards the automatic disable. The log is pruned after `WEBHOOK_DELIVERY_RETENTION_DAYS` (default 14 days).

**API** (session, `webhook:read` to read, `webhook:manage` for everything else):

| Endpoint                                                              | Purpose                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/orgs/:orgId/webhooks`                                       | endpoints (never the secret) and the event catalogue (`eventGroups`)         |
| `POST /api/orgs/:orgId/webhooks` `{ url, events, description? }`      | create; the response carries `secret` once                                   |
| `GET/PATCH/DELETE /api/orgs/:orgId/webhooks/:id`                      | read, change (`url`, `events`, `description`, `active`), delete with its log |
| `POST /api/orgs/:orgId/webhooks/:id/rotate-secret`                    | new secret, returned once                                                    |
| `POST /api/orgs/:orgId/webhooks/:id/test`                             | send `webhook.test` now; returns the logged delivery                         |
| `GET /api/orgs/:orgId/webhooks/:id/deliveries?page=&state=`           | delivery log, newest first, 25 per page                                      |
| `POST /api/orgs/:orgId/webhooks/:id/deliveries/:deliveryId/redeliver` | send the logged event again now; returns the new delivery                    |

The `webhook` notification channel type stays what it was: a per-monitor alert channel with Uptime Kuma's
payload. Use outbound webhooks for integrations that need every event, signatures and a delivery history.
