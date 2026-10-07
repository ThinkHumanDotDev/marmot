# Security

What Marmot does to protect an instance, and what the operator has to provide. Report vulnerabilities as
described in [SECURITY.md](../.github/SECURITY.md).

## Built in

| Area                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin panel          | `/admin` (Payload) is reachable by **superadmins only** (`users.access.admin`). Everyone else uses the Marmot UI; the "Admin panel" menu entry is hidden for them.                                                                                                                                                                                                                          |
| Organizations        | Every collection is scoped to the user's organizations through role-based access (`src/access`). Server code that acts for a user passes `overrideAccess: false`.                                                                                                                                                                                                                           |
| CORS / CSRF          | Only `NEXT_PUBLIC_SERVER_URL` and the origins in `ADDITIONAL_ORIGINS` may use the auth cookie against the API. Other origins get no session.                                                                                                                                                                                                                                                |
| Rate limiting        | Redis-backed (`rate-limiter-flexible`): password login 10/min per client with a 5-minute block, password reset 5 per 15 min, SSO login, callback and lookup 20/min. Responses carry `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Fails open if Redis is down (one warning is logged).                                                                                    |
| Audit log            | Every change to an organization's resources plus sign-ins and account security events, with actor, IP, user agent and a redacted diff. See [Audit log](#audit-log).                                                                                                                                                                                                                         |
| Security headers     | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, `X-Frame-Options: DENY` everywhere except public status pages (`/status/*`, which may be embedded), and HSTS when the public URL is https.                                                                                                                       |
| Secrets in the model | Invitation tokens, invite-link tokens and SSO identifiers (`auth-accounts` rows) are write-protected; API responses only expose them to roles that need them.                                                                                                                                                                                                                               |
| Outbound guard       | With `MONITOR_DENY_PRIVATE_ADDRESSES=true`, monitor checks and notification deliveries are refused when the target resolves to a private, loopback, link-local, CGNAT or container-network address. The check runs after DNS resolution and at connect time (each redirect hop included); host-local types are refused. Details in [Configuration](Configuration.md#private-address-guard). |
| Response excerpts    | Heartbeat and notification messages quote at most about 200 characters of a monitored response (JSON query values, keyword misses, MQTT payloads, error bodies).                                                                                                                                                                                                                            |
| Dependencies         | CI runs `pnpm audit --prod --audit-level=high` (advisory) on every push; Dependabot keeps Payload, Next.js and the rest current.                                                                                                                                                                                                                                                            |

### Accepted dependency advisories

`pnpm.auditConfig.ignoreGhsas` in `package.json` lists advisories that have no patched release or cannot be
reached in Marmot. Each needs a reason here. Remove the entry once upstream ships a fix.

| Advisory                                                                 | Package (path)                                                              | Why it is accepted                                                                                                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` ≤3.0.3 (`next › sass › chokidar`, and `eslint-config-next` in dev) | No patched release. Stack exhaustion needs a deeply nested glob pattern; `chokidar` only expands patterns from the build configuration, never from request data.   |
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | `esbuild` ≤0.24.2 (`@payloadcms/db-postgres › drizzle-kit › @esbuild-kit`)  | Affects only esbuild's development server (`serve`), which `@esbuild-kit` never starts; it uses the transform API. Marmot's own `esbuild` is already patched.      |
| [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) | `sprintf-js` ≤1.1.3 (`mssql › tedious`)                                     | No patched release. Needs an attacker-controlled format string; `tedious` formats only its own fixed strings. Only loaded by the optional SQL Server monitor type. |

### Client addresses and `trustProxy`

Next.js route handlers do not see the TCP peer address, so Marmot learns the client IP only from
`X-Forwarded-For` / `X-Real-IP`, and only when the instance setting **Trust proxy headers** (`trustProxy`)
is on. Enable it when Marmot runs behind Caddy (the compose stack), nginx, Traefik or a cloud load balancer
that overwrites those headers. Leave it off when clients connect directly: anyone could otherwise pick their
own rate-limit bucket. Without a trusted address, login and password-reset limits fall back to the targeted
account (per e-mail) and the OIDC endpoints are not limited. Status pages with an
[IP allow-list](Status-Pages.md#ip-allow-list) admit nobody without a trusted address.

## Audit log

The `audit-logs` collection is append-only: rows are written by the server (`recordAuditEvent` in
`src/server/security/audit.ts`), never by clients, and pruned after `AUDIT_LOG_RETENTION_DAYS` (default 365).

**What is recorded**

- Sign-ins and account security (instance-level rows, superadmins only): `auth.login`, `auth.login_failed`,
  `auth.rate_limited`, `auth.forgot_password`, `auth.break_glass`, `auth.sso_login(_failed)`,
  `auth.two_factor_*`, `auth.password_changed`, `auth.backup_codes_regenerated`.
- Membership: `member.role_changed`, `member.removed`, `member.ownership_transferred`,
  `invitation.created/accepted`.
- Every create, update and delete of monitors, notification channels, tags, proxies, Docker hosts, status
  pages, status page viewers, incidents, subscribers, subscriber notifications, maintenance, templates, API
  keys, SSO connections and domains, invitations and the organization itself (`<entity>.created|updated|deleted`),
  with named verbs where they say more: `monitor.paused/resumed/cloned`, `maintenance.paused/resumed`,
  `notification.enabled/disabled`, `api_key.enabled/disabled/revoked`, `maintenance_occurrence.updated`.
- Imports (`import.completed`, one row per import) and instance settings (`instance_settings.updated`).

`src/collections/audit.ts` lists every collection as audited or deliberately not audited (heartbeats,
rollups, delivery logs …); a test fails when a new collection is in neither list. Writes that only touch
caches the worker maintains (monitor status, certificate info, `lastSentAt`) are not recorded.

**Each row** names the actor (`actorType` user, apiKey, mcp or system, `actorId`, and the email or key name
at the time), the resource (`entityType`, `entityId`, `entityLabel`), the changed paths (`changedFields`) with
their `before`/`after` values, the client IP (only with `trustProxy`) and user agent. Rows join the
transaction of the change, so a rolled-back change leaves no row. Integrations subscribe with
`onAuditEvent` (`src/server/audit/bus.ts`), which delivers each row after its transaction commits.

**Secrets are never stored.** Values of keys that look like secrets (passwords, tokens, API keys, private
keys, webhook URLs, headers, hashes …) and of every provider field marked `secret` become `[redacted]`;
passwords inside URLs are masked and long strings are cut at 500 characters. A changed secret still shows
up in `changedFields`.

**Reading it**: Settings → Audit log (filters by actor, action, resource and date, a diff per event, CSV
export), the Activity tab of a monitor, and `GET /api/orgs/:orgId/audit-logs` (`actorType`, `actorId`,
`entityType`, `entityId`, `action` exact or `monitor.`-style prefix, `from`, `to`, `page`, `limit`) plus
`/export` for CSV. Reading needs `audit-log:read`: owners and admins by default; an owner can lower it to
members under Settings → Permissions. Superadmins also see instance-level rows (`scope=instance`).

## Hardening checklist

1. **Serve over TLS.** Set `NEXT_PUBLIC_SERVER_URL=https://…`; the compose stack's Caddy obtains certificates
   automatically when `DOMAIN` is set. HSTS is only meaningful over https.
2. **Turn on `trustProxy`** in instance settings once a reverse proxy sits in front of Marmot (see above).
3. **Use a strong `PAYLOAD_SECRET`** (`openssl rand -hex 32`) and rotate it if it ever leaks: every session
   is invalidated.
4. **Keep the database, Redis and the realtime port private.** Only Caddy (80/443) needs to be reachable
   from the internet; `REALTIME_PORT` is proxied under `/socket.io`.
5. **Disable open signup** (`DISABLE_SIGNUP=true` or the `allowSignup` instance setting) and invite people
   instead; use single sign-on (`OIDC_*`) where you can.
6. **Deny private addresses when untrusted people can create monitors.** Every member can point monitors
   and notification channels at any host, and the worker connects from inside your network (cloud
   metadata at `169.254.169.254`, the bundled Postgres and Redis, the Docker host, your tailnet). Set
   `MONITOR_DENY_PRIVATE_ADDRESSES=true` on instances with open sign-up or members you do not control,
   list internal subnets you do want monitored in `MONITOR_ALLOW_CIDRS`, and add anything else to
   `MONITOR_DENY_CIDRS`. The Instance settings page warns while sign-up is open and the guard is off.
7. **Limit superadmins.** They bypass organization access and can open `/admin`; give the flag to operators
   only, and review `audit-logs` for `auth.login_failed` bursts and `auth.break_glass` entries (owner password
   logins while an organization enforces single sign-on).
8. **Restrict CORS.** Add only the origins you control to `ADDITIONAL_ORIGINS`.
9. **Back up and update.** Follow [Deployment](Deployment.md) for backups, pin `MARMOT_VERSION` and apply
   releases promptly; watch the CI dependency audit output after upgrading your fork.
10. **Protect Redis.** Rate limiting and queues live there; use `requirepass`/ACLs and
    `maxmemory-policy noeviction`.
11. **Limit who can send through your mail server.** Keep `NOTIFICATIONS_SERVER_SMTP=superadmin` (the
    default) or set `off`, so only operators can point notification channels at the `SMTP_*` settings; keep
    `NOTIFICATIONS_SERVER_SMTP_RATE` low. After upgrading, review the channels that already use the server
    settings ([Deployment](Deployment.md#upgrading)).
