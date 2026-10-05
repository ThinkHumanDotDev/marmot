# Telemetry

Marmot ships **no telemetry by default**. A self-hosted install never contacts PostHog, never loads an
analytics SDK and never shows a cookie banner unless the operator opts in by setting
`NEXT_PUBLIC_POSTHOG_KEY`. Even then, nothing leaves a visitor's browser until that visitor allows it.

## Enabling it

```bash
NEXT_PUBLIC_POSTHOG_KEY=phc_...                     # your PostHog project key
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com   # optional, default https://us.i.posthog.com
```

Both are `NEXT_PUBLIC_*` variables: they are inlined at `pnpm build` time, so rebuild the web image after
changing them. The same key switches on the server-side events of the worker and web processes.

## Consent

When analytics are enabled the frontend mounts a cookie banner (built with
[c15t](https://c15t.com) in **offline mode**: the visitor's choice is stored in their own browser, no
consent backend is contacted). Marmot offers a single optional category, `measurement`. Until it is
granted PostHog is opted out: no events, no persistence, no cookies. Declining opts out and wipes the
SDK's local state. Browsers that send `Do Not Track` are treated as declined. The choice can be revisited
at any time from the account menu (**Privacy settings**).

## What is collected

Only when the operator enabled analytics **and** the visitor granted `measurement`:

| Event                          | Where   | Properties                                            |
| ------------------------------ | ------- | ----------------------------------------------------- |
| `$pageview`                    | browser | `$current_url` / `$pathname` reduced to route pattern |
| `monitor_created`              | browser | `type` (monitor type, e.g. `http`)                    |
| `status_page_published`        | browser | —                                                     |
| `notification_channel_created` | browser | `provider` (e.g. `slack`)                             |

Independent of consent (they are not tied to a person) but still only with a key:

| Event              | Where                              | Properties                                   |
| ------------------ | ---------------------------------- | -------------------------------------------- |
| `instance_started` | worker boot                        | `version`, `adapter`, `role`, `node` version |
| `org_created`      | `organizations` `afterChange` hook | `orgId` (keyed hash, see below)              |

Every browser event also carries PostHog's standard client context (SDK version, browser and OS family,
screen size, timezone, session id). The following are rewritten or dropped before the request is built
(`before_send` in `src/instrumentation-client.ts`):

- `$current_url`, `$pathname` and their `$initial_*` person properties become **route patterns**:
  `/acme/monitors/12/edit` → `/[org]/monitors/[id]/edit`, `/invite/<token>` → `/invite/[code]`,
  `/status/<slug>` → `/status/[slug]`. Organization slugs, document ids, invitation codes, query strings and
  hashes never leave the browser.
- `$referrer`, `$referring_domain`, `$host` and their `$initial_*` variants are removed.

**Identity.** Signed-in users are identified by a keyed SHA-256 (HMAC) of their user id. The key is derived
from `PAYLOAD_SECRET`, so the hash is stable within an installation, cannot be reversed to the id and differs
between installations. The hash is computed on the server (`hashAnalyticsId` in `src/server/analytics.ts`)
and handed to the browser; the only trait attached is the `plan` of the organization being viewed. Email,
name, organization names, monitor names, URLs, hostnames and notification secrets are **never** sent. Server
events are attributed to an `instance_<hash>` distinct id with `$process_person_profile: false`, so PostHog
creates no person for the installation.

**Not collected.** Autocapture, session recordings, heatmaps, surveys, dead clicks, web vitals, exception
capture and feature-flag evaluation are all disabled in the SDK configuration. No script is fetched from
PostHog's CDN.

**IP addresses.** PostHog derives an IP address from the HTTP request it receives. Marmot does not send a
client IP property, but the request itself originates from your server (see the proxy below), so PostHog sees
the server's address for browser events too. Disable "Discard client IP data" in your PostHog project
settings only if you understand the consequences.

## The proxy path

The browser SDK never talks to a PostHog host directly. It posts to the same-origin path `/ph`, which
`next.config.ts` rewrites to `NEXT_PUBLIC_POSTHOG_HOST` (`/ph/static/*` and `/ph/array/*` go to the matching
`*-assets` host). This keeps the status monitor a single origin for CSP and firewalls, and lets you see or
block the traffic at your reverse proxy. With no key configured nothing ever requests `/ph`, which the
Playwright spec `tests/e2e/telemetry.e2e.spec.ts` asserts across login and the dashboard.

## Disabling it

Unset `NEXT_PUBLIC_POSTHOG_KEY` and rebuild. Visitors can also decline or withdraw consent in the browser
(**Privacy settings** in the account menu), and the `Do Not Track` browser setting is honoured.

## Code map

| File                                                | Role                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/instrumentation-client.ts`                     | Initialises `posthog-js` (opted out, proxied, everything automatic disabled)  |
| `src/lib/analytics-config.ts`                       | Pure helpers: enabled flag, route patterns, `before_send` sanitizer           |
| `src/lib/analytics.ts`                              | Client facade: `track`, `trackPageview`, `identify`, `setAnalyticsConsent`    |
| `src/components/consent/*`                          | c15t provider, banner, dialog, Marmot theme tokens, consent → PostHog bridge  |
| `src/server/analytics.ts`                           | `posthog-node` helper: `captureServerEvent`, `hashAnalyticsId`, flush on exit |
| `src/worker.ts`, `src/collections/Organizations.ts` | `instance_started`, `org_created`                                             |
