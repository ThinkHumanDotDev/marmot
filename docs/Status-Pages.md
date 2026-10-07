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
and members of other organizations only see `published: true` documents; members see their drafts too.
Incidents are never readable anonymously — the public API serves them. A `beforeChange` hook refuses
monitors that belong to another organization and hostnames already claimed by another page.

## Public endpoints

All of these are anonymous and return 404 for unknown or unpublished slugs.

| Route                                        | Returns                                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `GET /status/:slug`                          | Server-rendered page (OpenGraph meta, manifest link, RSS alternate).  |
| `GET /api/status-pages/:slug/public`         | JSON (below); `Cache-Control: public, max-age=30`.                    |
| `GET /status/:slug/rss`                      | RSS 2.0: incidents (active and resolved) and monitors currently down. |
| `GET /status/:slug/manifest.json`            | Web app manifest.                                                     |
| `GET /status/:slug/badge.svg`                | Overall status badge ([below](#status-badge)).                        |
| `GET /api/status-pages/resolve-domain?host=` | `{ slug }` for a custom hostname (used by the proxy).                 |

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
per-monitor "show URL" / custom link), **Incidents** (post, edit, pin, resolve, reopen, delete),
**Domains** and **Share** (the [status badge](#status-badge) with Markdown and HTML snippets). The header switch publishes/unpublishes.

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

## Status badge

`GET /status/:slug/badge.svg` is one SVG badge with the overall state of the page, for a README or a
website footer (per-monitor badges are in [Integrations](Integrations.md#badges)). The **Share** tab of the
editor builds the URL and copies Markdown or HTML snippets that link the badge to the page. On a custom
domain the same badge is served at `https://status.example.com/badge.svg`.

| State                   | Colour    | When                                                                                       |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------ |
| All systems operational | `#66c20a` | Every checked monitor is up.                                                               |
| Degraded performance    | `#eed202` | An active incident marks a component as degraded performance.                              |
| Partial outage          | `#f8a306` | Some monitors are down, or an incident marks a component as a partial outage.              |
| Major outage            | `#c2290a` | All monitors are down, or an incident marks a component as a major outage.                 |
| Under maintenance       | `#1747f5` | A monitor is in maintenance, or a maintenance window attached to the page is running.      |
| Unknown                 | `#999`    | No monitor has been checked yet, the page is not published, or the visitor may not see it. |

The state is computed from the same data as the page (`overall` in the public JSON, see
`statusPageBadgeState()` in `src/server/status-pages/badge.ts`); when several apply, the most severe wins
(major > partial > degraded > maintenance > operational > unknown). Only the state is rendered: never
monitor names, uptime or response times, whatever the page's display settings.

| Parameter | Values                                                      | Default                                                          |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `theme`   | `light`, `dark`                                             | `light`                                                          |
| `size`    | `sm`, `md`, `lg`, `xl`                                      | `md`                                                             |
| `variant` | `default` (filled), `outline` (status-coloured border)      | `default`                                                        |
| `style`   | `flat`, `flat-square`, `plastic`, `for-the-badge`, `social` | none: Marmot's pill (dot + text)                                 |
| `label`   | any text (≤ 64 characters)                                  | none for the pill; `Status` with `style` (as the monitor badges) |

`theme`, `size` and `variant` apply to the pill; with `style` the shields.io renderer of the monitor
badges draws a `label | state` badge in the colours above. Unknown parameter values fall back to the
defaults. Responses are `image/svg+xml` with `Access-Control-Allow-Origin: *` and
`Cache-Control: public, max-age=<autoRefreshInterval>` (at least 30 s; 300 s when auto-refresh is off).
Unknown or unpublished slugs answer `404` with an `Unknown` badge and `no-store`. Every request goes
through one access check (`statusPageBadgeAccess`), so pages a visitor may not view render `Unknown`.

## Custom domains

A page can be served at the root of its own hostnames (`domains[].hostname`). `src/proxy.ts` (the
Next.js 16 proxy, formerly middleware) runs for `/`, `/rss`, `/manifest.json` and `/badge.svg` only:

1. It reads the visitor's host (`X-Forwarded-Host`, then `Host`) and ignores requests for Marmot's own
   hostname (`NEXT_PUBLIC_SERVER_URL`) or `localhost`.
2. It asks `GET /api/status-pages/resolve-domain?host=<host>` on the same origin (the response is cached
   for 60 s) and, when a published page lists that host, rewrites the request to
   `/status/<slug>[/rss|/manifest.json|/badge.svg]`.
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
- `tests/int/status-page-badge.int.spec.ts` — badge route: each state from monitor statuses and running
  maintenance, headers, shields style and pill options, no figures in the SVG, 404s.
  `src/server/status-pages/badge.test.ts` (state precedence, incident impact), `src/server/badges/status-page.test.ts`
  (renderers) and `src/lib/status-page-badge.test.ts` (embed snippets) are the unit tests.
- `src/lib/markdown.test.ts` — the Markdown subset and its HTML escaping.
- `tests/e2e/status-pages.e2e.spec.ts` — seeds an organization, monitor and published page through the
  Local API, visits `/status/<slug>` anonymously, checks title, group, monitor link, incident and the
  public API / RSS / manifest; unpublished slugs return 404.
