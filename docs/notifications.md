# Notifications

Marmot alerts through **notification channels**: org-scoped documents in the `notifications` collection that
name a provider (`type`) and carry its settings (`config`). Monitors reference channels through their
`notifications` relationship; a channel flagged `isDefault` is attached to every monitor created afterwards, and
"Apply to all existing monitors" attaches it to the organization's current monitors. Members can see channels
(`notification:read`, secrets masked); admins and owners create, edit, test and delete them
(`notification:create|update|delete`).

## Pipeline

```
check worker ─▶ heartbeat (notify=true) ─▶ enqueueNotificationsForHeartbeat()
   ─▶ BullMQ queue `marmot:notifications`, one job per active attached channel
      job id `notif:<notificationId>:<heartbeatId>` (dedupes repeated events), 3 attempts, exponential backoff 5s
   ─▶ startNotificationWorker() ─▶ processNotificationJob() ─▶ sendNotification() ─▶ provider.send()
   ─▶ `notifications.lastSentAt` / `lastError` updated on the channel
```

The state machine decides when a beat notifies (`notify`): status transitions
(`isImportantForNotification`) plus the `resendInterval` tick while DOWN. The first beat only notifies when
it is DOWN. Everything runs in the worker process (`src/worker.ts`).

The default message is `[monitor name] [✅ Up|🔴 Down|⚠️ Pending|🔧 Maintenance] <heartbeat message>`.

### Testing a channel

`POST /api/orgs/:orgId/notifications/test` with `{ "notificationId": … }` (saved channel) or
`{ "type": "slack", "config": { … } }` (unsaved) sends a test message and answers `{ ok: true, result }` or
`400 { ok: false, error }`. Requires `notification:update`. The UI's **Send test** button uses it.

### Channel API

| Method | Path                                       | Permission            |
| ------ | ------------------------------------------ | --------------------- |
| GET    | `/api/orgs/:orgId/notifications`           | `notification:read`   |
| POST   | `/api/orgs/:orgId/notifications`           | `notification:create` |
| PATCH  | `/api/orgs/:orgId/notifications/:id`       | `notification:update` |
| DELETE | `/api/orgs/:orgId/notifications/:id`       | `notification:delete` |
| POST   | `/api/orgs/:orgId/notifications/test`      | `notification:update` |
| GET    | `/api/orgs/:orgId/notifications/providers` | `notification:read`   |

Body fields for POST/PATCH: `name`, `type`, `config`, `isDefault`, `applyExisting` (virtual, one-shot),
`active`. `config` is validated against the provider's schema; errors come back as `config.<key>: message`.

## Templates

Fields marked _template_ below accept `{{ variable }}` placeholders. The renderer only substitutes
dotted paths from the list below — no expressions, filters or code.

| Variable                                                          | Example                          |
| ----------------------------------------------------------------- | -------------------------------- |
| `{{ msg }}`                                                       | `[API] [🔴 Down] HTTP 503`       |
| `{{ status }}`                                                    | `🔴 Down`                        |
| `{{ name }}`                                                      | `API`                            |
| `{{ hostnameOrURL }}`                                             | `https://api.example.com/health` |
| `{{ monitor.id/name/type/url/hostname/port/description }}`        |                                  |
| `{{ heartbeat.status/msg/ping/time/duration/retries/downCount }}` | `heartbeat.status` → `down`      |

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

| `type`           | Group   | Config keys (required in **bold**)                                                                                                                                                  |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mattermost`     | Chat    | **webhookUrl**, username, channel, iconUrl, iconEmoji (`:up: :down:` = one emoji per status)                                                                                        |
| `rocket-chat`    | Chat    | **webhookUrl**, channel, username, iconEmoji                                                                                                                                        |
| `google-chat`    | Chat    | **webhookUrl**, maxRetries 1–10 (retries on HTTP 429), useTemplate, template _(template)_                                                                                           |
| `signal`         | Chat    | **apiUrl** (signal-cli-rest-api `/v2/send`), **number**, **recipients** (comma-separated), useTemplate, template _(template)_                                                       |
| `line-messaging` | Chat    | **channelAccessToken**, **userId**                                                                                                                                                  |
| `pumble`         | Chat    | **webhookUrl**                                                                                                                                                                      |
| `zoho-cliq`      | Chat    | **webhookUrl**                                                                                                                                                                      |
| `nextcloud-talk` | Chat    | **host**, **conversationToken**, **botSecret** (HMAC-signed bot message), sendSilentUp, sendSilentDown                                                                              |
| `onebot`         | Chat    | **httpAddr**, **accessToken**, msgType `group\|private`, **receiverId**                                                                                                             |
| `wecom`          | Chat    | **botKey**, mentionedMobileList (comma-separated, `@all`)                                                                                                                           |
| `dingding`       | Chat    | **webhookUrl**, **secretKey** (signed requests), mentioning `nobody\|everyone\|specify-mobiles\|specify-users`, mobileList, userList                                                |
| `feishu`         | Chat    | **webhookUrl** (interactive card)                                                                                                                                                   |
| `bitrix24`       | Chat    | **webhookUrl** (inbound webhook with `im` scope), **userId**                                                                                                                        |
| `bark`           | Push    | **endpoint** (incl. device key), apiVersion `v1\|v2`, group (default `Marmot`), sound (default `telegraph`)                                                                         |
| `pushdeer`       | Push    | serverUrl (default `https://api2.pushdeer.com`), **pushKey**                                                                                                                        |
| `serverchan`     | Push    | **sendKey** (`sctp…` keys route through ft07.com)                                                                                                                                   |
| `pushbullet`     | Push    | **accessToken**                                                                                                                                                                     |
| `webpush`        | Push    | **subscription** (PushSubscription JSON), **vapidPublicKey**, **vapidPrivateKey**, **vapidSubject** (`mailto:`), title. Generate keys with `npx web-push generate-vapid-keys`       |
| `techulus-push`  | Push    | **apiKey**, title, channel, sound, timeSensitive (default true)                                                                                                                     |
| `pushy`          | Push    | **apiKey**, **deviceToken**                                                                                                                                                         |
| `home-assistant` | Push    | **url**, **longLivedAccessToken**, notificationService (default `notify`)                                                                                                           |
| `sendgrid`       | Email   | **apiKey**, **fromEmail**, **toEmail**, ccEmail, bccEmail, subject                                                                                                                  |
| `resend`         | Email   | **apiKey**, **fromEmail**, fromName, **toEmail**, subject                                                                                                                           |
| `pagerduty`      | Generic | **integrationKey**, integrationUrl (Events API v2), priority `info\|warning\|error\|critical`, autoResolve `none\|acknowledge\|resolve` (UP events); dedup key `Marmot/<monitorId>` |
| `opsgenie`       | Generic | region `us\|eu`, **apiKey**, priority 1–5. DOWN creates an alert aliased by monitor name; UP closes it                                                                              |
| `splunk`         | Generic | **restUrl** (Splunk On-Call REST endpoint), severity `INFO\|WARNING\|CRITICAL`, autoResolve `none\|ACKNOWLEDGEMENT\|RECOVERY`                                                       |
| `squadcast`      | Generic | **webhookUrl**; sends `trigger`/`resolve` with the heartbeat attached                                                                                                               |
| `alerta`         | Generic | **apiEndpoint**, **apiKey**, **environment**, alertState (default `critical`), recoverState (default `cleared`)                                                                     |
| `grafana-oncall` | Generic | **webhookUrl** (formatted webhook); `alerting` on DOWN, `ok` on UP                                                                                                                  |
| `heii-oncall`    | Generic | **apiKey**, **triggerId**; `alert` on DOWN, `resolve` on UP                                                                                                                         |
| `twilio`         | Generic | **accountSid**, apiKey (SID, optional), **authToken**, **fromNumber**, **toNumber**, messagingServiceSid (SMS)                                                                      |
| `clicksend`      | Generic | **login**, **password** (API key), **toNumber**, senderName (SMS; non-ASCII characters are stripped)                                                                                |
| `apprise`        | Generic | **appriseUrl**, title. Runs the `apprise` CLI on the worker host (`pip install apprise`); fails with a readable error when the binary is missing                                    |

Nostr is not ported: it needs `nostr-tools` plus a WebSocket polyfill, which outweighs its use.

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
