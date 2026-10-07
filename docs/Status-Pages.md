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
| `logoDark`, `favicon` (media)                        | Dark-mode logo and favicon ([Themes](#themes)); uploaded through the builder.  |
| `theme`                                              | `auto` (visitor picks system/light/dark), or a forced `light` / `dark`.        |
| `themePreset`, `themeOverrides`                      | Built-in palette id and validated colour overrides ([Themes](#themes)).        |
| `bannerText`                                         | Optional headline (≤ 140 characters) that replaces the overall-status text.    |
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
| `GET /api/status-pages/resolve-domain?host=` | `{ slug }` for a custom hostname (used by the proxy).                 |

```jsonc
{
  "config": {
    "slug": "acme",
    "title": "Acme Status",
    "description": "…",
    "logo": "/api/media/file/logo.png",
    "logoDark": null, // dark-mode logo
    "favicon": null, // falls back to the logo
    "theme": "auto",
    "themePreset": "default",
    "bannerText": null, // custom headline replacing the overall-status text
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
five tabs: **Settings** (title, slug, description, language once Marmot ships more than one, refresh,
custom CSS, analytics id, display toggles, delete), **Theme** (colour mode, preset, colour overrides,
banner headline, logos and favicon, with a live preview; see [Themes](#themes)), **Groups & monitors** (drag-and-drop groups and monitors with `dnd-kit`,
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
| `POST`/`DELETE …/:id/logo-dark`                          | Upload / remove the dark-mode logo           |
| `POST`/`DELETE …/:id/favicon`                            | Upload / remove the favicon                  |
| `GET`/`POST …/:id/incidents`                             | List / post incident                         |
| `PATCH`/`DELETE …/:id/incidents/:incidentId`             | Edit, pin, resolve / delete                  |

## Themes

Pages are themed through a documented set of CSS variables instead of internal class names, so a brand
survives Marmot upgrades. Everything lives in `src/lib/status-page-themes/` and is shared by the
collection (validation), the public page (CSS) and the editor (preview).

**Colour mode** (`theme`): `auto` shows visitors a system / light / dark switch in the page header; the
choice is remembered in `localStorage` (`marmot:status-page-theme`) and applied before paint, so the page
never flashes. `light` and `dark` force that mode and hide the switch.

**Presets** (`themePreset`) define every token for light and dark mode:

| Id              | Notes                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| `default`       | Marmot's own palette (`styles.css`). Emits no CSS at all.                 |
| `high-contrast` | Black/white surfaces; text ≥ 7:1, status colours ≥ 4.5:1 (WCAG AAA / AA). |
| `ocean`         | Blues, violet maintenance colour.                                         |
| `forest`        | Greens on warm surfaces.                                                  |
| `graphite`      | Neutral greys, tighter corners.                                           |

Every preset except `default` keeps text and status colours at ≥ 4.5:1 against background and cards
in both modes; `themes.test.ts` enforces it. To add a preset, add a file under
`src/lib/status-page-themes/presets/`, register it in `presets/index.ts` and add its display name under
`statusPages.theme.presets` in `src/i18n/messages/en.json`. The id is stored as text, so no migration is
needed.

**Overrides** (`themeOverrides`) replace single tokens per mode on top of the preset:

```jsonc
{
  "light": { "primary": "#0b5cad" },
  "dark": { "primary": "#ff8800", "destructive": "oklch(0.7 0.19 25)" },
  "radius": "0.5rem",
}
```

| Token                                                      | CSS variables                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `background`                                               | `--background`                                                        |
| `foreground`                                               | `--foreground`, `--card-foreground`, `--popover-foreground`, …        |
| `card`                                                     | `--card`, `--popover`                                                 |
| `primary`, `primaryForeground`                             | `--primary`, `--ring`; `--primary-foreground`                         |
| `muted`, `mutedForeground`                                 | `--muted`, `--secondary`, `--accent`; `--muted-foreground`            |
| `border`                                                   | `--border`, `--input`                                                 |
| `success` (up), `warning` (degraded), `info` (maintenance) | `--status-up`, `--status-pending`, `--status-maintenance` (+ `-text`) |
| `destructive` (down)                                       | `--status-down`, `--status-down-text`, `--destructive`                |
| `chart1` … `chart5`                                        | `--chart-1` … `--chart-5`                                             |
| `radius` (both modes)                                      | `--radius`: `0`, up to `2rem` or up to `32px`                         |

Colours must be hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()`, `hsl()`/`hsla()` or
`oklch()` with plain numbers; named colours, `var()`, `calc()`, `url()` and anything else are rejected
with a 400 (the API, the builder and the Payload admin all go through the same field validation). The
public layout renders the result as `html:not(.dark){…}` and `html.dark{…}` rules containing only known
variables, re-validating every value, so overrides cannot inject CSS. The builder warns when text
contrast drops below 4.5:1 (or an overridden status colour below 3:1) but does not block saving.
`customCSS` stays available as an escape hatch.

**Logos and favicon**: `logo` is shown in light mode (and in dark mode when there is no `logoDark`);
`logoDark` replaces it in dark mode, swapped by CSS so it follows the visitor switch. The page title is
always shown as text. Logos accept PNG, JPEG, GIF, WebP, AVIF or SVG up to 2 MB; the `favicon` accepts
PNG, ICO or SVG up to 100 KB and falls back to the logo. Formats are detected from the file's bytes,
not the declared type. SVGs are rebuilt by an allowlist sanitiser (`src/server/status-pages/svg.ts`):
scripts, event handlers, `foreignObject`, external references, `<style>`, DOCTYPEs and entities are
removed or rejected. Media URLs point at Marmot's own host, so logos and favicon also load on custom
domains; the favicon and logo are listed in the web manifest.

**Banner headline** (`bannerText`): replaces the automatic overall-status text (for example "Scheduled
upgrade tonight"). The banner colour still follows the monitors, and screen readers still hear the
real state.

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

- `tests/int/status-pages.int.spec.ts` — access rules (anonymous / member / other organization), slug and
  hostname normalisation, cross-organization monitor refusal, incident derivation and resolution, the public
  payload shape, 404s, `resolve-domain`, RSS validity and escaping, manifest.
- `tests/int/status-page-themes.int.spec.ts` — presets and overrides through the builder API, rejection
  of invalid colours (CSS injection, `var()`, unknown tokens), viewer access, light/dark logo and
  favicon uploads (SVG sanitising, size and format caps, no orphaned media), public payload and manifest.
- `src/lib/status-page-themes/themes.test.ts` — the colour grammar, CSS generation and preset contrast;
  `src/server/status-pages/svg.test.ts` — the SVG sanitiser.
- `src/lib/markdown.test.ts` — the Markdown subset and its HTML escaping.
- `tests/e2e/status-pages.e2e.spec.ts` — seeds an organization, monitor and published page through the
  Local API, visits `/status/<slug>` anonymously, checks title, group, monitor link, incident and the
  public API / RSS / manifest; unpublished slugs return 404.
