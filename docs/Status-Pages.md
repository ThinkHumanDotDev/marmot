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

| `incidents` field            | Notes                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `statusPage`, `organization` | The organization is derived from the page in a `beforeChange` hook.                                       |
| `title`                      | Shown on the card.                                                                                        |
| `updates[]`                  | The timeline: `status`, `message` (Markdown), `postedAt`, `editedAt`, `components[] { monitor, impact }`. |
| `status`                     | Derived: status of the latest update (`investigating`, `identified`, `monitoring`, `resolved`).           |
| `impact`                     | Derived: worst current component impact; set directly for incidents that name no component.               |
| `affectedMonitors[]`         | Derived: current `{ monitor, impact }` per component named by any update.                                 |
| `pinned`                     | Pinned incidents render above the monitor groups; resolving unpins.                                       |
| `active`, `resolvedAt`       | Derived from the timeline. Setting `active: false` posts a `resolved` update (and `true` reopens).        |
| `content`, `style`           | Legacy (pre-timeline). Still accepted on create and turned into the first update.                         |

### Incident timeline

An incident is a list of updates. Each update has a status — **investigating → identified → monitoring →
resolved** — a Markdown message, the time it was posted and, optionally, the impact it declares on page
components (the monitors in the page's groups):

| Impact                 | Shown as             | Counts for the page's overall status as |
| ---------------------- | -------------------- | --------------------------------------- |
| `operational`          | Operational          | the monitor's own status                |
| `degraded_performance` | Degraded performance | not fully up (→ partially degraded)     |
| `partial_outage`       | Partial outage       | not fully up (→ partially degraded)     |
| `major_outage`         | Major outage         | down                                    |

- Components left out of an update keep their last impact. A `resolved` update resets them all to
  operational; posting another update afterwards reopens the incident.
- The incident's indicator is the worst current impact. An incident that names no component carries a
  declared impact (for page-wide notices); `degraded_performance`/`partial_outage` make the page
  "partially degraded", `major_outage` makes it "major outage".
- Posted updates are history. Their text can be corrected later — the update is then shown as _edited_ —
  but status, time and impacts stay as posted. Updates may be back-dated, not post-dated.
- Only components of the incident's page can be affected. Deleting a monitor keeps the history (the
  reference becomes empty).
- Incidents created before the timeline existed migrate without data loss: they read as one update with
  their old text, posted when they were created (or when they were resolved), and their `style` maps to an
  impact (`info`/`primary` → operational, `warning` → degraded performance, `danger` → major outage). The
  update is stored on the incident's next write; no migration job is needed on either database.
- Every new update is announced through `onIncidentUpdatePosted()`
  (`src/server/status-pages/incident-events.ts`), the hook subscriber notifications build on.

Access (`src/access/permissions.ts`): `status-page:read` is granted to every role, `status-page:create`
/`update`/`delete` to members and above. Reads of `status-pages` are special-cased: anonymous requests
and members of other organizations only see `published: true` documents; members see their drafts too.
Incidents are never readable anonymously — the public API serves them. A `beforeChange` hook refuses
monitors that belong to another organization and hostnames already claimed by another page.

## Public endpoints

All of these are anonymous and return 404 for unknown or unpublished slugs.

| Route                                        | Returns                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `GET /status/:slug`                          | Server-rendered page (OpenGraph meta, manifest link, RSS alternate). |
| `GET /api/status-pages/:slug/public`         | JSON (below); `Cache-Control: public, max-age=30`.                   |
| `GET /status/:slug/rss`                      | RSS 2.0: one item per incident update and monitors currently down.   |
| `GET /status/:slug/manifest.json`            | Web app manifest.                                                    |
| `GET /api/status-pages/resolve-domain?host=` | `{ slug }` for a custom hostname (used by the proxy).                |

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
  "overall": "up", // up | partial | down | maintenance | unknown (monitors and active incident impacts)
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
          "impact": "major_outage", // worst impact of active incidents; omitted while operational
        },
      ],
    },
  ],
  "incidents": [
    // active incidents, pinned first, newest first
    {
      "id": "3",
      "title": "API errors",
      "status": "identified", // investigating | identified | monitoring | resolved
      "impact": "major_outage", // operational | degraded_performance | partial_outage | major_outage
      "components": [{ "id": "12", "name": "API", "impact": "major_outage" }], // current, visible components only
      "updates": [
        // newest first
        {
          "id": "6703f0c1a2b3c4d5e6f70812",
          "status": "identified",
          "message": "A bad deploy; rolling back.",
          "postedAt": "2026-10-05T03:10:00.000Z",
          "editedAt": null,
          "components": [], // impacts this update set
        },
        {
          "id": "6703f0c1a2b3c4d5e6f70811",
          "status": "investigating",
          "message": "We are looking into errors.",
          "postedAt": "2026-10-05T03:00:00.000Z",
          "editedAt": null,
          "components": [{ "id": "12", "name": "API", "impact": "major_outage" }],
        },
      ],
      "content": "A bad deploy; rolling back.", // latest message (pre-timeline clients)
      "style": "danger", // card colour derived from impact (pre-timeline clients)
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
four tabs: **Settings** (title, slug, description, theme, language once Marmot ships more than one, refresh,
custom CSS, analytics id, logo upload,
display toggles, delete), **Groups & monitors** (drag-and-drop groups and monitors with `dnd-kit`,
per-monitor "show URL" / custom link), **Incidents** (post, edit, pin, resolve, reopen, delete) and
**Domains**. The header switch publishes/unpublishes.

Mutations go through route handlers under `/api/orgs/:orgId/status-pages/**`
(`src/app/api/orgs/[orgId]/status-pages`), which authenticate the Payload session and call the Local API
with `overrideAccess: false`, so the collections' access rules decide what each role may do:

| Method & path                                            | Purpose                                      |
| -------------------------------------------------------- | -------------------------------------------- |
| `GET`/`POST /api/orgs/:orgId/status-pages`               | List / create                                |
| `GET`/`PATCH`/`DELETE /api/orgs/:orgId/status-pages/:id` | Read / partial update / delete (+ incidents) |
| `POST`/`DELETE …/:id/logo`                               | Upload (multipart `file`) / remove logo      |
| `GET`/`POST …/:id/incidents`                             | List / open incident (first update)          |
| `GET`/`PATCH`/`DELETE …/:id/incidents/:incidentId`       | Read / rename, pin, resolve / delete         |
| `GET`/`POST …/incidents/:incidentId/updates`             | Timeline (oldest first) / post an update     |
| `PATCH …/incidents/:incidentId/updates/:updateId`        | Edit an update's text (`{ message }`)        |

Opening an incident: `POST …/incidents` with
`{ title, pinned?, status?, message?, components?: [{ monitor, impact }], impact? }` (`status` defaults to
`investigating`; `impact` is the declared impact when no component is named). Pre-timeline clients may
still send `{ title, content, style }`. Posting an update: `POST …/updates` with
`{ status, message?, components?, postedAt?, impact? }`; it returns `201 { doc, update }`. Invalid statuses
or impacts, components that are not on the page and future `postedAt` values are refused with `400`;
viewers get `403`. The Payload REST API (`/api/incidents`) applies the same hooks.

## Custom domains

A page can be served at the root of its own hostnames (`domains[].hostname`). `src/proxy.ts` (the
Next.js 16 proxy, formerly middleware) runs for `/`, `/rss` and `/manifest.json` only:

1. It reads the visitor's host (`X-Forwarded-Host`, then `Host`) and ignores requests for Marmot's own
   hostname (`NEXT_PUBLIC_SERVER_URL`) or `localhost`.
2. It asks `GET /api/status-pages/resolve-domain?host=<host>` on the same origin (the response is cached
   for 60 s) and, when a published page lists that host, rewrites the request to
   `/status/<slug>[/rss|/manifest.json]`.
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

- `tests/int/incident-timeline.int.spec.ts` — the investigating → identified → monitoring → resolved flow
  through the REST routes, per-component impact in the public payload and overall status, RSS items per
  update, edited text, validation and roles, declared impacts, legacy migration and the update event.
- `src/lib/incident-timeline.test.ts` — the timeline rules (impact carry-over, resolve reset, ordering,
  style mapping).
- `tests/int/status-pages.int.spec.ts` — access rules (anonymous / member / other organization), slug and
  hostname normalisation, cross-organization monitor refusal, incident derivation and resolution, the public
  payload shape, 404s, `resolve-domain`, RSS validity and escaping, manifest.
- `src/lib/markdown.test.ts` — the Markdown subset and its HTML escaping.
- `tests/e2e/status-pages.e2e.spec.ts` — seeds an organization, monitor and published page through the
  Local API, visits `/status/<slug>` anonymously, checks title, group, monitor link, incident (including a
  timeline with a major outage until it is resolved) and the
  public API / RSS / manifest; unpublished slugs return 404.
