# Import / Export

Settings → **Import / Export** (`/<org>/settings/import-export`) moves monitors, notification channels,
status pages and incident templates between organizations and instances, and migrates an existing Uptime Kuma installation.
Code lives in `src/server/import-export/`; the UI in `src/components/import-export/`.

## Importing

Pick a JSON file (10 MB max). Marmot recognises two formats:

| Format             | How to recognise it                                              | Produced by                                      |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------ |
| Uptime Kuma backup | `{ "version", "monitorList": [...], "notificationList": [...] }` | Uptime Kuma 1.x → Settings → Backup → Export     |
| Marmot export      | `{ "format": "marmot", "version": 1, ... }`                      | Settings → Import / Export → **Download export** |

Every import is a **dry run first**: the file is parsed and checked against the organization, and a report
lists what will be created and what will be skipped (with a reason per item). Nothing is written until you
press **Import**. The committed import runs in one database transaction, so a failure leaves the
organization untouched (on database adapters without transactions the documents created so far remain).

Permissions: importing needs `monitor:create` (member). Notification channels are only imported with
`notification:create` (admin), status pages with `status-page:create` and templates with
`template:create`; parts you may not create are
skipped and reported, and monitors are then imported without the corresponding channel links.

### Conflicts

- A notification channel whose **name** already exists in the organization is not created; imported monitors
  are linked to the existing channel instead (Uptime Kuma's own importer behaved the same way).
- Monitors are always created, even when a monitor with the same name exists.
- Status page slugs and custom domains are unique across the whole instance. A taken slug gets a `-2`, `-3`, …
  suffix (reported as a note); a taken custom domain is dropped from the imported page.
- Monitors created without any channel receive the organization's default channels, like any new monitor.
- A template whose **name** already exists in the organization is skipped. Templates bound to a status page
  that is not imported lose the page and their default components (reported as a note).

### API

| Method | Path                                             | Permission                     |
| ------ | ------------------------------------------------ | ------------------------------ |
| POST   | `/api/orgs/:orgId/import?dryRun=1`               | `monitor:create` (+ see above) |
| POST   | `/api/orgs/:orgId/import`                        | `monitor:create` (+ see above) |
| POST   | `/api/orgs/:orgId/import/uptime-kuma[?dryRun=1]` | same; Uptime Kuma format only  |
| GET    | `/api/orgs/:orgId/export`                        | `organization:update`          |

The body of an import request is the file's JSON. `/import` auto-detects the format. The response is the
report:

```json
{
  "format": "uptime-kuma",
  "dryRun": true,
  "monitors": {
    "create": 8,
    "skipped": [
      {
        "name": "Docker",
        "reason": "Monitor type \"Docker Container\" is not supported by Marmot yet"
      }
    ]
  },
  "notifications": { "create": 2, "skipped": [] },
  "statusPages": { "create": 0, "skipped": [] },
  "tags": {
    "create": 0,
    "skipped": [
      { "name": "prod", "reason": "Tags are not supported yet (3 monitor assignments skipped)" }
    ]
  },
  "warnings": ["\"Gateway ping\": interval raised from 15s to the minimum of 20s"]
}
```

A committed import (HTTP 201) adds `created: [ids]` to each section. A file that is not one of the two
formats answers 400; a file over 10 MB answers 413.

## Importing from a hosted service

**Import from a service** (same settings tab) moves an account from **Atlassian Statuspage** or
**Better Stack** through the service's API. Pick the service, paste an API key, choose what to
import, then **Connect and preview**: Marmot reads the account and shows the same report as a file
import (counts per part, every skipped item with its reason, notes). **Import** reads the account
again and writes it in one transaction, in the order monitors → status page and components →
incidents → maintenance → subscribers. A failed import rolls back (on adapters with transactions,
as above).

**Credentials are never stored.** The key is held in the browser tab until the import finishes or is
cancelled, sent with the preview and again with the import, used for that request's API calls only
(as an `Authorization` header to the service's fixed API host; pagination links to other hosts are
refused) and never written to the database, the audit log or the server logs. Prefer a read-only key
and revoke it afterwards.

| Source               | Credentials                                 | Monitors | Status page and components | Incidents (with updates and impacts) | Upcoming maintenance | Subscribers |
| -------------------- | ------------------------------------------- | :------: | :------------------------: | :----------------------------------: | :------------------: | :---------: |
| Atlassian Statuspage | API key, page ID                            |    —     |             ✓              |                  ✓                   |          ✓           |      ✓      |
| Better Stack         | Uptime API token, status page ID (optional) |    ✓     |             ✓              |                  ✓                   |          ✓           |      —      |

Instatus and Checkly are planned (#283).

Common rules:

- Imported status pages are **unpublished** (noted in the report) so you can review them first. The
  slug comes from the source's subdomain and the custom domain is kept, with the conflict rules above.
- Incidents keep their title, creation time and the whole update timeline (status, message, posting
  time, component impacts). Impacts use Statuspage's vocabulary, which Marmot shares (`operational`,
  `degraded_performance`, `partial_outage`, `major_outage`). Imported history is **not announced**:
  no subscriber notifications or webhooks are sent for imported incidents and maintenance windows.
- Maintenance windows become one-off windows (`single`, times in UTC) linked to the imported page
  (and, for Better Stack, to the affected monitors). Finished windows are skipped with a reason.
- Subscribers are created confirmed with `source: import`; nobody receives an opt-in message.
  Invalid, duplicate and quarantined addresses and unsupported channels are skipped with a reason
  (addresses appear masked in the report).
- Incidents and subscribers belong to the imported page: without **Status page and components** they
  are skipped.
- Permissions: the route needs `monitor:create`; monitors, status pages, incidents
  (`status-page:update`), maintenance (`maintenance:create`) and subscribers (`subscriber:manage`)
  the caller may not create are skipped and reported. Plan limits apply as for file imports, and
  demo mode refuses provider imports.

**Atlassian Statuspage** (Manage API v1, `https://api.statuspage.io/v1`): the page (name, subdomain,
description, website and support URLs, custom domain, headline as banner), its components (groups
become component groups, ungrouped components a group named "Services"; components are static
components because Statuspage has no monitors), incidents with `incident_updates` (`postmortem`
counts as resolved; `affected_components` become impacts), scheduled maintenances that have not
ended, and active email, SMS (numbers with a country code) and webhook subscribers with their
component choices. Slack and Teams subscriptions are skipped.

**Better Stack** (Uptime API v2, `https://uptime.betterstack.com/api/v2`): monitors of type
`status` and `expected_status_code` (→ HTTP, with the expected codes), `keyword` and
`keyword_absence` (→ keyword, inverted), `ping` and `tcp` (→ ping, port) with URL, check frequency
(raised to 20 s at least), timeout, method, headers, body, redirects, TLS verification, SSL and
domain expiry, and the paused state; other types (UDP, SMTP, POP3, IMAP, DNS, Playwright) are skipped
with a reason. Status pages (all, or the one whose ID you give) with company name and URLs, theme,
custom CSS and domain, Google Analytics ID and announcement; sections become groups and resources
become components, linked to the imported monitor (response-time widgets show the chart) or static
otherwise. Status reports become incidents (Better Stack updates carry no status, so they are
`investigating` until the report has ended, when the last update resolves it); `maintenance` reports
become maintenance windows. Heartbeats, monitor groups, escalation policies and on-call settings are
not imported.

The importers are built from the services' documented API formats and tested with hand-written
fixtures of those responses (`tests/fixtures/providers`).

| Method | Path                                                     | Permission                     |
| ------ | -------------------------------------------------------- | ------------------------------ |
| POST   | `/api/orgs/:orgId/import/providers/:provider[?dryRun=1]` | `monitor:create` (+ see above) |

`:provider` is `statuspage` or `betterstack`; the body is
`{ "credentials": { "apiKey": "…", "pageId": "…" }, "resources": ["components", "incidents", "maintenance", "subscribers"] }`
(Better Stack: `apiToken`, optional `statusPageId`; resources also `monitors`). The answer is the
import report with the extra sections `incidents`, `maintenance` and `subscribers`. A rejected key or
unknown page answers 400, an unreachable or misbehaving API 502.

## What an Uptime Kuma backup maps to

The mapping is ported from Uptime Kuma 1.23's `uploadBackup` handler and `Monitor.toJSON()` (see
`THIRD_PARTY_NOTICES.md`). Uptime Kuma 2.x removed the backup page, but a dump of its `monitorList` /
`notificationList` socket payloads has the same shape and imports too.

**Monitors** — types `http`, `keyword`, `json-query`, `port`, `ping`, `dns`, `push`, `group` and `manual`
map one to one. Name, description, URL/hostname/port, interval, retry interval, retries (`maxretries`),
resend interval, timeout, upside-down mode, HTTP method, body and encoding, headers, accepted status codes,
redirects, TLS options, certificate-expiry notification, keyword (+ invert), JSON query (path, operator,
expected value), authentication (basic, NTLM, bearer, OAuth2 client credentials, mTLS), DNS resolver and
record type, weight, paused state (`active`) and the push token are kept (push monitors use the
interval schedule with the automatic grace period, as in Kuma). Group membership (`parent`) is
rebuilt from the backup's ids, and `notificationIDList` becomes the monitor's channel links.

Intervals below Marmot's 20-second minimum are raised to 20 s (noted in the report). Invalid monitors (for
example an HTTP monitor without a URL) are skipped with the validation message.

The extended types (`grpc-keyword`, `websocket-upgrade`, `mqtt`, `kafka-producer`, `rabbitmq`, `smtp`,
`snmp`, `radius`, `tailscale-ping`, `mysql`, `postgres`, `sqlserver`, `mongodb`, `redis`, `steam`,
`gamedig`) keep their type-specific columns, which carry the same names in Kuma and Marmot (see
[Monitor types](Monitor-Types.md)); the SNMP community string comes from Kuma's `radiusPassword`
column, where Kuma's form stores it. Kuma's Globalping monitors become `globalping` monitors with one
probe (`subtype`, `location`, `ping_count`, `protocol` and `ipFamily` map to the measurement, locations,
packets, protocol and IP version) and an interval of at least 60 s.

Not imported: Docker monitors (Marmot's `docker` type needs a Docker host, which the backup does not map
to), browser-engine monitors (they reference a
remote browser that the backup does not contain), proxies, remote browsers, maintenance windows,
heartbeat history and statistics, and **tags** — the tags collection does not exist yet (#21); tag names and
assignments are listed in the report as skipped.

**Notification channels** — the Kuma provider names below map to Marmot providers; their config keys are
translated one by one (`src/server/import-export/kuma-notifications.ts`) and validated against the Marmot
provider's schema. Channels of unsupported providers, or with settings the schema rejects, are skipped with
the reason. Uptime Kuma has no per-channel event filters, so imported channels get Marmot's defaults (down,
recovery, reminders, certificate and domain expiry; see [Notifications](Notifications.md#event-filters)).
Marmot exports carry each channel's `events`; files without them import with the defaults.

`discord`, `slack`, `telegram`, `teams`, `ntfy`, `gotify`, `pushover`, `matrix`, `webhook`, `smtp`,
`mattermost`, `rocket.chat`, `GoogleChat`, `PagerDuty`, `Opsgenie`, `apprise`, `signal`, `HomeAssistant`,
`pushbullet`, `twilio`, `SendGrid`, `Resend`, `Bark`, `PushDeer`, `ServerChan`, `Splunk`, `squadcast`,
`PushByTechulus`, `pushy`, `OneBot`, `WeCom`, `DingDing`, `Feishu`, `Bitrix24`, `line`, `pumble`, `ZohoCliq`,
`clicksendsms`, `alerta`, `GrafanaOncall`, `HeiiOnCall`, `nextcloudtalk`.

`Webpush` is skipped on purpose: Uptime Kuma keeps the VAPID key pair in server settings that the backup does
not contain. The "default enabled" flag is kept; "apply to all existing monitors" is not re-run.

## Marmot export format

`GET /api/orgs/:orgId/export` downloads `marmot-export-<slug>-<date>.json`:

```json
{
  "format": "marmot",
  "version": 1,
  "exportedAt": "2026-10-05T12:00:00.000Z",
  "organization": { "name": "Acme", "slug": "acme" },
  "notifications": [
    {
      "id": 3,
      "name": "Ops Slack",
      "type": "slack",
      "config": { "webhookUrl": "..." },
      "events": ["down", "up", "reminder", "certificate"],
      "isDefault": true,
      "active": true
    }
  ],
  "monitors": [
    {
      "id": 12,
      "name": "Website",
      "type": "http",
      "url": "https://example.com",
      "parent": 11,
      "notifications": [3],
      "pushToken": null,
      "...": "all monitor form fields"
    }
  ],
  "statusPages": [
    {
      "id": 5,
      "title": "Public status",
      "slug": "acme",
      "published": true,
      "domains": ["status.example.com"],
      "groups": [
        {
          "name": "Core",
          "defaultOpen": true,
          "monitors": [
            {
              "id": "6650c0ffee0000000000a001",
              "type": "monitor",
              "monitor": 12,
              "name": null,
              "sendUrl": false,
              "customUrl": null
            },
            {
              "id": "6650c0ffee0000000000a002",
              "type": "static",
              "monitor": null,
              "name": "Customer support",
              "description": null
            }
          ]
        }
      ],
      "incidents": [
        {
          "title": "Degraded API",
          "content": "...",
          "style": "warning",
          "pinned": true,
          "active": true,
          "resolvedAt": null,
          "createdAt": "..."
        }
      ],
      "...": "theme, description, homepageUrl, contactUrl, footerText, customCSS, autoRefreshInterval, show* flags (incl. showValues), googleAnalyticsId"
    }
  ],
  "templates": [
    {
      "name": "Database failover",
      "kind": "incident",
      "title": "Database failover on {{ page }}",
      "body": "We are failing over the primary database. Next update by {{ eta }}.",
      "status": "identified",
      "impact": null,
      "duration": null,
      "statusPage": 5,
      "components": [{ "component": "6650c0ffee0000000000a001", "impact": "major_outage" }]
    }
  ]
}
```

Ids are the exporting instance's document ids and only serve to link documents inside the file; the
importer remaps them. Component rows carry their `id` so templates can reference them; the importer maps
them to the rows it creates (`templates` is optional, files from before templates import unchanged). Status page components keep their type, public name, description,
`showValues` and `showChart`; incident impacts on components (`affectedComponents`) are not exported because component ids
are regenerated on import. Push monitors keep their token and schedule (`pushSchedule`, `pushCron`,
`pushTimezone`, `pushGrace`, `pushMaxDuration`); their ping log and open runs are not exported. A page's subscription settings (`subscriptions`: enabled, channels, review or
automatic sending, SMS templates) travel with it, and its SMS sender when that Twilio channel is in the
same file; the subscribers themselves do not (they are personal data, and their component choices name
component ids): export and import them per page as CSV from the builder's **Subscribers** tab
([Status pages](Status-Pages.md#managing-subscribers)). Heartbeats, statistics, maintenance windows, members and organization settings are not part of the export.
Logos (media uploads) are not exported. Tags, proxies and Docker hosts are not exported either: a monitor's
`tags`, `proxy` and `dockerHost` fields hold ids of the exporting organization, so the importer drops tag and
proxy assignments (noted in the report) and skips `docker` monitors with a reason.

To keep monitor definitions in git instead, export them as a reviewable YAML file with
`marmot monitors import` and apply changes with `marmot monitors apply` ([CLI and monitors as code](CLI.md));
`marmot monitors apply` also accepts a Marmot export file, and `marmot import -f file.json` runs this
importer from the command line. Monitor keys travel with the export; on import a key already used by a
monitor of the organization is dropped (noted in the report).

> **The export contains secrets.** Notification configs are exported as stored — webhook URLs, bot tokens,
> SMTP passwords — and monitors carry their basic-auth, bearer, OAuth and mTLS credentials. The download is
> therefore limited to `organization:update` (admins and owners). Store the file like a password file and
> delete it after importing.

Each monitor in the file is validated with the shared monitor schema (`src/lib/validation/monitor.ts`) and
each channel with its provider schema, so a hand-edited export fails per item, not as a whole.
