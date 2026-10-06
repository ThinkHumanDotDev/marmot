# Security

What Marmot does to protect an instance, and what the operator has to provide. Report vulnerabilities as
described in [SECURITY.md](../SECURITY.md).

## Built in

| Area                 | Behaviour                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin panel          | `/admin` (Payload) is reachable by **superadmins only** (`users.access.admin`). Everyone else uses the Marmot UI; the "Admin panel" menu entry is hidden for them.                                                                                                                                                      |
| Organizations        | Every collection is scoped to the user's organizations through role-based access (`src/access`). Server code that acts for a user passes `overrideAccess: false`.                                                                                                                                                       |
| CORS / CSRF          | Only `NEXT_PUBLIC_SERVER_URL` and the origins in `ADDITIONAL_ORIGINS` may use the auth cookie against the API. Other origins get no session.                                                                                                                                                                            |
| Rate limiting        | Redis-backed (`rate-limiter-flexible`): password login 10/min per client with a 5-minute block, password reset 5 per 15 min, SSO login + callback 20/min. Responses carry `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Fails open if Redis is down (one warning is logged).                          |
| Audit log            | `audit-logs` collection: logins (success, failure, rate-limited), member role changes and removals, invitations created/accepted, organizations updated/deleted, with actor, IP and user agent. Readable by organization admins (their organization) and superadmins; never writable by clients; pruned after 365 days. |
| Security headers     | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, `X-Frame-Options: DENY` everywhere except public status pages (`/status/*`, which may be embedded), and HSTS when the public URL is https.                                                   |
| Secrets in the model | Invitation tokens, invite-link tokens and SSO identifiers (`auth-accounts` rows) are write-protected; API responses only expose them to roles that need them.                                                                                                                                                           |
| Dependencies         | CI runs `pnpm audit --prod --audit-level=high` (advisory) on every push; Dependabot keeps Payload, Next.js and the rest current.                                                                                                                                                                                        |

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
account (per e-mail) and the OIDC endpoints are not limited.

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
6. **Limit superadmins.** They bypass organization access and can open `/admin`; give the flag to operators
   only, and review `audit-logs` for `auth.login_failed` bursts.
7. **Restrict CORS.** Add only the origins you control to `ADDITIONAL_ORIGINS`.
8. **Back up and update.** Follow [Deployment](Deployment.md) for backups, pin `MARMOT_VERSION` and apply
   releases promptly; watch the CI dependency audit output after upgrading your fork.
9. **Protect Redis.** Rate limiting and queues live there; use `requirepass`/ACLs and
   `maxmemory-policy noeviction`.
