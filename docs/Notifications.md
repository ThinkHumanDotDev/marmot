# Notifications

## Concepts

A **notification channel** is one destination for alerts: a Slack webhook, a Telegram chat, an email
address, a PagerDuty integration, a plain webhook. Channels belong to an organization and are managed on
`/{org}/notifications`; each monitor carries the list of channels that should hear about it, chosen in the
monitor form (default channels start selected on new monitors) or from the channel's **Monitors** dialog.
When a monitor changes state (UP → DOWN, DOWN → UP, PENDING → DOWN) the worker sends one message per
attached channel; with a `resendInterval` on the monitor it repeats the DOWN message every N beats while
the outage lasts. Nothing is sent for PENDING (retrying) beats or for beats inside a maintenance window.
Each channel chooses which **events** it hears about (down, recovery, degraded performance, reminders,
certificate and domain expiry, maintenance windows), so you can page PagerDuty only on DOWN and send
recoveries and slow responses to Slack.

Setting up a channel is a form: pick a **provider**, fill in the fields the provider needs (the form is
generated from the provider's schema, so required fields and secrets are marked), pick the events, press
**Send test** (one sample per selected event), save.
Tick **Default** to preselect the channel on every new monitor and **Apply to all existing monitors** to
attach it to the monitors you already have. Marmot ships 48 providers ported from Uptime Kuma (table below),
grouped as Chat, Push, Email and Generic (webhooks, incident management, SMS).

## How it works

Marmot alerts through **notification channels**: org-scoped documents in the `notifications` collection that
name a provider (`type`) and carry its settings (`config`). Monitors reference channels through their
`notifications` relationship; a channel flagged `isDefault` is attached to every monitor created afterwards
(unless the monitor form or API call lists its channels explicitly), and "Apply to all existing monitors"
attaches it to the organization's current monitors. The **Monitors** entry of a channel's menu attaches the
channel to, or detaches it from, any monitor of the organization
(`GET`/`PUT /api/orgs/:orgId/notifications/:id/monitors`, `{ "monitors": [id, …] }`). Members can see
channels (`notification:read`, secrets masked); admins and owners create, edit, test and delete them
(`notification:create|update|delete`).

## Pipeline

```
check worker ─▶ heartbeat (notify=true, notificationEvent) ─▶ enqueueNotificationsForHeartbeat()
   ─▶ channelAcceptsEvent(channel, event) keeps the active attached channels that selected the event
   ─▶ BullMQ queue `marmot:notifications`, one job per remaining channel
      job id `notif:<notificationId>:<heartbeatId>` (dedupes repeated events), 3 attempts, exponential backoff 5s
   ─▶ startNotificationWorker() ─▶ processNotificationJob() ─▶ sendNotification() ─▶ provider.send()
   ─▶ `notifications.lastSentAt` / `lastError` updated on the channel
```

The state machine decides when a beat notifies (`notify`): status transitions
(`isImportantForNotification`) plus the `resendInterval` tick while DOWN. The first beat only notifies when
it is DOWN. Everything runs in the worker process (`src/worker.ts`).

Each notifying beat carries a **notification event** (`notificationEvent` on the heartbeat event and the
job data; `notificationEventFor()` in `src/server/engine/beat.ts`):

| Event      | When                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `down`     | the monitor went DOWN (from UP, DEGRADED, PENDING or MAINTENANCE, or on its first beat) |
| `up`       | it recovered from DOWN, to UP or to DEGRADED                                            |
| `degraded` | it became DEGRADED (from UP, after retries or after maintenance) or went back to UP     |
| `reminder` | the `resendInterval` repeat while still DOWN                                            |

### Event filters

Every channel has an `events` selection (`src/lib/notification-events.ts`); a channel is only told about
the events it selected:

| Event          | Sent when                                                                             | Default |
| -------------- | ------------------------------------------------------------------------------------- | :-----: |
| `down`         | a monitor went DOWN                                                                   |   on    |
| `up`           | it recovered from DOWN (the message carries the downtime)                             |   on    |
| `degraded`     | it became DEGRADED or went back from DEGRADED to UP                                   |   off   |
| `reminder`     | the `resendInterval` repeat while still DOWN                                          |   on    |
| `certificate`  | a TLS certificate or domain expiry warning (monitors with the expiry options on)      |   on    |
| `maintenance`  | a maintenance window covering the monitor starts or ends (once per channel and event) |   off   |
| `acknowledged` | a member acknowledged the monitor's [incident](Monitors.md#incidents)                 |   on    |
| `resolved`     | a member resolved the monitor's incident by hand (automatic resolution is `up`)       |   on    |

The defaults are what every channel received before the filters existed plus the incident events, and a
channel without a selection (one created before the field existed, or saved with an empty list) gets the defaults, so
existing channels behave as before after the upgrade without a data migration. The names are stable
identifiers (stored on channels, exported, sent to templates as `{{ event }}`); new events are added,
never renamed.

`channelAcceptsEvent()` in `src/server/notifications/dispatch.ts` is the single filter point: the
dispatcher applies it before enqueuing, the worker again before sending (a job queued before the channel
dropped the event is skipped as `event-filtered`), the expiry warnings and maintenance messages before
sending, and the Test button sends one sample per selected event. Location-specific rules for
multi-location monitoring (#92) belong in the same function.

**Recovery messages** (`up`) end with the downtime: `[API] [✅ Up] 200 - OK (down for 7 minutes 3 seconds)`.
It is measured from the important DOWN beat right before the recovery; when that beat is gone (retention)
the suffix is left out rather than guessed. Discord's "Downtime Duration" field uses the same value.

**Maintenance messages** come from the maintenance events (`src/server/maintenance/events.ts`): when an
occurrence starts or completes, every active channel that selected `maintenance` and is attached to one of
the window's monitors (children of listed groups included) gets one `notify-maintenance` job (job id
`notif-maint:<channel>:<occurrence>:<started|completed>`) and one message,
`[Marmot] [🔧 Maintenance] Maintenance "DB upgrade" started for API and Web.` Announcements, reminders,
notes and cancellations stay with status page subscribers.

Before enqueuing, the listener asks the **notification gates** (`registerNotificationGate` in
`src/server/notifications/gates.ts`); any gate answering `false` holds the beat back, and a gate that throws
is ignored. Monitor incidents register one that runs the **reminder policy**
(`src/server/incidents/reminders.ts`, replaceable with `setReminderPolicy`) on `resendInterval` reminders. The
default, `backoffReminderPolicy`, stops reminders while the monitor's incident is acknowledged and applies the
monitor's reminder backoff: `reminderBackoff` (`none`, `linear` or `exponential`) spaces them and `maxReminders`
caps them ([Monitors](Monitors.md#recovery-threshold-and-reminder-backoff)). Reminders that go out are counted
on the incident (`remindersSent`, `lastReminderAt`), which is what the backoff reads; it measures time on the
beats' own clock.

### Incident notifications

Acknowledging or resolving a [monitor incident](Monitors.md#incidents) by hand notifies the monitor's active
channels that selected the event, through the same queue: job `incident-notify` with id
`inc-<channel>-<incident>-<event>`, event `acknowledged` or `resolved` (filtered by
`channelAcceptsEvent()` like everything else). The message keeps the usual shape:
`[name] [👀 Acknowledged] Acknowledged by Ada. Note: …` or `[name] [✅ Resolved] Resolved by Ada after 12
minutes.`, sent with the monitor and no heartbeat (like a test message, so rich providers send the text).
An automatic resolution sends nothing extra: the UP notification already announces the recovery.

While the incident is still open, DOWN messages (first alert and reminders) end with
`Acknowledge: <server>/ack/<token>`, a signed link to acknowledge from the phone. Providers that build their
own layout from the heartbeat (Discord embeds, Slack blocks, …) show it only with a custom template that
includes `{{ msg }}`.

The default message is `[monitor name] [✅ Up|🔴 Down|⚠️ Pending|🔧 Maintenance|🐢 Degraded] <heartbeat message>`.
The status labels, the test message and the certificate/domain expiry warnings are written in the
organization's language (`organizations.settings.language`, English by default); the bracketed layout
and the `{{ status }}` template variable follow it, and so do provider-specific titles and field names
(Discord embeds, Slack blocks, Teams cards and the like). Product names, payload keys and identifiers
(`source`, `alias`, dedup keys) stay as they are. The channel form shows provider and field labels in
the user's language.

### Testing a channel

`POST /api/orgs/:orgId/notifications/test` with `{ "notificationId": … }` (saved channel),
`{ "notificationId": …, "config": { … } }` (unsaved edits of a saved channel) or
`{ "type": "slack", "config": { … } }` (unsaved) sends one sample per selected event
(`[Marmot] [⚠️ Test] Down: "Ops" is configured correctly.`, in event order, stopping at the first failure)
and answers `{ ok: true, result, events }` or `400 { ok: false, error }`. `events` in the body tests an
unsaved selection; otherwise the saved channel's (or the defaults) apply. Requires `notification:update`.
The UI's **Send test** button uses it; each sample counts against the server SMTP budget. Unsaved
settings follow the same rules as saving them (`403` when the caller may not use the server SMTP settings);
`429` means the organization used up its hourly budget for the server SMTP settings.

### Channel API

| Method | Path                                       | Permission            |
| ------ | ------------------------------------------ | --------------------- |
| GET    | `/api/orgs/:orgId/notifications`           | `notification:read`   |
| POST   | `/api/orgs/:orgId/notifications`           | `notification:create` |
| PATCH  | `/api/orgs/:orgId/notifications/:id`       | `notification:update` |
| DELETE | `/api/orgs/:orgId/notifications/:id`       | `notification:delete` |
| POST   | `/api/orgs/:orgId/notifications/test`      | `notification:update` |
| POST   | `/api/orgs/:orgId/notifications/preview`   | `notification:read`   |
| GET    | `/api/orgs/:orgId/notifications/providers` | `notification:read`   |

Body fields for POST/PATCH: `name`, `type`, `config`, `events` (array of event names; unknown names are
dropped, an empty list means the defaults), `isDefault`, `applyExisting` (virtual, one-shot), `active`. `config` is validated against the provider's schema and its [templates](#templates) are checked; errors come back as `config.<key>: message`.

## Templates

Fields marked _template_ below are [Liquid](https://shopify.github.io/liquid/) templates, rendered with
[LiquidJS](https://liquidjs.com/) in a sandbox (`src/server/notifications/liquid.ts`). Plain
`{{ variable }}` templates render exactly as before Liquid: unknown variables are empty and objects print
as JSON. Templates written for Uptime Kuma 2.x (which also uses Liquid) work after an import:
`monitorJSON` and `heartbeatJSON` are aliases of `monitor` and `heartbeat`.

```liquid
{% if event == "down" %}🔴 {{ name }} is down: {{ heartbeat.msg }}
{% elsif event == "up" %}🟢 {{ name }} is back after {{ downtime }}
{% else %}{{ msg }}{% endif %}
Checked {{ heartbeat.time | date: "%H:%M", "Europe/Berlin" }} · {{ monitor.dashboardUrl }}
```

### Variables

Every value is a string (`''` when unknown). The list lives in `src/lib/notification-template-variables.ts`
and is type-checked against the render context; saving a channel rejects templates that use a variable not
in it (`Unknown template variable "monitor.nmae"`).

| Variable                                                          | Example                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `{{ msg }}`                                                       | `[API] [🔴 Down] HTTP 503` (default message)                       |
| `{{ status }}`                                                    | `🔴 Down`                                                          |
| `{{ event }}`                                                     | `down`, `up`, `degraded`, `reminder`, `certificate`, `maintenance` |
| `{{ downtime }}` / `{{ downtimeSeconds }}` (recoveries)           | `7 minutes 3 seconds` / `423`                                      |
| `{{ name }}`                                                      | `API`                                                              |
| `{{ hostnameOrURL }}`                                             | `https://api.example.com/health`                                   |
| `{{ monitor.id/name/type/url/hostname/port/description }}`        |                                                                    |
| `{{ monitor.dashboardUrl }}`                                      | `https://marmot.example.com/acme/monitors/7`                       |
| `{{ heartbeat.status/msg/ping/time/duration/retries/downCount }}` | `heartbeat.status` → `down`                                        |
| `{{ heartbeat.localDateTime }}` / `{{ heartbeat.timezone }}`      | `2026-03-10 11:30:00` / `Europe/Berlin`                            |
| `{{ organization.name/slug/logoUrl }}`                            | `Acme`                                                             |
| `{{ monitorJSON.* }}` / `{{ heartbeatJSON.* }}`                   | Uptime Kuma names for `monitor` / `heartbeat`                      |

`monitor` and `heartbeat` are empty for messages without them (maintenance windows; test sends), and
`heartbeat` is empty for certificate and domain expiry warnings. `heartbeat.localDateTime` and the `date`
filter use the organization's time zone and language (`organizations.settings`).

### Tags and filters

Tags: `if`/`elsif`/`else`/`unless`, `case`/`when`, `for` (with `break`, `continue`, `cycle`, `tablerow`),
`assign`, `capture`, `increment`/`decrement`, `echo`, `liquid`, `raw` and comments. There is no `include`,
`render` or `layout`: templates cannot load other templates or files.

Filters (anything else is an error): text — `append`, `prepend`, `capitalize`, `downcase`, `upcase`,
`strip`, `lstrip`, `rstrip`, `strip_newlines`, `strip_html`, `newline_to_br`, `replace`, `replace_first`,
`replace_last`, `remove`, `remove_first`, `remove_last`, `truncate`, `truncatewords`, `split`, `slice`,
`size`, `default`, `escape`, `escape_once`, `url_encode`, `url_decode`, `normalize_whitespace`, `raw`;
lists — `join`, `first`, `last`, `map`, `where`, `reject`, `sort`, `sort_natural`, `uniq`, `compact`,
`reverse`, `concat`, `sum`; numbers — `abs`, `at_least`, `at_most`, `ceil`, `floor`, `round`, `plus`,
`minus`, `times`, `divided_by`, `modulo`; data — `date` (strftime format, optional time zone),
`json`/`jsonify` (JSON-encode, for webhook bodies: `{"text": {{ msg | json }}}`) and Marmot's `duration`
(seconds to words in the organization's language: `{{ downtimeSeconds | duration }}`).

### Sandbox and errors

- Templates only see the variables above (own properties of plain data): no `process`, environment
  variables, prototypes or files.
- Limits: 20 000 characters per template, 200 ms render time, an allocation budget for loops and string
  building, and 100 000 characters of output.
- **On save** (and on **Send test** with unsaved settings) every template is parsed and its variables are
  checked; problems come back as field errors (`config.template: Template error: …`). Imports report such
  channels as skipped.
- **On send**, a template that still fails (a limit, a filter error, a channel saved before a rule
  existed) is logged (`notifications:template`) and the default message is sent instead, so an alert is
  never lost to a template.

### HTML email

The email providers (`smtp`, `sendgrid`, `resend`) send a branded, responsive HTML email with a plain-text
part by default: the organization logo (or name), the status in its colour, the monitor, the message, the
time, the downtime of a recovery, the address and a **View monitor** button
(`monitor.dashboardUrl`, built from `NEXT_PUBLIC_SERVER_URL`).

Custom HTML: SMTP's _body_ with **Send the body as HTML**, or the _HTML template_ of SendGrid and Resend.
HTML templates escape every value automatically (`{{ heartbeat.msg }}` cannot inject markup; `| raw` opts
out, `| escape` does not escape twice), and the text part is generated from the HTML (links keep their
address). SMTP's _body_ without **Send the body as HTML** sends a plain-text email only. Subjects are
templates for all three providers.

### Preview

The channel form's **Preview** renders the default message, every template and, for email providers, the
email itself (HTML in a sandboxed frame, plus the text part) against sample data of the chosen event, in the
organization's language. Nothing is sent. API: `POST /api/orgs/:orgId/notifications/preview` with
`{ "type", "config", "event" }` (or `{ "notificationId", "event" }` for a saved channel; the config does not
have to be complete) answers `{ event, message, fields: [{ name, mode, output, error }], email }`. Requires
`notification:read`.

## Providers

Providers live in `src/server/notification-providers/<name>.ts`, register themselves with
`registerNotificationProvider()` and export a zod `configSchema` + `fieldMeta` that drive both validation and
the dynamic form. Most are ports of Uptime Kuma's providers (see `THIRD_PARTY_NOTICES.md`).

| `type`     | Group   | Config keys (required in **bold**)                                                                                                                                                                                                |
| ---------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord`  | Chat    | **webhookUrl**, username, prefixMessage, messageFormat `normal\|minimalist\|custom`, messageTemplate _(template)_, channelType `channel\|createNewForumPost\|postToThread`, threadId, postName, suppressNotifications, disableUrl |
| `slack`    | Chat    | **webhookUrl**, channel, username, iconEmoji, richMessage (default true), channelNotify, useTemplate, template _(template)_                                                                                                       |
| `telegram` | Chat    | **botToken**, **chatId**, messageThreadId, serverUrl (default `https://api.telegram.org`), sendSilently, protectContent, useTemplate, template _(template)_, templateParseMode `plain\|HTML\|MarkdownV2`                          |
| `teams`    | Chat    | **webhookUrl** (Power Automate / incoming webhook; sends an Adaptive Card)                                                                                                                                                        |
| `matrix`   | Chat    | **homeserverUrl**, **internalRoomId**, **accessToken**, useTemplate, template _(template)_                                                                                                                                        |
| `ntfy`     | Push    | serverUrl (default `https://ntfy.sh`), **topic**, priority 1–5 (default 4; DOWN uses priority+1), priorityDown, authMethod `none\|usernamePassword\|accessToken`, username, password, accessToken, icon                           |
| `gotify`   | Push    | **serverUrl**, **appToken**, priority 0–10 (default 8)                                                                                                                                                                            |
| `pushover` | Push    | **userKey**, **appToken**, device, title, priority `-2…2`, sound, soundUp, ttl                                                                                                                                                    |
| `smtp`     | Email   | useServerSmtp (reuse `SMTP_*` env), host, port (587), secure, ignoreTlsErrors, user, pass, from, **to**, cc, bcc, subject _(template)_, body _(template)_, htmlBody                                                               |
| `webhook`  | Generic | **url**, method `POST\|GET\|PUT\|PATCH`, contentType `json\|form-data\|custom`, customBody _(template)_, additionalHeaders (JSON object). JSON/form bodies are `{ heartbeat, monitor, msg }`; GET sends them as query parameters  |

Second wave (all ports of Uptime Kuma 2.5.5 providers; "Generic" also covers incident-management and SMS
services):

| `type`           | Group   | Config keys (required in **bold**)                                                                                                                                                                     |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mattermost`     | Chat    | **webhookUrl**, username, channel, iconUrl, iconEmoji (`:up: :down:` = one emoji per status)                                                                                                           |
| `rocket-chat`    | Chat    | **webhookUrl**, channel, username, iconEmoji                                                                                                                                                           |
| `google-chat`    | Chat    | **webhookUrl**, maxRetries 1–10 (retries on HTTP 429), useTemplate, template _(template)_                                                                                                              |
| `signal`         | Chat    | **apiUrl** (signal-cli-rest-api `/v2/send`), **number**, **recipients** (comma-separated), useTemplate, template _(template)_                                                                          |
| `line-messaging` | Chat    | **channelAccessToken**, **userId**                                                                                                                                                                     |
| `pumble`         | Chat    | **webhookUrl**                                                                                                                                                                                         |
| `zoho-cliq`      | Chat    | **webhookUrl**                                                                                                                                                                                         |
| `nextcloud-talk` | Chat    | **host**, **conversationToken**, **botSecret** (HMAC-signed bot message), sendSilentUp, sendSilentDown                                                                                                 |
| `onebot`         | Chat    | **httpAddr**, **accessToken**, msgType `group\|private`, **receiverId**                                                                                                                                |
| `wecom`          | Chat    | **botKey**, mentionedMobileList (comma-separated, `@all`)                                                                                                                                              |
| `dingding`       | Chat    | **webhookUrl**, **secretKey** (signed requests), mentioning `nobody\|everyone\|specify-mobiles\|specify-users`, mobileList, userList                                                                   |
| `feishu`         | Chat    | **webhookUrl** (interactive card)                                                                                                                                                                      |
| `bitrix24`       | Chat    | **webhookUrl** (inbound webhook with `im` scope), **userId**                                                                                                                                           |
| `bark`           | Push    | **endpoint** (incl. device key), apiVersion `v1\|v2`, group (default `Marmot`), sound (default `telegraph`)                                                                                            |
| `pushdeer`       | Push    | serverUrl (default `https://api2.pushdeer.com`), **pushKey**                                                                                                                                           |
| `serverchan`     | Push    | **sendKey** (`sctp…` keys route through ft07.com)                                                                                                                                                      |
| `pushbullet`     | Push    | **accessToken**                                                                                                                                                                                        |
| `webpush`        | Push    | **subscription** (PushSubscription JSON), **vapidPublicKey**, **vapidPrivateKey**, **vapidSubject** (`mailto:`), title. Generate keys with `npx web-push generate-vapid-keys`                          |
| `techulus-push`  | Push    | **apiKey**, title, channel, sound, timeSensitive (default true)                                                                                                                                        |
| `pushy`          | Push    | **apiKey**, **deviceToken**                                                                                                                                                                            |
| `home-assistant` | Push    | **url**, **longLivedAccessToken**, notificationService (default `notify`)                                                                                                                              |
| `sendgrid`       | Email   | **apiKey**, **fromEmail**, **toEmail**, ccEmail, bccEmail, subject _(template)_, htmlTemplate _(template)_                                                                                             |
| `resend`         | Email   | **apiKey**, **fromEmail**, fromName, **toEmail**, subject _(template)_, htmlTemplate _(template)_                                                                                                      |
| `pagerduty`      | Generic | **integrationKey**, integrationUrl (Events API v2), priority `info\|warning\|error\|critical`, autoResolve `none\|acknowledge\|resolve` (UP events); dedup key `Marmot/<monitorId>`                    |
| `opsgenie`       | Generic | region `us\|eu`, **apiKey**, priority 1–5. DOWN creates an alert aliased by monitor name; UP closes it                                                                                                 |
| `splunk`         | Generic | **restUrl** (Splunk On-Call REST endpoint), severity `INFO\|WARNING\|CRITICAL`, autoResolve `none\|ACKNOWLEDGEMENT\|RECOVERY`                                                                          |
| `squadcast`      | Generic | **webhookUrl**; sends `trigger`/`resolve` with the heartbeat attached                                                                                                                                  |
| `alerta`         | Generic | **apiEndpoint**, **apiKey**, **environment**, alertState (default `critical`), recoverState (default `cleared`)                                                                                        |
| `grafana-oncall` | Generic | **webhookUrl** (formatted webhook); `alerting` on DOWN, `ok` on UP                                                                                                                                     |
| `heii-oncall`    | Generic | **apiKey**, **triggerId**; `alert` on DOWN, `resolve` on UP                                                                                                                                            |
| `twilio`         | Generic | **accountSid**, apiKey (SID, optional), **authToken**, **fromNumber**, **toNumber**, messagingServiceSid (SMS)                                                                                         |
| `clicksend`      | Generic | **login**, **password** (API key), **toNumber**, senderName (SMS; non-ASCII characters are stripped)                                                                                                   |
| `apprise`        | Generic | **appriseUrl**, title. Runs the `apprise` CLI on the worker host (`pip install apprise`); fails with a readable error when the binary is missing. Refused while `MONITOR_DENY_PRIVATE_ADDRESSES` is on |

Nostr is not ported: it needs `nostr-tools` plus a WebSocket polyfill, which outweighs its use.

### Email through the server SMTP settings

An `smtp` channel with **Use the server SMTP settings** (`useServerSmtp: true`) sends with the instance's
`SMTP_*` settings and `EMAIL_FROM` instead of its own server, so it carries the operator's sender domain.
Three limits apply:

- **Who:** `NOTIFICATIONS_SERVER_SMTP` (default `superadmin`). In `superadmin` mode only instance
  superadmins may create a channel with the option or switch a channel to it, and other users cannot change
  the settings of a channel that uses it (they may still rename, pause, delete it or turn the option off);
  everyone else gets a `403` from the REST API, the Local API (without `overrideAccess`) and the routes
  above, and the form disables the switch. Existing channels keep sending. `off` refuses the option for
  everyone, and existing channels that use it fail with an error in their **Last error** instead of falling
  back to the server. `all` lets anyone who manages channels use it.
- **How much:** `NOTIFICATIONS_SERVER_SMTP_RATE` messages per organization per hour (default `60`, `0` =
  unlimited), counted in Redis across every channel of the organization; **Send test** counts too. Over
  the limit a delivery is refused and recorded as the channel's **Last error** (not retried), and the test
  endpoint answers `429` with `Retry-After`. When Redis is unreachable the limit is not enforced and the
  worker logs one warning.
- **To whom:** at most 10 recipients per message (to, cc and bcc combined), checked on save and on send.

Channels with their own SMTP server are not affected by any of these.

### Adding a provider

1. Create `src/server/notification-providers/<name>.ts`: a zod `configSchema` (object of string / number /
   boolean / enum fields, optionally `.optional()` or `.default()`), a `fieldMeta` map (labels, placeholders,
   `secret: true` for tokens, `multiline: true` for templates, `options` for enum labels) and
   `registerNotificationProvider({ name, label, group, docsUrl, configSchema, fieldMeta, send })`.
2. Use `postJson` / `httpRequest` from `./http` so network errors carry the HTTP status and body, and so
   tests can stub `globalThis.fetch`.
3. Add one `import './<name>'` line to `src/server/notification-providers/index.ts`.
4. Port from Uptime Kuma? Add the attribution header and a line in `THIRD_PARTY_NOTICES.md`.
5. Add a payload test to `src/server/notification-providers/providers.test.ts`.
