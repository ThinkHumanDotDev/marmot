# Status pages

Public status pages show visitors the live state of a set of monitors, grouped the way you choose, plus
incidents you post. Every organization can publish any number of pages; each page has a globally unique
slug and lives at `/status/<slug>` (or at the root of a custom domain).

To publish one: **Status pages → New page**, give it a title and slug, add groups and drag monitors into
them on the **Groups & monitors** tab, then flip **Published** in the header. Visitors see each monitor's
current status, its last 50 heartbeats and 24h/30d uptime (unless hidden), [static components](#components)
whose status you set through incidents, the incidents you post, running and upcoming
[maintenance windows](Maintenance.md), and (landing in the current release) status badges. Members and above can edit pages; viewers can see
drafts but not change them.

## Data model

Three org-scoped collections (`src/collections/StatusPages.ts`, `src/collections/Incidents.ts`,
`src/collections/StatusPageViewers.ts`):

| `status-pages` field                                 | Notes                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `organization`                                       | Owning organization (required).                                                |
| `slug`                                               | Globally unique, lower-cased; reserved words from `src/lib/reserved-slugs.ts`. |
| `title`, `description`, `logo` (media), `footerText` | Shown on the page; description and footer accept the Markdown subset below.    |
| `logoDark`, `favicon` (media)                        | Dark-mode logo and favicon ([Themes](#themes)); uploaded through the builder.  |
| `homepageUrl`                                        | Where the logo (or the title, without a logo) links to; `http(s)` only.        |
| `contactUrl`                                         | "Contact us" button in the header; `http(s)` URL or `mailto:` address.         |
| `theme`                                              | `auto` (visitor picks system/light/dark), or a forced `light` / `dark`.        |
| `themePreset`, `themeOverrides`                      | Built-in palette id and validated colour overrides ([Themes](#themes)).        |
| `bannerText`                                         | Optional headline (≤ 140 characters) that replaces the overall-status text.    |
| `language`                                           | Locale of the page text (`en`), or `auto` to follow the visitor's browser.     |
| `published`                                          | Only published pages are served; drafts 404 for visitors.                      |
| `access`, `password` (write-only)                    | `public`, `password`, `email-domain` or `ip-allowlist`; see [Access](#access). |
| `allowedEmailDomains[].domain`                       | Domains admitted by `email-domain` access (lower-cased, without `@`).          |
| `allowedIpRanges[] { cidr, label }`                  | IPv4/IPv6 CIDR ranges admitted by `ip-allowlist` access.                       |
| `searchEngineIndex`                                  | Emits `robots: index, follow` instead of `noindex`.                            |
| `showTags`, `showCertificateExpiry`, `showPoweredBy` | Display toggles.                                                               |
| `showValues`                                         | Default `true`. Off hides uptime % and response times page-wide (HTML + JSON). |
| `autoRefreshInterval`                                | Seconds between client refreshes of the public API; `0` disables.              |
| `customCSS`                                          | Injected into the public page as a `<style>` tag.                              |
| `googleAnalyticsId`                                  | `G-…` measurement id; the gtag snippet is only emitted when set.               |
| `domains[].hostname`                                 | Custom hostnames (see below). Unique across all pages.                         |
| `groups[]`                                           | `name`, `defaultOpen` + `monitors[]` (components, see below), in order.        |

| `incidents` field            | Notes                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `statusPage`, `organization` | The organization is derived from the page in a `beforeChange` hook.                                |
| `title`, `content`           | `content` is Markdown (paragraphs, `**bold**`, `_italics_`, `` `code` ``, links, `-` lists).       |
| `style`                      | `info`, `warning`, `danger` or `primary` (card colour).                                            |
| `pinned`                     | Pinned incidents render above the monitor groups.                                                  |
| `active`, `resolvedAt`       | Setting `active: false` stamps `resolvedAt` and unpins.                                            |
| `affectedComponents[]`       | `{ component, impact }`: component row id of the page and its impact while the incident is active. |

### Components

Every row of `groups[].monitors[]` is a **component** (`src/lib/status-page-components.ts`). The array
keeps its original name, so pages created before components existed migrate unchanged (every row becomes
a `monitor` component with values shown, every group starts expanded).

| Component field        | Notes                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                   | Payload array row id (a string on every database). The stable component id incidents point at.   |
| `type`                 | `monitor` (default) or `static`.                                                                 |
| `monitor`              | Required for `monitor` components; always cleared on `static` ones.                              |
| `name`                 | Public display name. Required for `static`. For monitors it overrides the monitor's name.        |
| `description`          | Shown to visitors as a tooltip next to the name.                                                 |
| `showValues`           | Default `true`. Off hides this component's uptime and response times (needs the page toggle on). |
| `sendUrl`, `customUrl` | Link shown to visitors (the monitor URL, or a custom link).                                      |

- **Display name**: component `name` → the monitor's `publicName` (Monitor form → _Public name_) → the
  monitor's `name`. The internal monitor name never reaches the public page, its JSON or the RSS feed when a
  public name is set.
- **Impact**: incidents list the components they affect with an impact of `operational`,
  `degraded_performance`, `partial_outage` or `major_outage`. While an incident is active, each affected
  component reports the worst impact of all active incidents (`impact` in the JSON, a label on the page).
- **Static component status** comes only from incidents and maintenance: a non-operational impact maps to
  `pending` (degraded / partial outage) or `down` (major outage); otherwise a running
  [maintenance window](Maintenance.md) attached to the page shows `maintenance`; otherwise `up`. Monitor
  components keep their monitor's status and show the impact next to it.
- **Groups** render as collapsible sections; `defaultOpen: false` starts them closed. The header shows the
  worst status of the group's components (`down` > `pending` > `maintenance` > `up` > `unknown`).
- **Values**: when `showValues` is off (page or component), the public JSON omits `uptime24h`/`uptime30d`
  and the beats carry no `ping`; the page renders neither.

Removing a component from a page leaves incident references dangling; they are ignored on the public page
and shown as "Removed component" in the builder. The builder sends row ids back on save so components keep
their ids when groups are reordered or edited.

| `status-page-viewers` field | Notes                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| `page`, `organization`      | The `email-domain` page the visitor signed in to, and its organization. |
| `email`                     | The verified address (lower-cased); unique per page.                    |
| `status`                    | `active` or `revoked` (signed out, no new links to that address).       |
| `lastSeenAt`                | Last visit (refreshed at most every five minutes).                      |

Access (`src/access/permissions.ts`): `status-page:read` is granted to every role, `status-page:create`
/`update`/`delete` to members and above. Reads of `status-pages` are special-cased: anonymous requests
and members of other organizations only see `published: true` documents with `public` access;
members see their drafts and protected pages too. Viewers are created only by the sign-in link
(server side); `status-page:read` lists them and `status-page:update` revokes, restores and deletes them.
Incidents are never readable anonymously — the public API serves them. A `beforeChange` hook refuses
monitors that belong to another organization and hostnames already claimed by another page.

## Public endpoints

All of these are anonymous and return 404 for unknown or unpublished slugs. Protected pages also need
access (see [Access](#access)): the page's access cookie or `?pw=` (401 otherwise), or a client address
in the IP allow-list (403 otherwise).

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
    "logoDark": null, // dark-mode logo
    "favicon": null, // falls back to the logo
    "homepageUrl": "https://example.com",
    "contactUrl": "mailto:support@example.com",
    "theme": "auto",
    "themePreset": "default",
    "bannerText": null, // custom headline replacing the overall-status text
    "published": true,
    "showTags": false,
    "showCertificateExpiry": false,
    "showPoweredBy": true,
    "showValues": true,
    "autoRefreshInterval": 300,
    "customCSS": null,
    "footerText": null,
    "googleAnalyticsId": null,
  },
  "overall": "up", // up | partial | down | maintenance | unknown
  "groups": [
    {
      "name": "Core",
      "defaultOpen": true,
      "status": "pending", // worst status of the components
      "monitors": [
        {
          "id": "12", // monitor id (component id for static components)
          "componentId": "6702f1c4e1b2a3d4e5f60718",
          "type": "monitor", // monitor | static
          "name": "Website", // display name
          "description": "Marketing site", // only when set
          "url": "https://example.com", // url only when sendUrl/customUrl
          "status": "up", // up | down | pending | maintenance | unknown
          "impact": null, // worst active incident impact, or null
          "showValues": true,
          "uptime24h": 0.9993, // only when showValues
          "uptime30d": 0.9981, // only when showValues
          "beats": [{ "status": "up", "time": "2026-10-05T03:00:00.000Z", "ping": 42 }], // oldest first, ≤ 50; ping only when showValues
          "tags": [{ "name": "env", "color": "#2563EB", "value": "prod" }], // only when showTags
        },
        {
          "id": "6702f1c4e1b2a3d4e5f60719",
          "componentId": "6702f1c4e1b2a3d4e5f60719",
          "type": "static",
          "name": "Customer support",
          "status": "pending",
          "impact": "partial_outage",
          "showValues": true,
          "beats": [], // always empty for static components
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
six tabs: **Settings** (title, slug, description, language once Marmot ships more than one, refresh,
custom CSS, analytics id, header links, display toggles, delete), **Theme** (colour mode, preset, colour
overrides, banner headline, logos and favicon, with a live preview; see [Themes](#themes)), **Groups &
monitors** (drag-and-drop groups and components with
`dnd-kit`, static components, per-component public name, description, values toggle, "show URL" / custom
link, per-group "expanded by default"), **Incidents** (post, edit, pin, resolve, reopen, delete, affected
components and their impact),
**Domains** and **Access** (public, password, email domain or IP allow-list, with the list of signed-in
visitors for email-domain pages; see below). The header switch publishes/unpublishes.

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
| `GET …/:id/viewers`                                      | Visitors of an email-domain page             |
| `PATCH`/`DELETE …/:id/viewers/:viewerId`                 | Revoke or restore (`{ status }`) / forget    |

## Access

A page's **Access** tab switches it between **Public** (default), **Password**, **Email domain** and
**IP allow-list**. Protection applies to published pages; signed-in members still preview their pages
from the builder. Whatever the mode, every public surface checks access through
`checkStatusPageAccess` (`src/server/status-pages/access.ts`), which dispatches to one strategy per mode
and denies modes it does not know: the HTML page, `/api/status-pages/:slug/public`, `/rss`,
`manifest.json` (linked with `crossorigin="use-credentials"`), badges of monitors that only appear on
protected pages, and all of these on custom domains. Responses of protected pages carry
`Cache-Control: private, no-store` and `X-Robots-Tag: noindex`; protected pages are always `noindex`,
whatever `searchEngineIndex` says, and without access their metadata reveals only the title. Exports
never contain access settings: a protected page is exported as a draft, so importing it does not publish
it unprotected.

The session modes (password, email domain) set an HttpOnly, `SameSite=Lax` cookie named
`marmot_sp_<page id>` holding a signed token for that page; it lasts `STATUS_PAGE_SESSION_DAYS` (default 30) days. The token embeds a keyed fingerprint of the access mode (and of the password hash), so
**switching modes or changing the password signs every visitor out**. The cookie path is `/` because the
page, its API, feed and badges live under different paths; the name and the signed page id keep it to
one page.

### Password protection

- The password (8–256 characters) is written through the write-only `password` field and stored as an
  scrypt hash in `passwordHash`, which field access hides from every API; only server code reading with
  `overrideAccess` sees it. Switching back to **Public** deletes the hash.
- Visitors without access are redirected from the page to `/status/<slug>/login` (`/login` on a custom
  domain). The form posts to `POST /api/status-pages/:slug/access` (form fields or JSON
  `{ "password": "…" }`). A correct password sets the access cookie.
- Feed readers and scripts can pass the password as `?pw=<password>` to the JSON endpoint, the RSS feed,
  `manifest.json` and badge URLs. **This puts the password in URLs, browser history, proxy and server
  logs**; prefer the cookie (JSON login) where the client can keep one.
- The HTML page only honours the cookie. Without access the machine endpoints answer `401` with
  `{ "error", "code": "login-required" | "invalid-password" }`.
- Password checks (form, JSON and `?pw=`) are rate limited: 10 attempts per minute per page and client
  IP, then a 5-minute block. The client IP is only known behind a trusted proxy (instance setting
  `trustProxy`); without one, all visitors of a page share a bucket of 30 attempts per minute. Blocked
  clients get `429` with `Retry-After` (the form shows a message) and cannot try the right password
  either. Already signed-in visitors are unaffected.

### Email domain

For internal pages: "anyone with an `@acme.com` address". List the domains on the Access tab (exact
match: `acme.com` does not admit `eng.acme.com`; list each subdomain). Sign-in uses one-time links sent
through the instance mailer (`SMTP_*`, see [Configuration](Configuration.md); without SMTP the mail is
only logged).

1. The login screen (`/status/<slug>/login`) asks for an email address and posts it to
   `POST /api/status-pages/:slug/access` (form field or JSON `{ "email": "…" }`). The answer is always
   the same "if this address may view the page, a link is on its way" (`202 { ok, sent }`, or the form
   redirected to `?sent=1`), whether the domain is allowed, unknown or the visitor revoked: the lookup and
   the email happen in the background, so neither the response nor its timing reveals the allowed domains.
2. For an admitted address, Marmot mints a 256-bit random token and stores only its SHA-256 digest, with
   the page and the address, in Redis for **15 minutes** (`src/server/status-pages/magic-link.ts`). The
   email (in the page's language, `email.statusPageMagicLink.*`) links to `…/login?token=…` on the host
   the visitor used, custom domains included, so the cookie lands where the page is served.
3. Opening the link shows a **Continue** button that posts the token back; mail scanners that prefetch
   links cannot use it up. Redeeming is **single use** (the entry is read and deleted atomically), bound to
   the page, and re-checks that the domain is still allowed. It records the visitor in
   `status-page-viewers` and sets the access cookie, which names that row. Invalid, used or expired links
   send the visitor back to the form (`?error=link-invalid`, JSON `400 link-invalid`).
4. Every request re-checks the session: the viewer row must exist and be `active`, and its domain must
   still be listed. **Revoking** a visitor on the Access tab signs them out at once and refuses new
   links to that address; **removing** them only forgets them (they may sign in again while their domain
   is allowed). Removing a domain signs out its visitors.

Link requests are rate limited before anything else happens, with the same limits for allowed and
unknown addresses: 3 per page and address per 15 minutes, and 10 per client IP per 15 minutes (behind a
trusted proxy; without one, 30 per page per 15 minutes shared by all visitors). Limited requests get
`429` with `Retry-After` (the form shows a message). The feeds, JSON and badges of an email-domain page
only accept the cookie; there is no `?pw=` equivalent.

### IP allow-list

For pages that should only be reachable from the office or the VPN. List IPv4 and IPv6 addresses or CIDR
ranges (`203.0.113.0/24`, `2001:db8::/32`, optionally followed by a label); they are validated and
stored canonically. IPv4 clients seen as IPv4-mapped IPv6 (`::ffff:203.0.113.7`) match IPv4 ranges;
other embeddings (NAT64, 6to4) are not unwrapped. Every request is checked; there is no session and
nothing to sign in to. Requests from other addresses get a static "restricted" screen on the HTML page
and `403 { "code": "ip-not-allowed" }` from the JSON endpoint, the feed and the manifest (badges answer
404, as for any monitor the visitor may not see). Responses are never cached publicly, because the
answer depends on the client address.

**Reverse-proxy requirements.** Next.js route handlers never see the TCP peer, so the client address
comes from `X-Forwarded-For` (first entry) or `X-Real-IP`, and only when the instance setting **Trust
proxy headers** (`trustProxy`) is on ([Security](Security.md#client-addresses-and-trustproxy)). Turn it on
only behind a proxy that **overwrites** those headers (the bundled Caddy does; nginx needs
`proxy_set_header X-Forwarded-For $remote_addr;` rather than `$proxy_add_x_forwarded_for` when it is the
first hop). With `trustProxy` off, nobody is admitted (the Access tab warns), because a client could
otherwise claim any address. If a CDN or load balancer sits in front of the proxy, make sure the
address that reaches Marmot is the visitor's, not the CDN's.

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

- `tests/int/status-page-components.int.spec.ts` — static components driven by incident impact and
  maintenance, public names, collapsible group status, `showValues` stripping the JSON, validation and the
  component helpers.
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
- `tests/int/status-page-access.int.spec.ts` — password protection: hashing and field access, 401 on the
  JSON endpoint, RSS, manifest and badges without access, login (JSON and form, cross-site refusal),
  `?pw=`, cookies per page, custom domains, password change ending sessions, rate limiting, export.
  `src/server/status-pages/access.test.ts` and `src/server/security/password-hash.test.ts` cover the
  token and hash primitives.
- `tests/e2e/status-pages.e2e.spec.ts` also protects a page, checks the login redirect and form, and
  that the page and its feed open after signing in.
