# Configuration

All configuration is via environment variables (see `.env.example`). Variables are validated at startup by
`src/env.ts`.

| Variable                                                                                                   | Default                  | Description                                             |
| ---------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| `PAYLOAD_SECRET`                                                                                           | —                        | Required. ≥16 random chars; signs auth tokens.          |
| `NEXT_PUBLIC_SERVER_URL`                                                                                   | `http://localhost:3000`  | Public base URL.                                        |
| `MARMOT_ROLE`                                                                                              | `all`                    | `web`, `worker`, `realtime` or `all`.                   |
| `DATABASE_ADAPTER`                                                                                         | `postgres`               | `postgres`, `mongodb` or `sqlite` (dev only).           |
| `DATABASE_URL`                                                                                             | —                        | Connection string for the chosen adapter.               |
| `REDIS_URL`                                                                                                | `redis://localhost:6379` | BullMQ + socket.io. Use `maxmemory-policy noeviction`.  |
| `REALTIME_PORT`                                                                                            | `3001`                   | Port of the realtime process.                           |
| `NEXT_PUBLIC_REALTIME_URL`                                                                                 | _(empty)_                | Set only when the socket server is on another origin.   |
| `UPLOADS_DIR`                                                                                              | `uploads`                | Local upload directory (when S3 is not configured).     |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | —                        | S3-compatible storage; enabled when `S3_BUCKET` is set. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `EMAIL_FROM`                        | —                        | Generic SMTP. Without `SMTP_HOST` emails are logged.    |
| `DISABLE_SIGNUP`                                                                                           | `false`                  | Default for the `allowSignup` instance setting.         |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                                                  | —                        | Generic OIDC via discovery; all three enable SSO.       |
| `OIDC_DISPLAY_NAME`                                                                                        | `Single sign-on`         | Label of the SSO button.                                |
| `OIDC_AUTO_PROVISION`                                                                                      | `true`                   | Create users on first SSO login.                        |
| `OIDC_SCOPES`                                                                                              | `openid email profile`   | Scopes requested from the OIDC provider.                |
| `KEEP_DATA_PERIOD_DAYS`                                                                                    | `365`                    | Retention of daily aggregates and important heartbeats. |
| `WORKER_CONCURRENCY`                                                                                       | `10`                     | Parallel monitor checks per worker process.             |
| `MARMOT_DISABLE_ENGINE_HOOKS`                                                                              | `false`                  | Skip BullMQ sync in `monitors` hooks (tests w/o Redis). |
| `BILLING_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                            | off                      | Billing scaffold.                                       |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`                                                      | off                      | Opt-in analytics; nothing is sent without a key.        |
| `LOG_LEVEL`                                                                                                | `info`                   | pino log level.                                         |
| `DOMAIN`, `ACME_EMAIL`                                                                                     | —                        | Compose only: Caddy automatic HTTPS.                    |

## Instance settings

Some options can be changed at runtime by a superadmin in the Payload admin panel (**System → Instance
settings**, the `instance-settings` global) without redeploying. Environment variables provide the defaults;
once a value has been saved in the global it takes precedence over the variable.

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
`/socket.io`, and Caddy (or your reverse proxy, see `docs/deployment.md`) forwards that path to the realtime
process on `REALTIME_PORT`. Set `NEXT_PUBLIC_REALTIME_URL` (e.g. `https://realtime.example.com`) only when
the realtime server is exposed on another origin; it must share the cookie's site (a subdomain of the web
app is fine) and allows `NEXT_PUBLIC_SERVER_URL` in CORS. Being a `NEXT_PUBLIC_*` variable it is inlined at
`pnpm build` time, so rebuild the web image after changing it.
