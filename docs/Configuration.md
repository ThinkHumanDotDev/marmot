# Configuration

Marmot is configured through environment variables. Every variable is declared and validated in
`src/env.ts` (zod) when a process starts, so a typo or a missing required value fails fast with a readable
message instead of a half-working install. `.env.example` at the repository root lists all of them for local
development; `docker/.env.example` is the shorter compose variant.

Three processes read the environment: **web** (Next.js + Payload: UI, API, status pages), **worker**
(checks, heartbeats, notifications, retention) and **realtime** (socket.io). With `MARMOT_ROLE=all` one
container runs all three. The _Read by_ column below tells you which process must see a change; in a
compose stack the `.env` file is passed to all three, so you can simply restart the stack.

Boolean variables accept `1`, `true`, `yes`, `on` (case-insensitive) as true and anything else as false.

## Core

| Variable                 | Default                 | Read by | Description                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYLOAD_SECRET`         | — (required)            | all     | Signs session tokens and encrypts secrets at rest. At least 16 characters; use `openssl rand -hex 32`. Changing it signs everyone out.                                                                                                       |
| `NEXT_PUBLIC_SERVER_URL` | `http://localhost:3000` | all     | The URL users open Marmot at. Used for CORS/CSRF, invitation and password-reset emails, the OIDC redirect URI, status-page links, custom-domain detection and the realtime CORS origin. Must match the public `https://` URL behind a proxy. |
| `ADDITIONAL_ORIGINS`     | _(empty)_               | web     | Extra CORS/CSRF origins, comma-separated (e.g. a second hostname behind the same proxy).                                                                                                                                                     |
| `MARMOT_ROLE`            | `all`                   | all     | Which process this container runs: `web`, `worker`, `realtime` or `all`. The compose file sets it per service.                                                                                                                               |
| `NODE_ENV`               | `development`           | all     | `development`, `test` or `production`. The Docker image sets `production`, which enables HSTS, refuses plain-`http://` OIDC issuers and makes the database adapters require migrations instead of pushing the schema.                        |
| `LOG_LEVEL`              | `info`                  | all     | pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. Logs are JSON lines on stdout.                                                                                                                                               |

## Database

| Variable           | Default      | Read by | Description                                                                                                                                                                                            |
| ------------------ | ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_ADAPTER` | `postgres`   | all     | `postgres`, `mongodb` or `sqlite`. SQLite is for local development only (no migrations, pushes its schema).                                                                                            |
| `DATABASE_URL`     | — (required) | all     | Connection string for the adapter: `postgres://user:pass@host:5432/marmot`, `mongodb://host:27017/marmot`, `file:./data/marmot.db`. Inside compose the host is the service name (`postgres`, `mongo`). |

Postgres migrations live in `src/migrations/postgres` and run when the `web` role starts (or with the image's
`migrate` command). MongoDB needs no schema migrations; indexes are created on boot.

## Redis

| Variable    | Default                  | Read by | Description                                                                                                                                                                                              |
| ----------- | ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | `redis://localhost:6379` | all     | BullMQ queues and job schedulers (worker, and the web process when monitors change) plus socket.io pub/sub (realtime, and the emitters in web and worker). Run Redis with `maxmemory-policy noeviction`. |

Redis holds only queue state and live socket rooms. It does not need a backup: the worker re-creates every
job scheduler from the database on start.

## Realtime

| Variable                   | Default   | Read by          | Description                                                                                                                                                                                                                                                                        |
| -------------------------- | --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REALTIME_PORT`            | `3001`    | realtime         | Port the socket.io server listens on. `GET /healthz` on the same port is the health probe.                                                                                                                                                                                         |
| `NEXT_PUBLIC_REALTIME_URL` | _(empty)_ | web (build time) | Origin of the socket server when it is **not** reachable at `/socket.io` on the web origin. Leave empty with the bundled Caddy or any proxy that routes `/socket.io/*` to the realtime process. Inlined into the browser bundle at `pnpm build`; the published image has it empty. |

See [Realtime origin](#realtime-origin) below.

## Storage

Uploads (organization logos, status-page logos) go to local disk unless `S3_BUCKET` is set, in which case
`@payloadcms/storage-s3` is registered and the other `S3_*` variables configure the client.

| Variable               | Default   | Read by | Description                                                                                          |
| ---------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `UPLOADS_DIR`          | `uploads` | web     | Local upload directory, relative to the working directory. The image uses `/app/uploads` (a volume). |
| `S3_BUCKET`            | —         | web     | Bucket name. Setting it switches storage to S3.                                                      |
| `S3_REGION`            | —         | web     | Region (`auto` for Cloudflare R2 and most S3-compatible stores).                                     |
| `S3_ENDPOINT`          | —         | web     | Custom endpoint for S3-compatible services (R2, MinIO, …). Leave unset for AWS.                      |
| `S3_ACCESS_KEY_ID`     | —         | web     | Access key.                                                                                          |
| `S3_SECRET_ACCESS_KEY` | —         | web     | Secret key.                                                                                          |
| `S3_FORCE_PATH_STYLE`  | `false`   | web     | Use path-style URLs (`https://endpoint/bucket/key`), needed by MinIO and some proxies.               |

## Email

Marmot sends invitations and password-reset mail through the Payload email adapter. Without `SMTP_HOST` the
messages are written to the web process log instead of being sent, which is enough to copy an invitation
link during evaluation. The `smtp` notification provider can reuse these settings (**Use the server SMTP
settings**); the last two variables decide who may do that and how much mail it may send.

| Variable                         | Default                     | Read by     | Description                                                                                                                                                                                                          |
| -------------------------------- | --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`                      | —                           | web, worker | SMTP server. Unset = log mail to the console.                                                                                                                                                                        |
| `SMTP_PORT`                      | `587`                       | web, worker | SMTP port.                                                                                                                                                                                                           |
| `SMTP_USER`                      | —                           | web, worker | Username (optional for unauthenticated relays).                                                                                                                                                                      |
| `SMTP_PASSWORD`                  | —                           | web, worker | Password.                                                                                                                                                                                                            |
| `SMTP_SECURE`                    | `false`                     | web, worker | `true` for implicit TLS (usually port 465); `false` uses STARTTLS when offered.                                                                                                                                      |
| `EMAIL_FROM`                     | `Marmot <marmot@localhost>` | web, worker | Sender address, `Name <address>` form allowed.                                                                                                                                                                       |
| `NOTIFICATIONS_SERVER_SMTP`      | `superadmin`                | web, worker | Who may set up an `smtp` notification channel that sends through the settings above: `all` (anyone who manages channels), `superadmin` (instance superadmins only) or `off` (nobody; such channels fail to deliver). |
| `NOTIFICATIONS_SERVER_SMTP_RATE` | `60`                        | web, worker | Messages per organization per hour sent through the server SMTP settings, test messages included. `0` = unlimited.                                                                                                   |

Notification mail sent through the server settings is limited to 10 recipients per message (to, cc and bcc
combined). In `superadmin` mode, channels set up before the upgrade keep sending; see
[Deployment](Deployment.md#upgrading) for how to list them. Details: [Notifications](Notifications.md#email-through-the-server-smtp-settings).

## Authentication

| Variable               | Default                | Read by | Description                                                                                                                                                                          |
| ---------------------- | ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISABLE_SIGNUP`       | `false`                | web     | Default for the `allowSignup` instance setting. When sign-up is off, accounts are created only through the setup wizard, invitations, or SSO logins that match a pending invitation. |
| `OIDC_ISSUER_URL`      | —                      | web     | Issuer of your OpenID Connect provider (its `iss` value). Discovery is read from `<issuer>/.well-known/openid-configuration`.                                                        |
| `OIDC_CLIENT_ID`       | —                      | web     | Client id registered at the provider.                                                                                                                                                |
| `OIDC_CLIENT_SECRET`   | —                      | web     | Client secret. All three `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` must be set to enable the SSO button.                                                          |
| `OIDC_DISPLAY_NAME`    | `Single sign-on`       | web     | Label of the login button ("Continue with …").                                                                                                                                       |
| `OIDC_AUTO_PROVISION`  | `true`                 | web     | Create a Marmot account on first SSO login. `false` only lets existing users (matched by subject or verified email) in.                                                              |
| `OIDC_SCOPES`          | `openid email profile` | web     | Scopes requested from the provider.                                                                                                                                                  |
| `GITHUB_CLIENT_ID`     | —                      | web     | GitHub OAuth app client id. With `GITHUB_CLIENT_SECRET`, enables "Continue with GitHub"; callback URL `<NEXT_PUBLIC_SERVER_URL>/api/auth/sso/github/callback`.                       |
| `GITHUB_CLIENT_SECRET` | —                      | web     | GitHub OAuth app client secret.                                                                                                                                                      |
| `GOOGLE_CLIENT_ID`     | —                      | web     | Google OAuth client id. With `GOOGLE_CLIENT_SECRET`, enables "Continue with Google"; redirect URI `<NEXT_PUBLIC_SERVER_URL>/api/auth/sso/google/callback`.                           |
| `GOOGLE_CLIENT_SECRET` | —                      | web     | Google OAuth client secret.                                                                                                                                                          |

Full setup guide with provider walkthroughs: [Single sign-on](Single-Sign-On.md).

## Monitoring

| Variable                         | Default | Read by     | Description                                                                                                                                                                                                                         |
| -------------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEEP_DATA_PERIOD_DAYS`          | `365`   | web, worker | Default for the `keepDataPeriodDays` instance setting: how long daily aggregates and important heartbeats are kept. Raw heartbeats live 24 h, minutely buckets 24 h, hourly 30 d.                                                   |
| `WORKER_CONCURRENCY`             | `10`    | worker      | Parallel checks (and notification deliveries) per worker process. Scale out with more worker replicas rather than very high values.                                                                                                 |
| `DOCKER_SOCKET_ENABLED`          | `true`  | web, worker | Allow `socket` Docker hosts, which talk to the Docker daemon of the worker's own host. Set `false` on shared installs where users must not reach the local daemon.                                                                  |
| `MARMOT_DISABLE_ENGINE_HOOKS`    | `false` | web         | Skip the BullMQ scheduler sync in the `monitors` collection hooks. Only for tests that run without Redis; the Vitest setup sets it.                                                                                                 |
| `MONITOR_DENY_PRIVATE_ADDRESSES` | `false` | web, worker | Refuse monitor checks and notification deliveries to private, loopback, link-local, CGNAT, multicast and container-network addresses (see below). Turn on when people you do not trust can create monitors, e.g. with open sign-up. |
| `MONITOR_DENY_CIDRS`             | —       | web, worker | Comma-separated CIDRs that are always refused, guard on or off (e.g. `203.0.113.0/24, 2001:db8::/32`). Wins over `MONITOR_ALLOW_CIDRS`.                                                                                             |
| `MONITOR_ALLOW_CIDRS`            | —       | web, worker | Comma-separated CIDRs exempt from the private-address deny list, for internal subnets you do want to monitor (e.g. `10.20.0.0/16`).                                                                                                 |

### Private-address guard

With `MONITOR_DENY_PRIVATE_ADDRESSES=true` the worker checks every address a monitor or notification
channel would connect to, after DNS resolution and at connect time (every redirect hop included), and
connects only to the address it checked. A refused check is a DOWN heartbeat such as
`Blocked: db.internal resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)`.

- **Denied ranges:** `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`,
  `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4` and above, `::`, `::1`,
  `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `64:ff9b:1::/48`, plus IPv6 forms that embed one of the
  IPv4 ranges (`::ffff:127.0.0.1`, `::127.0.0.1`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`).
- **Precedence:** `MONITOR_DENY_CIDRS` › `MONITOR_ALLOW_CIDRS` › the ranges above.
- **Refused types:** `tailscale-ping`, `real-browser` and Docker hosts of type `socket` cannot be saved or
  run, and Apprise channels cannot send: they reach the network without passing the guard.
- **Saving** a monitor, proxy or Docker host whose target is a denied literal (`127.0.0.1`, `2130706433`,
  `[::1]`, `localhost`) is refused right away; names are judged when the check runs.
- Instance-wide settings (`SMTP_HOST`, `DATABASE_URL`, `REDIS_URL`) are not affected.

Malformed CIDRs stop the process at startup with a readable error.

## Hosted instance

Switches for running Marmot as a hosted service. Self-hosted installs leave them off.

| Variable               | Default | Read by | Description                                                                                                                                                       |
| ---------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LANDING_PAGE_ENABLED` | `false` | web     | Show a marketing landing page at `/` to signed-out visitors instead of redirecting to `/login`. Signed-in users and fresh installs (setup wizard) are unaffected. |

## Billing

A scaffold for hosted offerings. Self-hosted installs leave it off; every limit is then unlimited and no
Stripe code is loaded. Details in [Billing](Billing.md) _(landing in the current release)_.

| Variable                 | Default | Read by | Description                                                        |
| ------------------------ | ------- | ------- | ------------------------------------------------------------------ |
| `BILLING_ENABLED`        | `false` | web     | Enforce plan limits and show the Billing settings tab.             |
| `STRIPE_SECRET_KEY`      | —       | web     | Registers the Stripe plugin and enables Checkout / Billing Portal. |
| `STRIPE_WEBHOOK_SECRET`  | —       | web     | Signing secret of the Stripe webhook endpoint.                     |
| `STRIPE_PUBLISHABLE_KEY` | —       | web     | Reserved for a future Stripe Elements checkout; not needed today.  |

## Telemetry

Marmot sends nothing by default: no analytics SDK is loaded, no cookie banner appears and nothing calls
home. Setting a PostHog key enables opt-in product analytics behind a consent banner; what is collected is
documented in [Telemetry](Telemetry.md) _(landing in the current release)_.

| Variable                   | Default                    | Read by                  | Description                                                                                                 |
| -------------------------- | -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_POSTHOG_KEY`  | —                          | web (build time), worker | PostHog project key. Unset = telemetry off.                                                                 |
| `NEXT_PUBLIC_POSTHOG_HOST` | `https://us.i.posthog.com` | web (build time), worker | PostHog ingestion host (`https://eu.i.posthog.com` for the EU cloud). Also the target of the `/ph` rewrite. |

## Container and compose variables

These are read by `docker/entrypoint.sh`, `docker/docker-compose.yml` or the Caddyfile rather than by
`src/env.ts`, so they only matter for Docker deployments.

| Variable                | Default  | Used by          | Description                                                                                               |
| ----------------------- | -------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                | —        | compose → Caddy  | Hostname for automatic HTTPS. Unset = Caddy serves plain HTTP on port 80 (for use behind your own proxy). |
| `ACME_EMAIL`            | —        | compose → Caddy  | Contact address passed to the certificate authority.                                                      |
| `SITE_ADDRESS`          | `:80`    | Caddyfile        | Derived from `DOMAIN` by compose; set it directly when running Caddy by hand.                             |
| `POSTGRES_PASSWORD`     | `marmot` | compose          | Password of the bundled Postgres; the default `DATABASE_URL` picks it up.                                 |
| `MARMOT_VERSION`        | release  | compose          | Image tag of `ghcr.io/thinkhumandotdev/marmot` to run; a release's compose file defaults to that release. |
| `PORT`                  | `3000`   | entrypoint (web) | Port of the Next.js server inside the container.                                                          |
| `SKIP_MIGRATIONS`       | `false`  | entrypoint (web) | `true` skips `migrate` on start, for when you run migrations yourself (init container, CI/CD step).       |
| `WORKER_SCHEMA_WAIT_MS` | `120000` | worker           | How long the worker waits for the database schema (migrations running in `web`) before giving up on boot. |

## Instance settings

Some options can be changed at runtime by a superadmin without redeploying: in the Marmot UI under
**Settings → Instance** (`/{orgSlug}/settings/instance`, visible to superadmins only, saved through
`POST /api/globals/instance-settings`) or in the Payload admin panel (**System → Instance settings**, the
`instance-settings` global). Environment variables provide the defaults; once a value has been saved in the
global it takes precedence over the variable. The Instance tab also shows whether SMTP is configured and
offers **Send test email** (`POST /api/instance/smtp-test { to? }`, superadmin-only; answers `400` while
`SMTP_HOST` is unset).

| Setting                             | Default                  | Description                                                                      |
| ----------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `primaryBaseUrl`                    | `NEXT_PUBLIC_SERVER_URL` | Public URL used in notifications and status page links.                          |
| `allowSignup`                       | `!DISABLE_SIGNUP`        | Whether anyone may create an account (`POST /api/users`, `/signup`).             |
| `entryPage`                         | `dashboard`              | `dashboard` or `status-page`: what the root URL shows.                           |
| `tlsExpiryNotifyDays`               | `7, 14, 21`              | Days before a TLS certificate expires at which to notify.                        |
| `domainExpiryNotifyDays`            | `7, 14, 21`              | Days before a domain registration expires at which to notify.                    |
| `keepDataPeriodDays`                | `KEEP_DATA_PERIOD_DAYS`  | Retention of daily aggregates and important heartbeats (`0` disables).           |
| `trustProxy`                        | `false`                  | Trust `X-Forwarded-*` headers from the reverse proxy for client IPs.             |
| `steamApiKey`, `globalpingApiToken` | —                        | Third-party API keys for the corresponding monitor types (superadmin-only read). |

Server code reads the resolved values through `getInstanceSettings(payload)` (`src/server/settings.ts`),
which caches them for 60 seconds per process; saving the global clears the cache of the web process
immediately, the worker and realtime processes pick changes up within a minute.

## First-run setup

A fresh install has no users. While that is the case `GET /api/setup/status` returns `{ "needsSetup": true }`,
`/` and the auth pages redirect to `/setup`, and the wizard creates the first superadmin plus their
organization in one transaction (`POST /api/setup`) and signs them in. Once any user exists the wizard is
closed for good (`/setup` redirects to `/login`, the API answers `409`); further users join through
`/signup` (if `allowSignup`) or invitations.

## Realtime origin

The browser opens one socket.io connection with credentials, so the realtime server must be reachable on a
URL that receives the `payload-token` cookie. By default the client connects to the page's own origin at
`/socket.io`, and Caddy (or your reverse proxy, see [Deployment](Deployment.md)) forwards that path to the
realtime process on `REALTIME_PORT`. Set `NEXT_PUBLIC_REALTIME_URL` (e.g. `https://realtime.example.com`)
only when the realtime server is exposed on another origin; it must share the cookie's site (a subdomain of
the web app is fine) and allows `NEXT_PUBLIC_SERVER_URL` in CORS. Being a `NEXT_PUBLIC_*` variable it is
inlined at `pnpm build` time, so it requires building your own image; the published image expects the
same-origin layout.
