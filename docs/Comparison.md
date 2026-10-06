# Comparison with Uptime Kuma

Marmot sets out to offer Uptime Kuma's monitoring feature set for teams. This page tracks parity feature by
feature, so you know what to expect when switching, and lists what Marmot adds on top. Status values:

- **done** — on `main`, documented;
- **landing** — merging in the current release (the pull request is open and referenced in the docs);
- **planned** — on the roadmap with an issue, not started or not yet merged;
- **not planned** — deliberately left out, with the reason.

Marmot is not a fork: it is a new codebase on Payload CMS and Next.js that ports individual pieces of
Uptime Kuma (MIT) where that saves time, with attribution in `THIRD_PARTY_NOTICES.md`. Uptime Kuma's own
documentation remains the reference for the behaviour of the ported checks.

## Monitoring

| Feature                                                                                        | Uptime Kuma | Marmot                                                                       |
| ---------------------------------------------------------------------------------------------- | :---------: | ---------------------------------------------------------------------------- |
| HTTP(s), keyword, JSON query monitors                                                          |      ✓      | **done** ([Monitors](Monitors.md))                                           |
| TCP port, ping, DNS monitors                                                                   |      ✓      | **done**                                                                     |
| Push monitors                                                                                  |      ✓      | **done** (type), push endpoint **landing** ([Integrations](Integrations.md)) |
| Group monitors                                                                                 |      ✓      | **done**                                                                     |
| Manual monitors                                                                                |      ✓      | **done**                                                                     |
| gRPC, WebSocket, MQTT, Kafka producer, RabbitMQ, SMTP, SNMP, NTP, SFTP, RADIUS, Tailscale ping |      ✓      | **done** ([Monitor types](Monitor-Types.md))                                 |
| MySQL, PostgreSQL, SQL Server, MongoDB, Redis monitors                                         |      ✓      | **done**                                                                     |
| Steam, GameDig monitors                                                                        |      ✓      | **done**                                                                     |
| Real-browser (Chromium) monitor                                                                |      ✓      | **done**, via a remote Playwright browser server                             |
| Docker container monitor, proxies                                                              |      ✓      | **planned** (#21)                                                            |
| Oracle DB monitor                                                                              |      ✓      | not planned (driver too heavy for the default image)                         |
| SIP options, system service, pm2, Globalping monitors                                          |      ✓      | not planned for now                                                          |
| Intervals, retries, retry interval, resend interval, timeout                                   |      ✓      | **done**                                                                     |
| Upside-down mode                                                                               |      ✓      | **done**                                                                     |
| Accepted status codes, redirects, custom headers and body                                      |      ✓      | **done**                                                                     |
| HTTP auth: basic, bearer, OAuth2 client credentials, NTLM, mTLS                                |      ✓      | **done**                                                                     |
| Ignore TLS errors                                                                              |      ✓      | **done**                                                                     |
| TLS certificate expiry alerts and certificate info                                             |      ✓      | **landing** (#24)                                                            |
| Domain (registration) expiry alerts                                                            |      ✓      | **landing** (#24, via RDAP)                                                  |
| Monitor conditions builder (SQL/MQTT)                                                          |      ✓      | not planned for now                                                          |
| Tags with colours and values                                                                   |      ✓      | **planned** (#21)                                                            |
| Pause / resume, clone, delete                                                                  |      ✓      | **done**                                                                     |
| Uptime 24h / 30d / 1y, average response time, response-time chart                              |      ✓      | **done**                                                                     |
| Important events list                                                                          |      ✓      | **done**                                                                     |
| Data retention setting                                                                         |      ✓      | **done** (`KEEP_DATA_PERIOD_DAYS`, instance setting)                         |
| Live dashboard over WebSockets                                                                 |      ✓      | **done** (socket.io, Redis adapter)                                          |

## Alerting

| Feature                                                                                                                                                                         | Uptime Kuma | Marmot                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------: | ------------------------------------------------------------------------------------------- |
| Notification channels attached per monitor                                                                                                                                      |      ✓      | **done** ([Notifications](Notifications.md))                                                |
| Default channels, apply to all existing monitors                                                                                                                                |      ✓      | **done**                                                                                    |
| Test notification                                                                                                                                                               |      ✓      | **done**                                                                                    |
| Chat: Discord, Slack, Telegram, Teams, Matrix, Mattermost, Rocket.Chat, Google Chat, Signal, LINE, Pumble, Zoho Cliq, Nextcloud Talk, OneBot, WeCom, DingDing, Feishu, Bitrix24 |      ✓      | **done** (48 providers on `main`)                                                           |
| Push: ntfy, Gotify, Pushover, Bark, PushDeer, ServerChan, Pushbullet, Web Push, Techulus, Pushy, Home Assistant                                                                 |      ✓      | **done**                                                                                    |
| Email: SMTP, SendGrid, Resend                                                                                                                                                   |      ✓      | **done**                                                                                    |
| Incident management: PagerDuty, Opsgenie, Splunk On-Call, Squadcast, Alerta, Grafana OnCall, Heii On-Call                                                                       |      ✓      | **done**                                                                                    |
| SMS: Twilio, ClickSend                                                                                                                                                          |      ✓      | **done**                                                                                    |
| Webhook, Apprise                                                                                                                                                                |      ✓      | **done**                                                                                    |
| Remaining Uptime Kuma providers (≈ 40 more SMS gateways and regional services)                                                                                                  |      ✓      | **planned**, by demand; adding one is a single file ([CONTRIBUTING.md](../CONTRIBUTING.md)) |
| Nostr                                                                                                                                                                           |      ✓      | not planned (dependency weight)                                                             |
| Message templates with `{{ variables }}`                                                                                                                                        |      ✓      | **done**                                                                                    |
| Retry on delivery failure                                                                                                                                                       |      —      | **done** (BullMQ, 3 attempts with backoff)                                                  |

## Status pages

| Feature                                            | Uptime Kuma | Marmot                                                              |
| -------------------------------------------------- | :---------: | ------------------------------------------------------------------- |
| Multiple public status pages                       |      ✓      | **done**, per organization ([Status pages](Status-Pages.md))        |
| Groups of monitors, drag and drop                  |      ✓      | **done**                                                            |
| Incidents (styles, pinned, resolve)                |      ✓      | **done**                                                            |
| Custom CSS, footer text, logo, theme               |      ✓      | **done**                                                            |
| Custom domains                                     |      ✓      | **done** (with Caddy on-demand TLS)                                 |
| Search-engine indexing toggle, Google Analytics id |      ✓      | **done**                                                            |
| Auto refresh                                       |      ✓      | **done**                                                            |
| RSS feed, web manifest                             |      ✓      | **done**                                                            |
| Show tags / certificate expiry on the page         |      ✓      | toggles **done**; data **landing** with tags (#21) and expiry (#24) |
| Maintenance banners on status pages                |      ✓      | **done** ([Maintenance](Maintenance.md))                            |
| Status badges (shields.io style)                   |      ✓      | **landing** (#20, [Integrations](Integrations.md))                  |

## Maintenance

| Feature                                                                   | Uptime Kuma | Marmot            |
| ------------------------------------------------------------------------- | :---------: | ----------------- |
| Manual, single, recurring (interval, weekday, day of month), cron windows |      ✓      | **done**          |
| Timezone-aware schedules                                                  |      ✓      | **done**          |
| Attach monitors and status pages (banners)                                |      ✓      | **done**          |
| Maintenance status counted as up                                          |      ✓      | **done** (engine) |

## Integrations and API

| Feature                          | Uptime Kuma | Marmot                                                       |
| -------------------------------- | :---------: | ------------------------------------------------------------ |
| Prometheus `/metrics`            |      ✓      | **landing** (#20)                                            |
| API keys                         |      ✓      | **landing** (#20), per organization                          |
| Push endpoint `/api/push/:token` |      ✓      | **landing** (#20)                                            |
| REST API for everything          |   partial   | **done** (Payload REST + GraphQL, org-scoped route handlers) |
| Backup / restore JSON export     | deprecated  | **planned** (#28, import from Uptime Kuma included)          |
| Settings: 2FA                    |      ✓      | **planned** (#25)                                            |

## Platform and operations

| Feature                    | Uptime Kuma         | Marmot                                                                   |
| -------------------------- | ------------------- | ------------------------------------------------------------------------ |
| Database                   | SQLite, MariaDB     | Postgres **or** MongoDB (SQLite for development)                         |
| Processes                  | single Node process | web / worker / realtime, scalable independently; `all` for one box       |
| Deployment                 | Docker image        | Docker image + compose with Caddy auto-TLS ([Deployment](Deployment.md)) |
| Health endpoints           | —                   | `/api/health`, `/healthz`                                                |
| Reverse-proxy friendliness | ✓                   | ✓, same-origin `/socket.io` routing                                      |
| Telemetry                  | none                | none by default; opt-in PostHog with consent **landing** (#27)           |
| License                    | MIT                 | AGPL-3.0                                                                 |

## What Marmot adds (kan.bn-inspired)

Uptime Kuma is single-user with optional read-only status pages. Marmot borrows the workspace model of
[kan.bn](https://github.com/kanbn/kan):

| Feature                                                           | Status                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Organizations with their own monitors, channels and pages         | **done** ([Organizations and members](Organizations-and-Members.md)) |
| Roles: owner, admin, member, viewer with per-resource permissions | **done**                                                             |
| Email invitations with roles, resend, revoke                      | **done**                                                             |
| Shareable invite link per organization                            | **done**                                                             |
| Ownership transfer, last-owner protection                         | **done**                                                             |
| Organization settings (name, slug, logo, timezone)                | **done**                                                             |
| Account settings, password change, account deletion               | **done**                                                             |
| Generic OIDC single sign-on with auto-provisioning                | **done** ([Single sign-on](Single-Sign-On.md))                       |
| Per-organization SAML/OIDC connections with verified domains      | **done** ([Single sign-on](Single-Sign-On.md))                       |
| First-run setup wizard, superadmin role, instance settings        | **done**                                                             |
| Instance-wide sign-up switch                                      | **done**                                                             |
| Billing / plan entitlements for hosted offerings                  | **landing** (#26, off on self-host; [Billing](Billing.md))           |
| Audit log                                                         | planned                                                              |

## Migrating from Uptime Kuma

An importer for Uptime Kuma's JSON backup is planned (#28). Until then, monitors are recreated by hand or
through the REST API; the field names follow Uptime Kuma's (`interval`, `retryInterval`, `maxretries` →
`maxRetries`, `accepted_statuscodes` → `acceptedStatusCodes`), so a short script over the backup file gets
you most of the way. Badge and push URLs keep the same paths once the integrations land, so README badges
and cron jobs only need the hostname changed.
