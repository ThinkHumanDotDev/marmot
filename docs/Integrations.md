# Integrations: badges, push monitors, Prometheus, API keys

Marmot's machine-facing endpoints live under `src/app/api/` and mirror Uptime Kuma's, so existing
README badges, cron jobs and Grafana dashboards keep working after a switch.

| Endpoint                                     | Auth                                               | Purpose                      |
| -------------------------------------------- | -------------------------------------------------- | ---------------------------- |
| `GET /api/badge/:monitorId/<type>[/<range>]` | public status page **or** API key of the org       | shields.io-style SVG badges  |
| `ALL /api/push/:token?status=&msg=&ping=`    | the monitor's push token                           | heartbeat for push monitors  |
| `GET /api/metrics`                           | API key                                            | Prometheus exposition        |
| `/api/orgs/:orgId/**`                        | session **or** API key of the org (scoped)         | management API               |
| `GET /api/openapi.json`, `GET /api/docs`     | public                                             | management API reference     |
| `GET/POST /api/orgs/:orgId/api-keys`         | session, `api-key:read` / `api-key:create` (admin) | manage keys                  |
| `PATCH/DELETE /api/orgs/:orgId/api-keys/:id` | session, `api-key:delete` (admin)                  | disable / re-enable / revoke |

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
- keys never reach member, invitation, invite-link, API key, SSO, billing, permission or ownership routes
  (`403`), whatever the organization's permission overrides say;
- each key may send `API_KEY_RATE_LIMIT` requests per minute (default 600), of which
  `API_KEY_WRITE_RATE_LIMIT` (default 60) may be writes; above that the API answers `429` with
  `Retry-After` ([Configuration](Configuration.md#authentication));
- every write is recorded in the audit log as `api_key.write_request` with `actorType: apiKey` and the
  key's prefix; creating, disabling and revoking keys are recorded as `api_key.created`,
  `api_key.updated` and `api_key.revoked`.

The API is described by an OpenAPI 3.1 document at `/api/openapi.json` (request bodies are generated from
the same zod schemas the handlers validate with) and browsable at `/api/docs`. Each operation carries
`x-marmot-api-key-scope` (`read`, `write`, or `null` for session-only routes) and
`x-marmot-permission`.

```sh
curl -H "Authorization: Bearer $MARMOT_KEY" https://marmot.example.com/api/orgs/1/monitors
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

| Query    | Values                | Default |
| -------- | --------------------- | ------- |
| `status` | `up`, `down`          | `up`    |
| `msg`    | free text (250 chars) | `OK`    |
| `ping`   | milliseconds, 0…10^11 | none    |

The response is `{ "ok": true }`; unknown or paused tokens return `404 { ok: false, msg }`, an invalid
ping `400`. The call records a heartbeat through the engine (`recordExternalBeat` in
`src/server/engine/worker.ts`): maintenance windows, retries (`maxRetries` → PENDING) and `upsideDown`
apply exactly as for polled checks, the monitor's `status.lastPushAt` is stamped, and the stats, realtime
and notification listeners fire, so dashboards update live and channels are notified on transitions. The
periodic push check in the worker only turns the monitor DOWN when no push arrived within
`interval + 10 %`.

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

| Metric                        | Labels            | Value                                                        |
| ----------------------------- | ----------------- | ------------------------------------------------------------ |
| `monitor_status`              | common            | `1` up, `0` down, `2` pending, `3` maintenance, `4` degraded |
| `monitor_response_time`       | common            | last ping in ms (`-1` when the beat had no ping)             |
| `monitor_uptime_ratio`        | common + `window` | `0.0…1.0` over `24h` and `30d`                               |
| `monitor_cert_days_remaining` | common            | from `monitors.certInfo` (only when present)                 |
| `monitor_cert_is_valid`       | common            | `1` / `0`, from `monitors.certInfo`                          |

Common labels: `monitor_id`, `monitor_name`, `monitor_type`, `monitor_url`, `monitor_hostname`,
`monitor_port` (empty string when a monitor has no such field). Names and labels match Uptime Kuma's
`server/prometheus.js`; `4` (degraded: a successful check slower than the monitor's `degradedAfter`) is a
Marmot addition, so alert rules written for Kuma that test `monitor_status == 1` should use
`monitor_status == 1 or monitor_status == 4` to keep treating slow checks as up. Monitors without a heartbeat
yet have no `monitor_status` sample. Without a valid
key the endpoint answers `401` with a `WWW-Authenticate` header.
