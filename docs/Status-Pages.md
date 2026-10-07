# Status pages

Public status pages show visitors the live state of a set of monitors, grouped the way you choose, plus
incidents you post. Every organization can publish any number of pages; each page has a globally unique
slug and lives at `/status/<slug>` (or at the root of a custom domain).

To publish one: **Status pages → New page**, give it a title and slug, add groups and drag monitors into
them on the **Groups & monitors** tab, then flip **Published** in the header. Visitors see each monitor's
current status, its last 50 heartbeats and 24h/30d uptime, the incidents you post, running and upcoming
[maintenance windows](Maintenance.md), and (landing in the current release) status badges. Members and above can edit pages; viewers can see
drafts but not change them.

## Data model

Two org-scoped collections (`src/collections/StatusPages.ts`, `src/collections/Incidents.ts`):

| `status-pages` field                                 | Notes                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `organization`                                       | Owning organization (required).                                                |
| `slug`                                               | Globally unique, lower-cased; reserved words from `src/lib/reserved-slugs.ts`. |
| `title`, `description`, `logo` (media), `footerText` | Shown on the page; description and footer accept the Markdown subset below.    |
| `theme`                                              | `auto` (visitor preference), `light` or `dark`.                                |
| `language`                                           | Locale of the page text (`en`), or `auto` to follow the visitor's browser.     |
| `published`                                          | Only published pages are served; drafts 404 for visitors.                      |
| `access`, `password` (write-only)                    | `public` or `password`; see [Password protection](#password-protection).       |
| `searchEngineIndex`                                  | Emits `robots: index, follow` instead of `noindex`.                            |
| `showTags`, `showCertificateExpiry`, `showPoweredBy` | Display toggles.                                                               |
| `autoRefreshInterval`                                | Seconds between client refreshes of the public API; `0` disables.              |
| `customCSS`                                          | Injected into the public page as a `<style>` tag.                              |
| `googleAnalyticsId`                                  | `G-…` measurement id; the gtag snippet is only emitted when set.               |
| `domains[].hostname`                                 | Custom hostnames (see below). Unique across all pages.                         |
| `groups[]`                                           | `name` + `monitors[] { monitor, sendUrl, customUrl }`, in display order.       |

| `incidents` field            | Notes                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `statusPage`, `organization` | The organization is derived from the page in a `beforeChange` hook.                          |
| `title`, `content`           | `content` is Markdown (paragraphs, `**bold**`, `_italics_`, `` `code` ``, links, `-` lists). |
| `style`                      | `info`, `warning`, `danger` or `primary` (card colour).                                      |
| `pinned`                     | Pinned incidents render above the monitor groups.                                            |
| `active`, `resolvedAt`       | Setting `active: false` stamps `resolvedAt` and unpins.                                      |

Access (`src/access/permissions.ts`): `status-page:read` is granted to every role, `status-page:create`
/`update`/`delete` to members and above. Reads of `status-pages` are special-cased: anonymous requests
and members of other organizations only see `published: true` documents that are not
password-protected; members see their drafts and protected pages too.
Incidents are never readable anonymously — the public API serves them. A `beforeChange` hook refuses
monitors that belong to another organization and hostnames already claimed by another page.

## Public endpoints

All of these are anonymous and return 404 for unknown or unpublished slugs. For password-protected
pages they also need the page's access cookie or `?pw=` (see below), and answer 401 otherwise.

| Route                                        | Returns                                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `GET /status/:slug`                          | Server-rendered page (OpenGraph meta, manifest link, RSS alternate).  |
| `GET /api/status-pages/:slug/public`         | JSON (below); `Cache-Control: public, max-age=30`.                    |
| `GET /status/:slug/rss`                      | RSS 2.0: incidents (active and resolved) and monitors currently down. |
| `GET /status/:slug/manifest.json`            | Web app manifest.                                                     |
| `GET /api/status-pages/resolve-domain?host=` | `{ slug }` for a custom hostname (used by the proxy).                 |
| `GET /status/:slug/login`                    | Password form of a protected page.                                    |
| `POST /api/status-pages/:slug/access`        | Checks the page password and sets the access cookie.                  |

```jsonc
{
  "config": {
    "slug": "acme",
    "title": "Acme Status",
    "description": "…",
    "logo": "/api/media/file/logo.png",
    "theme": "auto",
    "published": true,
    "showTags": false,
    "showCertificateExpiry": false,
    "showPoweredBy": true,
    "autoRefreshInterval": 300,
    "customCSS": null,
    "footerText": null,
    "googleAnalyticsId": null,
  },
  "overall": "up", // up | partial | down | maintenance | unknown
  "groups": [
    {
      "name": "Core",
      "monitors": [
        {
          "id": "12",
          "name": "Website",
          "url": "https://example.com", // url only when sendUrl/customUrl
          "status": "up", // up | down | pending | maintenance | unknown
          "uptime24h": 0.9993,
          "uptime30d": 0.9981,
          "beats": [{ "status": "up", "time": "2026-10-05T03:00:00.000Z", "ping": 42 }], // oldest first, ≤ 50
          "tags": [{ "name": "env", "color": "#2563EB", "value": "prod" }], // only when showTags
        },
      ],
    },
  ],
  "incidents": [
    {
      "id": "3",
      "title": "…",
      "content": "…",
      "style": "warning",
      "pinned": true,
      "active": true,
      "createdAt": "…",
      "updatedAt": "…",
      "resolvedAt": null,
    },
  ],
  "maintenance": [
    // running windows first, then windows starting within 7 days (maintenance.md)
    {
      "id": "7",
      "title": "Database upgrade",
      "description": "Expect a few minutes of read-only mode.",
      "strategy": "single", // manual | single | recurring-interval | recurring-weekday | recurring-day-of-month | cron
      "status": "scheduled", // under-maintenance | scheduled
      "start": "2026-10-06T02:00:00.000Z", // null for manual windows
      "end": "2026-10-06T03:00:00.000Z", // null when open-ended
      "timezone": "Europe/Berlin",
    },
  ],
  "generatedAt": "2026-10-05T03:00:30.000Z",
}
```

Internal ids (organization, media rows, domains) never appear in the payload. Paused or deleted monitors
are dropped from the groups. The page is rendered on the server from the same data and then, when
`autoRefreshInterval > 0`, the client component re-fetches the JSON on that interval (polling only; the
realtime socket is not used on public pages).

## Builder

`/{orgSlug}/status-pages` lists the organization's pages; `/{orgSlug}/status-pages/{id}` edits one with
five tabs: **Settings** (title, slug, description, theme, language once Marmot ships more than one, refresh,
custom CSS, analytics id, logo upload,
display toggles, delete), **Groups & monitors** (drag-and-drop groups and monitors with `dnd-kit`,
per-monitor "show URL" / custom link), **Incidents** (post, edit, pin, resolve, reopen, delete) and
**Domains** and **Access** (public or password, see below). The header switch publishes/unpublishes.

Mutations go through route handlers under `/api/orgs/:orgId/status-pages/**`
(`src/app/api/orgs/[orgId]/status-pages`), which authenticate the Payload session and call the Local API
with `overrideAccess: false`, so the collections' access rules decide what each role may do:

| Method & path                                            | Purpose                                      |
| -------------------------------------------------------- | -------------------------------------------- |
| `GET`/`POST /api/orgs/:orgId/status-pages`               | List / create                                |
| `GET`/`PATCH`/`DELETE /api/orgs/:orgId/status-pages/:id` | Read / partial update / delete (+ incidents) |
| `POST`/`DELETE …/:id/logo`                               | Upload (multipart `file`) / remove logo      |
| `GET`/`POST …/:id/incidents`                             | List / post incident                         |
| `PATCH`/`DELETE …/:id/incidents/:incidentId`             | Edit, pin, resolve / delete                  |

## Password protection

A page's **Access** tab switches it between **Public** (default) and **Password**. Protection applies to
published pages; signed-in members still preview their pages from the builder.

- The password (8–256 characters) is written through the write-only `password` field and stored as an
  scrypt hash in `passwordHash`, which field access hides from every API; only server code reading with
  `overrideAccess` sees it. Switching back to **Public** deletes the hash.
- Visitors without access are redirected from the page to `/status/<slug>/login` (`/login` on a custom
  domain). The form posts to `POST /api/status-pages/:slug/access` (form fields or JSON
  `{ "password": "…" }`). A correct password sets an HttpOnly, `SameSite=Lax` cookie named
  `marmot_sp_<page id>` holding a signed token for that page; it lasts `STATUS_PAGE_SESSION_DAYS`
  (default 30) days. The token embeds a keyed fingerprint of the password hash, so **changing the
  password signs every visitor out**. The cookie path is `/` because the page, its API, feed and badges
  live under different paths; the name and the signed page id keep it to one page.
- Feed readers and scripts can pass the password as `?pw=<password>` to the JSON endpoint, the RSS feed,
  `manifest.json` and badge URLs. **This puts the password in URLs, browser history, proxy and server
  logs**; prefer the cookie (JSON login) where the client can keep one.
- Every public surface checks access through `checkStatusPageAccess`
  (`src/server/status-pages/access.ts`): the HTML page (cookie only), `/api/status-pages/:slug/public`,
  `/rss`, `manifest.json` (linked with `crossorigin="use-credentials"`), badges of monitors that only
  appear on protected pages, and all of these on custom domains. Without access the machine endpoints
  answer `401` with `{ "error", "code": "login-required" | "invalid-password" }`.
- Responses of protected pages carry `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`;
  protected pages are always `noindex`, whatever `searchEngineIndex` says. Without access, the page's
  metadata reveals only its title.
- Password checks (form, JSON and `?pw=`) are rate limited: 10 attempts per minute per page and client
  IP, then a 5-minute block. The client IP is only known behind a trusted proxy (instance setting
  `trustProxy`); without one, all visitors of a page share a bucket of 30 attempts per minute. Blocked
  clients get `429` with `Retry-After` (the form shows a message) and cannot try the right password
  either. Already signed-in visitors are unaffected.
- Exports never contain the password: a protected page is exported as a draft, so importing it does not
  publish it unprotected.

## Custom domains

A page can be served at the root of its own hostnames (`domains[].hostname`). `src/proxy.ts` (the
Next.js 16 proxy, formerly middleware) runs for `/`, `/rss`, `/manifest.json` and `/login` only:

1. It reads the visitor's host (`X-Forwarded-Host`, then `Host`) and ignores requests for Marmot's own
   hostname (`NEXT_PUBLIC_SERVER_URL`) or `localhost`.
2. It asks `GET /api/status-pages/resolve-domain?host=<host>` on the same origin (the response is cached
   for 60 s) and, when a published page lists that host, rewrites the request to
   `/status/<slug>[/rss|/manifest.json|/login]`.
3. Any failure (lookup error, invalid host, no match) falls through to normal routing, so the proxy can
   never take the main site down.

Setup for a domain:

1. Create a `CNAME` (or `A`) record for `status.example.com` pointing at the Marmot host.
2. Add the hostname on the page's **Domains** tab and make sure the page is published.
3. Let the reverse proxy obtain a certificate. With the bundled Caddy, enable **on-demand TLS** so any
   hostname that resolves to a published page gets a certificate on first request:

```caddyfile
{
	email "{$ACME_EMAIL}"
	on_demand_tls {
		# Caddy asks Marmot before issuing: only hostnames of published status pages are allowed.
		ask http://web:3000/api/status-pages/resolve-domain
	}
}

# Marmot itself (DOMAIN from .env).
{$SITE_ADDRESS::80} {
	import marmot
}

# Any other hostname: certificates on demand, same upstreams.
https:// {
	tls {
		on_demand
	}
	import marmot
}

(marmot) {
	encode zstd gzip
	@realtime path /socket.io/*
	handle @realtime {
		reverse_proxy realtime:3001
	}
	handle {
		reverse_proxy web:3000
	}
}
```

Caddy calls the `ask` endpoint with `?domain=<host>`; the route accepts both `domain=` and `host=`
and answers `200` for a hostname of a published page and `404` for anything else, which is exactly what
`on_demand_tls` needs (so certificates are never issued for hostnames you did not configure).

With another proxy (nginx, Traefik, Cloudflare), terminate TLS there, forward the original `Host` (or set
`X-Forwarded-Host`) and point the hostname at the same upstream as the main site.

## Testing

- `tests/int/status-pages.int.spec.ts` — access rules (anonymous / member / other organization), slug and
  hostname normalisation, cross-organization monitor refusal, incident derivation and resolution, the public
  payload shape, 404s, `resolve-domain`, RSS validity and escaping, manifest.
- `src/lib/markdown.test.ts` — the Markdown subset and its HTML escaping.
- `tests/e2e/status-pages.e2e.spec.ts` — seeds an organization, monitor and published page through the
  Local API, visits `/status/<slug>` anonymously, checks title, group, monitor link, incident and the
  public API / RSS / manifest; unpublished slugs return 404.
- `tests/int/status-page-access.int.spec.ts` — password protection: hashing and field access, 401 on the
  JSON endpoint, RSS, manifest and badges without access, login (JSON and form, cross-site refusal),
  `?pw=`, cookies per page, custom domains, password change ending sessions, rate limiting, export.
  `src/server/status-pages/access.test.ts` and `src/server/security/password-hash.test.ts` cover the
  token and hash primitives.
- `tests/e2e/status-pages.e2e.spec.ts` also protects a page, checks the login redirect and form, and
  that the page and its feed open after signing in.
