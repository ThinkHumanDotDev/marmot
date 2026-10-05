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
| `DISABLE_SIGNUP`                                                                                           | `false`                  | Only invited users can register.                        |
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
