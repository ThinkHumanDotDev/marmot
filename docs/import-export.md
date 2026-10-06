# Import / Export

Settings → **Import / Export** (`/<org>/settings/import-export`) moves monitors, notification channels
and status pages between organizations and instances, and migrates an existing Uptime Kuma installation.
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
`notification:create` (admin) and status pages with `status-page:create`; parts you may not create are
skipped and reported, and monitors are then imported without the corresponding channel links.

### Conflicts

- A notification channel whose **name** already exists in the organization is not created; imported monitors
  are linked to the existing channel instead (Uptime Kuma's own importer behaved the same way).
- Monitors are always created, even when a monitor with the same name exists.
- Status page slugs and custom domains are unique across the whole instance. A taken slug gets a `-2`, `-3`, …
  suffix (reported as a note); a taken custom domain is dropped from the imported page.
- Monitors created without any channel receive the organization's default channels, like any new monitor.

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

## What an Uptime Kuma backup maps to

The mapping is ported from Uptime Kuma 1.23's `uploadBackup` handler and `Monitor.toJSON()` (see
`THIRD_PARTY_NOTICES.md`). Uptime Kuma 2.x removed the backup page, but a dump of its `monitorList` /
`notificationList` socket payloads has the same shape and imports too.

**Monitors** — types `http`, `keyword`, `json-query`, `port`, `ping`, `dns`, `push`, `group` and `manual`
map one to one. Name, description, URL/hostname/port, interval, retry interval, retries (`maxretries`),
resend interval, timeout, upside-down mode, HTTP method, body and encoding, headers, accepted status codes,
redirects, TLS options, certificate-expiry notification, keyword (+ invert), JSON query (path, operator,
expected value), authentication (basic, NTLM, bearer, OAuth2 client credentials, mTLS), DNS resolver and
record type, weight, paused state (`active`) and the push token are kept. Group membership (`parent`) is
rebuilt from the backup's ids, and `notificationIDList` becomes the monitor's channel links.

Intervals below Marmot's 20-second minimum are raised to 20 s (noted in the report). Invalid monitors (for
example an HTTP monitor without a URL) are skipped with the validation message.

The extended types (`grpc-keyword`, `websocket-upgrade`, `mqtt`, `kafka-producer`, `rabbitmq`, `smtp`,
`snmp`, `radius`, `tailscale-ping`, `mysql`, `postgres`, `sqlserver`, `mongodb`, `redis`, `steam`,
`gamedig`) keep their type-specific columns, which carry the same names in Kuma and Marmot (see
[monitor-types.md](monitor-types.md)); the SNMP community string comes from Kuma's `radiusPassword`
column, where Kuma's form stores it.

Not imported: Docker monitors (Marmot's `docker` type needs a Docker host, which the backup does not map
to), browser-engine monitors (they reference a
remote browser that the backup does not contain), proxies, remote browsers, maintenance windows,
heartbeat history and statistics, and **tags** — the tags collection does not exist yet (#21); tag names and
assignments are listed in the report as skipped.

**Notification channels** — the Kuma provider names below map to Marmot providers; their config keys are
translated one by one (`src/server/import-export/kuma-notifications.ts`) and validated against the Marmot
provider's schema. Channels of unsupported providers, or with settings the schema rejects, are skipped with
the reason.

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
        { "name": "Core", "monitors": [{ "monitor": 12, "sendUrl": false, "customUrl": null }] }
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
      "...": "theme, description, footerText, customCSS, autoRefreshInterval, show* flags, googleAnalyticsId"
    }
  ]
}
```

Ids are the exporting instance's document ids and only serve to link documents inside the file; the
importer remaps them. Heartbeats, statistics, maintenance windows, members and organization settings are not part of the export.
Logos (media uploads) are not exported. Tags, proxies and Docker hosts are not exported either: a monitor's
`tags`, `proxy` and `dockerHost` fields hold ids of the exporting organization, so the importer drops tag and
proxy assignments (noted in the report) and skips `docker` monitors with a reason.

> **The export contains secrets.** Notification configs are exported as stored — webhook URLs, bot tokens,
> SMTP passwords — and monitors carry their basic-auth, bearer, OAuth and mTLS credentials. The download is
> therefore limited to `organization:update` (admins and owners). Store the file like a password file and
> delete it after importing.

Each monitor in the file is validated with the shared monitor schema (`src/lib/validation/monitor.ts`) and
each channel with its provider schema, so a hand-edited export fails per item, not as a whole.
